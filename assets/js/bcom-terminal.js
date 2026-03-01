/**
 * bcom-terminal.js
 * Shared terminal logic for all BCOM-C pages.
 *
 * Features:
 *   - Persistent collapsed/expanded state via localStorage ('bcom-term-min')
 *   - Real xterm.js terminal connected to DGX WebSocket PTY (/api/terminal/ws)
 *   - SHELL tab triggers WebSocket connection lazily on first open
 *   - Wraps page's switchTerm() to hide/show xterm-container + input-row correctly
 */

(function () {
  'use strict';

  const STORAGE_KEY  = 'bcom-term-min';   // '1' = minimized, '0' = expanded
  const XTERM_VERSION = '5.3.0';
  const FIT_VERSION   = '0.9.0';

  // ── Helpers ─────────────────────────────────────────────────────────────
  function _apiBase() {
    try {
      const s = JSON.parse(localStorage.getItem('bcom-settings') || '{}');
      return s['api-base-url'] || 'http://10.0.0.69:9010';
    } catch (_) { return 'http://10.0.0.69:9010'; }
  }

  function _wsBase() {
    return _apiBase().replace(/^http/, 'ws');
  }

  function _setMinimized(min) {
    const dock = document.getElementById('terminal-dock');
    const body = document.getElementById('terminal-body');
    const btn  = document.getElementById('term-minimize');
    if (!dock) return;
    dock.classList.toggle('minimized', min);
    if (body) body.style.display = min ? 'none' : '';
    if (btn)  btn.textContent    = min ? '▲' : '_';
    document.body.style.paddingBottom = min ? '34px' : '220px';
    localStorage.setItem(STORAGE_KEY, min ? '1' : '0');
  }

  // ── State restore (runs immediately on DOMContentLoaded or now) ──────────
  function restoreState() {
    const min = localStorage.getItem(STORAGE_KEY) === '1';
    _setMinimized(min);
  }

  // ── Minimize button ──────────────────────────────────────────────────────
  function wireMinimizeBtn() {
    const btn = document.getElementById('term-minimize');
    if (!btn) return;
    // Remove any existing click listeners by cloning
    const fresh = btn.cloneNode(true);
    btn.parentNode.replaceChild(fresh, btn);
    fresh.addEventListener('click', () => {
      const dock = document.getElementById('terminal-dock');
      const isMin = dock.classList.contains('minimized');
      _setMinimized(!isMin);
    });
  }

  // ── xterm.js lazy loader ─────────────────────────────────────────────────
  let _xtermLoaded    = false;
  let _xtermLoading   = false;
  let _xtermCallbacks = [];

  function _loadXterm(cb) {
    if (_xtermLoaded) { cb(); return; }
    _xtermCallbacks.push(cb);
    if (_xtermLoading) return;
    _xtermLoading = true;

    // CSS
    const css = document.createElement('link');
    css.rel  = 'stylesheet';
    css.href = `https://cdnjs.cloudflare.com/ajax/libs/xterm/${XTERM_VERSION}/xterm.min.css`;
    document.head.appendChild(css);

    // Core xterm.js
    const s1 = document.createElement('script');
    s1.src = `https://cdnjs.cloudflare.com/ajax/libs/xterm/${XTERM_VERSION}/xterm.min.js`;
    s1.onload = () => {
      // Fit addon
      const s2 = document.createElement('script');
      s2.src = `https://cdn.jsdelivr.net/npm/@xterm/addon-fit@${FIT_VERSION}/lib/addon-fit.min.js`;
      s2.onload = () => {
        _xtermLoaded  = true;
        _xtermLoading = false;
        _xtermCallbacks.forEach(fn => fn());
        _xtermCallbacks = [];
      };
      s2.onerror = () => {
        // Fit addon optional — still proceed without it
        _xtermLoaded  = true;
        _xtermLoading = false;
        _xtermCallbacks.forEach(fn => fn());
        _xtermCallbacks = [];
      };
      document.head.appendChild(s2);
    };
    document.head.appendChild(s1);
  }

  // ── Terminal instance ────────────────────────────────────────────────────
  let _term      = null;
  let _fitAddon  = null;
  let _ws        = null;

  function _inputRow() {
    return document.querySelector('.terminal-input-row');
  }

  function _initXterm() {
    const container = document.getElementById('xterm-container');
    if (!container || _term) return;

    _term = new window.Terminal({
      theme: {
        background:  '#080808',
        foreground:  '#e0e0e0',
        cursor:      '#e87d2b',
        black:       '#1a1a1a',
        red:         '#e74c3c',
        green:       '#2ecc71',
        yellow:      '#f39c12',
        blue:        '#3498db',
        magenta:     '#9b59b6',
        cyan:        '#7fb3cc',
        white:       '#e0e0e0',
        brightBlack: '#555555',
      },
      fontFamily: '"Courier New", Courier, monospace',
      fontSize:   13,
      cursorBlink: true,
      allowTransparency: false,
      scrollback: 5000,
    });

    if (window.FitAddon) {
      _fitAddon = new window.FitAddon.FitAddon();
      _term.loadAddon(_fitAddon);
    }

    _term.open(container);
    if (_fitAddon) _fitAddon.fit();

    // Connect WebSocket
    _connectWS();

    // Forward keyboard input → WS (binary frame)
    _term.onData(data => {
      if (_ws && _ws.readyState === WebSocket.OPEN) {
        _ws.send(new TextEncoder().encode(data));
      }
    });

    // Resize observer → PTY resize message
    const ro = new ResizeObserver(() => {
      if (_fitAddon) {
        _fitAddon.fit();
        _sendResize();
      }
    });
    ro.observe(container);
  }

  function _connectWS() {
    if (_ws && (_ws.readyState === WebSocket.CONNECTING || _ws.readyState === WebSocket.OPEN)) return;

    const url = _wsBase() + '/api/terminal/ws';
    _ws = new WebSocket(url);
    _ws.binaryType = 'arraybuffer';

    _ws.onopen = () => {
      _term.write('\x1b[32mConnected to DGX Spark (nmyers)\x1b[0m\r\n');
      _sendResize();
    };

    _ws.onmessage = (e) => {
      if (!_term) return;
      if (e.data instanceof ArrayBuffer) {
        _term.write(new Uint8Array(e.data));
      } else {
        _term.write(e.data);
      }
    };

    _ws.onclose = () => {
      if (_term) _term.write('\r\n\x1b[31m[connection closed]\x1b[0m\r\n');
    };

    _ws.onerror = () => {
      if (_term) _term.write('\r\n\x1b[31m[connection error — check API base URL in Settings]\x1b[0m\r\n');
    };
  }

  function _sendResize() {
    if (!_ws || _ws.readyState !== WebSocket.OPEN || !_term) return;
    _ws.send(JSON.stringify({
      type: 'resize',
      cols: _term.cols,
      rows: _term.rows,
    }));
  }

  // ── Show SHELL view ─────────────────────────────────────────────────────
  function _activateShell() {
    // Hide all term-out-* panels
    document.querySelectorAll('[id^="term-out-"]').forEach(el => el.style.display = 'none');

    // Show xterm container
    const container = document.getElementById('xterm-container');
    if (container) container.style.display = 'flex';

    // Hide the fake input row
    const row = _inputRow();
    if (row) row.style.display = 'none';

    // Set active class on shell tab only
    document.querySelectorAll('.terminal-tab').forEach(t =>
      t.classList.toggle('active', t.dataset.term === 'shell'));

    // Expand if minimized
    const dock = document.getElementById('terminal-dock');
    if (dock && dock.classList.contains('minimized')) _setMinimized(false);

    // Init + fit after DOM settles
    _loadXterm(() => {
      _initXterm();
      setTimeout(() => { if (_fitAddon) { _fitAddon.fit(); _sendResize(); } }, 100);
    });
  }

  // ── Wrap page's switchTerm to handle shell ───────────────────────────────
  // Called after DOM is ready so window.switchTerm exists.
  function patchSwitchTerm() {
    const orig = window.switchTerm;
    if (typeof orig !== 'function') return;

    window.switchTerm = function (node) {
      if (node === 'shell') {
        _activateShell();
        return;
      }
      // Switching away from shell: hide xterm, restore input row
      const container = document.getElementById('xterm-container');
      if (container) container.style.display = 'none';
      const row = _inputRow();
      if (row) row.style.display = '';

      orig(node);
    };
  }

  // ── Wire the SHELL tab click ─────────────────────────────────────────────
  function wireShellTab() {
    const shellTab = document.querySelector('.terminal-tab[data-term="shell"]');
    if (!shellTab) return;
    shellTab.addEventListener('click', () => {
      // Delegate to patched switchTerm if available, else activate directly
      if (typeof window.switchTerm === 'function') {
        window.switchTerm('shell');
      } else {
        _activateShell();
      }
    });
  }

  // ── Init ─────────────────────────────────────────────────────────────────
  function init() {
    restoreState();
    wireMinimizeBtn();
    patchSwitchTerm();
    wireShellTab();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
