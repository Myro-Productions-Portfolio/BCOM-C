# BCOM-C Metrics Daemon

Python daemon that serves `GET /api/metrics` for the BCOM-C dashboard.

Runs on the DGX Spark. Collects local telemetry and optionally polls a
remote Linux host via SSH for the LINUX-DSKTP panel.

---

## Requirements

- Python 3.10+
- `psutil` (system package or pip)
- `nvidia-smi` in PATH (DGX Spark: already present)
- SSH key auth to remote host (if using `--linux-host`)

---

## Quick Start

```bash
# Spark panel only
./start.sh

# Spark + Linux desktop
./start.sh --linux-host <ssh-alias>     # e.g. windows-pc

# Custom port
./start.sh --port 9000
```

Then in `index.html`, uncomment and set:
```js
BCOM.apiBase = 'http://<dgx-ip>:8090';
```

---

## API

**`GET /api/metrics`**

```json
{
  "spark": {
    "cpu_pct":  6.9,
    "gpu_pct":  2,
    "vram_pct": 0.1,
    "vram_gb":  "0.2 GB",
    "gpu_temp": "49°C",
    "cpu_temp": 61.7,
    "uptime":   "0d 15h"
  },
  "linux": {
    "cpu_pct":  42.0,
    "gpu_pct":  0,
    "cpu_temp": 58.0,
    "ram_gb":   "12.4 GB",
    "uptime":   "3d 2h"
  }
}
```

`linux` key is omitted if `--linux-host` is not set. Missing keys render
as `--` in the dashboard without errors.

---

## DGX Spark Notes

The GB10 Grace Blackwell uses unified memory — `nvidia-smi` reports VRAM
as `[N/A]` system-wide. The daemon works around this by summing per-process
GPU allocations (`nvidia-smi --query-compute-apps`) against the 128 GB pool.

CPU temperature uses `acpitz` sensors (max across all zones).

---

## Production (run as a service)

```bash
nohup ./start.sh > ~/logs/bcom-metrics.log 2>&1 &
echo $! > ~/logs/bcom-metrics.pid
```

Or drop a systemd unit:

```ini
[Unit]
Description=BCOM-C Metrics Daemon
After=network.target

[Service]
ExecStart=/home/nmyers/Projects/BCOM-C/daemon/start.sh
Restart=always
User=nmyers

[Install]
WantedBy=multi-user.target
```
