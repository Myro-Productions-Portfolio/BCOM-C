/* ═══════════════════════════════════════════════════════
   BCOM-C DASHBOARD  —  Shared JavaScript
   Project: Bob-AI Pipeline / Data Jet
   ═══════════════════════════════════════════════════════ */

/* ── Global config ──────────────────────────────────────
   Set BCOM.apiBase to your server root when deploying.
   Leave empty to run in standby mode (no polling).
   ──────────────────────────────────────────────────── */
const BCOM = {
  apiBase:      '',       // e.g. 'http://192.168.1.50:8080' — set on deployment
  pollInterval: 5000,     // ms between data refreshes
  _timer:       null,
  _connected:   false,
  _lastErr:     null
};

/* ── Clock / Date ─────────────────────────────────────── */
function updateClock() {
  const now = new Date();
  const t   = now.toTimeString().split(' ')[0];
  const d   = now.getFullYear() + '/' +
    String(now.getMonth() + 1).padStart(2, '0') + '/' +
    String(now.getDate()).padStart(2, '0');

  const clockEl  = document.getElementById('clock');
  const dateEl   = document.getElementById('datestamp');
  const footerEl = document.getElementById('footer-date');

  if (clockEl)  clockEl.textContent  = t;
  if (dateEl)   dateEl.textContent   = d;
  if (footerEl) footerEl.textContent = d.replace(/\//g, '-');
}

setInterval(updateClock, 1000);
updateClock();

/* ── Log utility ─────────────────────────────────────── */
function logLine(msg, type = 'info') {
  const log = document.getElementById('log');
  if (!log) return;
  const t    = new Date().toTimeString().split(' ')[0];
  const line = document.createElement('div');
  line.className = 'log-line';
  line.innerHTML =
    `<span class="log-time">${t}</span>` +
    `<span class="log-msg ${type}">${msg}</span>`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

/* ── DOM text helper ─────────────────────────────────── */
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

/* ── Gauge ───────────────────────────────────────────── */
function setGauge(fillId, needleId, valId, pct) {
  const circumference = 2 * Math.PI * 50;
  const offset = circumference - (pct / 100) * circumference;
  const fill   = document.getElementById(fillId);
  const needle = document.getElementById(needleId);
  const val    = document.getElementById(valId);

  if (fill)   fill.style.strokeDashoffset = offset;
  if (needle) needle.style.transform =
    `translateX(-50%) translateY(-100%) rotate(${(pct / 100) * 270 - 135}deg)`;
  if (val)    val.textContent = Math.round(pct) + '%';
}

/* ── Temperature Bar ─────────────────────────────────── */
// safeMax / warnMax in °C; displayMax = scale ceiling
function setTempBar(barId, valId, temp, safeMax, warnMax, displayMax) {
  const pct = Math.min(100, (temp / displayMax) * 100);
  const bar = document.getElementById(barId);
  const val = document.getElementById(valId);

  let color = '#2ecc71';
  if (temp >= warnMax) color = '#e74c3c';
  else if (temp >= safeMax) color = '#f39c12';

  if (bar) {
    bar.style.width      = pct + '%';
    bar.style.background = color;
    bar.style.boxShadow  = `0 0 6px ${color}`;
  }
  if (val) {
    val.textContent = Math.round(temp) + '°C';
    val.style.color = color;
  }
}

/* ── Fluctuation helper (keep for testing) ───────────── */
function fluctuate(val, min, max, drift = 3) {
  return Math.min(max, Math.max(min, val + (Math.random() - 0.5) * drift));
}

/* ── Action log ──────────────────────────────────────── */
function triggerAction(name) {
  const type = name.startsWith('RESTART') ? 'warn' : 'info';
  logLine(`CMD: ${name} — initiated by operator`, type);
}

/* ── Dashboard renderer ──────────────────────────────────────────────────
   Expects API response shape:
   {
     spark: {
       cpu_pct:  0–100,
       gpu_pct:  0–100,
       vram_pct: 0–100,
       vram_gb:  "44.2 GB",
       gpu_temp: "72°C",
       cpu_temp: 78,         ← °C numeric
       uptime:   "2d 14h"
     },
     linux: {
       cpu_pct:  0–100,
       gpu_pct:  0–100,
       cpu_temp: 65,
       ram_gb:   "28.1 GB",
       uptime:   "5d 3h"
     }
   }
   Missing keys are shown as '--'. No keys = panel stays at 0 / --.
   ─────────────────────────────────────────────────────────────────────── */
function applyDashboard(data) {
  const s = data.spark || {};
  const l = data.linux  || {};

  // SPARK-BOB
  setGauge('gf-spark-cpu',  'gn-spark-cpu',  'gv-spark-cpu',  s.cpu_pct  ?? 0);
  setGauge('gf-spark-gpu',  'gn-spark-gpu',  'gv-spark-gpu',  s.gpu_pct  ?? 0);
  setGauge('gf-spark-vram', 'gn-spark-vram', 'gv-spark-vram', s.vram_pct ?? 0);
  setTempBar('spark-cpu-temp-bar', 'spark-cpu-temp-val',
    s.cpu_temp ?? 0, 70, 90, 110);
  setText('vram-spark-gb',  s.vram_gb  ?? '--');
  setText('gpu-temp-spark', s.gpu_temp ?? '--');
  setText('uptime-spark',   s.uptime   ?? '--');

  // LINUX-DSKTP
  setGauge('gf-linux-cpu', 'gn-linux-cpu', 'gv-linux-cpu', l.cpu_pct ?? 0);
  setGauge('gf-linux-gpu', 'gn-linux-gpu', 'gv-linux-gpu', l.gpu_pct ?? 0);
  setTempBar('linux-cpu-temp-bar', 'linux-cpu-temp-val',
    l.cpu_temp ?? 0, 70, 85, 100);
  setText('ram-linux-gb',  l.ram_gb  ?? '--');
  setText('uptime-linux',  l.uptime  ?? '--');
}

/* ── Polling engine ──────────────────────────────────────────────────────
   Fetches /api/metrics from BCOM.apiBase on each tick.
   - Silently skips if apiBase is not set (standby mode).
   - Logs connection/error transitions only once (no spam).
   - Works across hot-reloads: startPolling() resets the timer.
   ─────────────────────────────────────────────────────────────────────── */
async function pollDashboard() {
  if (!BCOM.apiBase) return;  // No API configured — skip silently

  try {
    const res  = await fetch(BCOM.apiBase + '/api/metrics', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Log connection event only on state change
    if (!BCOM._connected) {
      logLine('Data source connected. Live telemetry active.', 'info');
      BCOM._connected = true;
      BCOM._lastErr   = null;
    }
    applyDashboard(data);

  } catch (err) {
    // Suppress duplicate error logs
    const msg = 'Poll error: ' + err.message;
    if (BCOM._lastErr !== msg) {
      logLine(msg, 'warn');
      BCOM._lastErr   = msg;
      BCOM._connected = false;
    }
  }
}

/* ── Start / stop polling ────────────────────────────────────────────────
   Call startPolling() in index.html after setting BCOM.apiBase.
   Restarting is safe — clears any existing timer first.
   ─────────────────────────────────────────────────────────────────────── */
function startPolling(intervalMs) {
  if (BCOM._timer) clearInterval(BCOM._timer);
  BCOM.pollInterval = intervalMs ?? BCOM.pollInterval;
  pollDashboard();                                        // immediate first call
  BCOM._timer = setInterval(pollDashboard, BCOM.pollInterval);
}

function stopPolling() {
  if (BCOM._timer) { clearInterval(BCOM._timer); BCOM._timer = null; }
}
