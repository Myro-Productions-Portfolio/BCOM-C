#!/usr/bin/env python3
"""
BCOM-C Metrics Daemon
Serves GET /api/metrics for the Bob-AI Command & Control dashboard.

Collects local DGX Spark (SPARK-BOB) telemetry and optionally polls a
remote Linux host (LINUX-DSKTP) via SSH.

Usage:
    python3 metrics_daemon.py [--port 8090] [--linux-host <ssh-alias>]

Dashboard connection:
    Set BCOM.apiBase = 'http://<dgx-ip>:8090' in index.html.
"""

import json
import subprocess
import time
import argparse
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler

import psutil

# ── Configuration ────────────────────────────────────────────────────────────

PORT        = 8090           # HTTP port to listen on
LINUX_HOST  = None           # SSH alias for LINUX-DSKTP (e.g. "windows-pc")
                             # Set to None to skip remote collection
GB10_VRAM_TOTAL_MiB = 128 * 1024  # GB10 unified memory ceiling (128 GB)

# ── Spark metrics (local) ────────────────────────────────────────────────────

def _cpu_temp_c() -> float:
    """Return CPU temp from acpitz sensors (max across all zones), or 0."""
    try:
        temps = psutil.sensors_temperatures()
        zones = temps.get("acpitz", [])
        if zones:
            return round(max(z.current for z in zones), 1)
    except Exception:
        pass
    return 0.0


def _gpu_stats() -> dict:
    """
    Query nvidia-smi for GPU utilisation and temperature.
    Returns gpu_pct, vram_pct, vram_gb, gpu_temp — all with safe fallbacks.

    GB10 note: FB memory (VRAM) is unified and always [N/A] via the standard
    memory.used/total query. We sum per-process GPU memory as the used figure
    and use the known 128 GB pool as the denominator.
    """
    result = {"gpu_pct": 0, "vram_pct": 0, "vram_gb": "--", "gpu_temp": "--"}

    # GPU utilisation + temperature
    try:
        out = subprocess.run(
            ["nvidia-smi",
             "--query-gpu=utilization.gpu,temperature.gpu",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5
        )
        if out.returncode == 0:
            parts = [p.strip() for p in out.stdout.strip().split(",")]
            if parts[0] not in ("", "[N/A]", "N/A"):
                result["gpu_pct"] = int(parts[0])
            if len(parts) > 1 and parts[1] not in ("", "[N/A]", "N/A"):
                result["gpu_temp"] = f"{parts[1]}°C"
    except Exception:
        pass

    # VRAM: sum per-process GPU allocations (GB10 unified memory workaround)
    try:
        out = subprocess.run(
            ["nvidia-smi",
             "--query-compute-apps=used_gpu_memory",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5
        )
        if out.returncode == 0:
            lines = [l.strip() for l in out.stdout.strip().splitlines() if l.strip()]
            used_mib = sum(
                int(l) for l in lines
                if l not in ("[N/A]", "N/A", "")
            )
            if used_mib > 0:
                pct = round((used_mib / GB10_VRAM_TOTAL_MiB) * 100, 1)
                result["vram_pct"] = pct
                result["vram_gb"] = f"{used_mib / 1024:.1f} GB"
    except Exception:
        pass

    return result


def _uptime_str(seconds: float) -> str:
    days  = int(seconds // 86400)
    hours = int((seconds % 86400) // 3600)
    return f"{days}d {hours}h"


def collect_spark() -> dict:
    """Collect all SPARK-BOB metrics from the local DGX Spark."""
    cpu_pct  = psutil.cpu_percent(interval=0.5)
    uptime_s = time.time() - psutil.boot_time()
    gpu      = _gpu_stats()

    return {
        "cpu_pct":  round(cpu_pct, 1),
        "gpu_pct":  gpu["gpu_pct"],
        "vram_pct": gpu["vram_pct"],
        "vram_gb":  gpu["vram_gb"],
        "gpu_temp": gpu["gpu_temp"],
        "cpu_temp": _cpu_temp_c(),
        "uptime":   _uptime_str(uptime_s),
    }


# ── Linux desktop metrics (remote via SSH) ───────────────────────────────────

# One-liner executed on the remote host via SSH.
# Requires python3 + psutil on the remote machine.
_REMOTE_SCRIPT = (
    "python3 -c \""
    "import psutil,json,time,subprocess;"
    "cpu=psutil.cpu_percent(interval=0.5);"
    "mem=psutil.virtual_memory();"
    "up=time.time()-psutil.boot_time();"
    "d=int(up//86400);h=int((up%86400)//3600);"
    "temps=psutil.sensors_temperatures();"
    "cpu_t=max((z.current for z in temps.get('coretemp',temps.get('k10temp',temps.get('acpitz',[])))),"
    "default=0);"
    "gpu=0;"
    "r=subprocess.run(['nvidia-smi','--query-gpu=utilization.gpu','--format=csv,noheader,nounits'],"
    "capture_output=True,text=True,timeout=5);"
    "gpu=int(r.stdout.strip()) if r.returncode==0 and r.stdout.strip() not in ('','[N/A]','N/A') else 0;"
    "print(json.dumps({'cpu_pct':round(cpu,1),'gpu_pct':gpu,"
    "'cpu_temp':round(cpu_t,1),'ram_gb':f'{mem.used/1e9:.1f} GB',"
    "'uptime':f'{d}d {h}h'}))\""
)


def collect_linux(host: str) -> dict | None:
    """
    SSH to the Linux desktop and run a one-liner to collect metrics.
    Returns None if SSH fails (dashboard shows '--' for all fields).
    """
    try:
        out = subprocess.run(
            ["ssh", "-o", "ConnectTimeout=3", "-o", "BatchMode=yes", host,
             _REMOTE_SCRIPT],
            capture_output=True, text=True, timeout=8
        )
        if out.returncode == 0:
            return json.loads(out.stdout.strip())
    except Exception:
        pass
    return None


# ── Metrics cache (avoids blocking HTTP requests) ────────────────────────────

_cache: dict = {}
_cache_lock = threading.Lock()


def _refresh_cache(linux_host: str | None) -> None:
    spark = collect_spark()
    linux = collect_linux(linux_host) if linux_host else None
    payload = {"spark": spark}
    if linux is not None:
        payload["linux"] = linux
    with _cache_lock:
        _cache.update(payload)
        _cache["_ts"] = time.time()


def _poll_loop(linux_host: str | None, interval: int = 5) -> None:
    while True:
        try:
            _refresh_cache(linux_host)
        except Exception:
            pass
        time.sleep(interval)


# ── HTTP handler ──────────────────────────────────────────────────────────────

class MetricsHandler(BaseHTTPRequestHandler):

    def do_GET(self):
        if self.path != "/api/metrics":
            self.send_response(404)
            self.end_headers()
            return

        with _cache_lock:
            payload = {k: v for k, v in _cache.items() if not k.startswith("_")}

        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.end_headers()

    def log_message(self, fmt, *args):
        pass  # suppress per-request access logs


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="BCOM-C Metrics Daemon")
    parser.add_argument("--port",       type=int, default=PORT)
    parser.add_argument("--linux-host", type=str, default=LINUX_HOST,
                        help="SSH alias for LINUX-DSKTP node (optional)")
    args = parser.parse_args()

    print(f"BCOM-C Metrics Daemon starting on port {args.port}")
    print(f"  DGX Spark: local collection")
    if args.linux_host:
        print(f"  Linux desktop: SSH → {args.linux_host}")
    else:
        print("  Linux desktop: not configured (linux panel will show --)")

    # Populate cache before first HTTP request
    _refresh_cache(args.linux_host)

    # Background polling thread
    t = threading.Thread(target=_poll_loop, args=(args.linux_host,), daemon=True)
    t.start()

    server = HTTPServer(("0.0.0.0", args.port), MetricsHandler)
    print(f"  Listening: http://0.0.0.0:{args.port}/api/metrics")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nDaemon stopped.")


if __name__ == "__main__":
    main()
