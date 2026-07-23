/**
 * HTML UI overlay — config panel, flight board, stats bar, event log.
 * Panels are wrapped as draggable / minimizable / resizable windows.
 */

import { WindowManager } from './window-manager.js';
import { SurfaceRadar } from './surface-radar.js';
import { Dock, DOCK_ITEMS } from './dock.js';
import { t, tf } from './i18n.js';

export class UIOverlay {
  constructor(container, onAction, runLog = null) {
    this._cb    = onAction;
    this._log   = [];
    this._runLog = runLog;                 // for the RECALL replay panel
    this._root  = this._build(container);
    this._cfg   = { arrivalInterval: 25, runways: 2, gateCount: 6, bridgeCount: 4 };

    // Make the overlay panels into movable windows (titles read from each panel).
    // Windows are grouped by role and toggled from the three-sided Dock. Only a
    // small default set opens on first load; the rest are one dock-click away.
    this._wm = new WindowManager();
    this._wm.register(document.getElementById('panel-gate-detail'), { hidden: true });   // contextual (gate focus)
    const DEFAULT_OPEN = new Set(['panel-config', 'panel-flights', 'panel-analytics', 'panel-radar']);
    DOCK_ITEMS.forEach(it =>
      this._wm.register(document.getElementById(it.id), { hidden: !DEFAULT_OPEN.has(it.id) }));
    this._dock = new Dock(this._wm);
    this._radar = new SurfaceRadar(document.getElementById('radar-canvas'));
    this._replayRadar = new SurfaceRadar(document.getElementById('replay-canvas'));
    this._rp = { t: 0, playing: false, speed: 1, dragging: false, span: null, railKey: '' };
    this._bindReplay();
    this._bindActions();
  }

  // ── Bottom action bar + live dialog + restore prompt ─────────────────────────
  _bindActions() {
    const on = (id, ev, fn) => { const e = document.getElementById(id); if (e) e.addEventListener(ev, fn); };
    on('act-pause', 'click', () => this._cb('togglePause'));
    on('act-live', 'click', () => { const d = document.getElementById('live-dialog'); if (d) d.style.display = 'flex'; });
    on('act-save', 'click', () => this._cb('saveState'));
    on('live-close', 'click', () => { const d = document.getElementById('live-dialog'); if (d) d.style.display = 'none'; });
    on('live-connect', 'click', () => this._cb('liveConnect', { url: (document.getElementById('live-url') || {}).value || '' }));
    on('live-disconnect', 'click', () => this._cb('liveDisconnect'));
    on('restore-yes', 'click', () => { this.hideRestore(); this._cb('restoreYes'); });
    on('restore-no', 'click', () => { this.hideRestore(); this._cb('restoreNo'); });
  }

  setPauseLabel(paused) {
    const b = document.getElementById('act-pause');
    if (b) { b.dataset.i18n = paused ? 'act.resume' : 'act.pause'; b.textContent = t(b.dataset.i18n); b.classList.toggle('act-on', paused); }
  }
  setLiveState(on) {
    const b = document.getElementById('act-live');
    if (b) b.classList.toggle('act-on', !!on);
  }
  setLiveStatus(key, params) {
    const e = document.getElementById('live-status');
    if (e) { e.dataset.i18n = key; e.textContent = params ? tf(key, params) : t(key); }
  }
  showRestorePrompt(text) {
    const bar = document.getElementById('restore-bar');
    const msg = document.getElementById('restore-msg');
    if (msg) msg.textContent = text;
    if (bar) bar.style.display = 'flex';
  }
  hideRestore() { const bar = document.getElementById('restore-bar'); if (bar) bar.style.display = 'none'; }

  // ── RECALL surface replay ────────────────────────────────────────────────────
  _bindReplay() {
    const rp = this._rp;
    const scrub = document.getElementById('rp-scrub');
    document.getElementById('rp-play').addEventListener('click', e => {
      rp.playing = !rp.playing;
      if (rp.playing && rp.span && rp.t >= rp.span.max - 0.05) {   // replay from start
        rp.t = rp.span.min; this._replayRadar.resetTrails();
      }
      e.target.textContent = rp.playing ? '⏸' : '▶';
    });
    document.getElementById('rp-speed').addEventListener('click', e => {
      rp.speed = rp.speed === 1 ? 4 : rp.speed === 4 ? 8 : 1;
      e.target.textContent = `${rp.speed}×`;
    });
    document.getElementById('rp-prev').addEventListener('click', () => this._seekIncident(-1));
    document.getElementById('rp-next').addEventListener('click', () => this._seekIncident(1));
    scrub.addEventListener('input', () => {
      if (!rp.span) return;
      rp.dragging = true; rp.playing = false;
      document.getElementById('rp-play').textContent = '▶';
      rp.t = rp.span.min + (scrub.value / 1000) * (rp.span.max - rp.span.min);
      this._replayRadar.resetTrails();
    });
    scrub.addEventListener('change', () => { rp.dragging = false; });
  }

  _seekIncident(dir) {
    const rp = this._rp;
    if (!this._runLog || !rp.span) return;
    const inc = this._runLog.getIncidents();
    if (!inc.length) return;
    let target = null;
    if (dir > 0) { for (const e of inc) if (e.simT > rp.t + 0.2) { target = e.simT; break; } }
    else { for (let i = inc.length - 1; i >= 0; i--) if (inc[i].simT < rp.t - 0.2) { target = inc[i].simT; break; } }
    if (target != null) {
      rp.t = Math.max(rp.span.min, Math.min(rp.span.max, target));
      rp.playing = false; document.getElementById('rp-play').textContent = '▶';
      this._replayRadar.resetTrails();
    }
  }

  /** Advance + draw the replay each render frame (frameDt seconds). */
  updateReplay(frameDt) {
    const canvas = document.getElementById('replay-canvas');
    if (!canvas || !canvas.clientWidth || !this._runLog) return;   // collapsed / no data
    const rp = this._rp;
    const span = this._runLog.span();
    if (!span) return;
    const first = !rp.span;
    rp.span = span;
    if (first) rp.t = span.min;
    if (rp.t < span.min) rp.t = span.min;

    if (rp.playing) {
      rp.t += frameDt * rp.speed;
      if (rp.t >= span.max) { rp.t = span.max; rp.playing = false; document.getElementById('rp-play').textContent = '▶'; }
    }
    // Incidents change slowly — recompute the list only when the event count
    // moves, and reuse it for both the flash and the rail (not twice/frame).
    const nEvents = this._runLog.counts().events;
    if (!rp.incCache || rp.incCache.n !== nEvents) rp.incCache = { n: nEvents, list: this._runLog.getIncidents() };
    const inc = rp.incCache.list;

    // Incident flash: red runway if the replay time is within 3s of a conflict.
    const stages = {};
    for (const e of inc) {
      if (e.type === 'rimcas_alert' && Math.abs(e.simT - rp.t) < 3) {
        const m = (e.text || '').match(/RWY[12]/);
        if (m) stages[m[0]] = 2;
      }
    }
    const frame = this._runLog.frameAt(rp.t);
    if (frame) this._replayRadar.update(frame, stages);

    if (!rp.dragging) {
      const denom = (span.max - span.min) || 1;
      document.getElementById('rp-scrub').value = Math.round(((rp.t - span.min) / denom) * 1000);
    }
    const rd = document.getElementById('rp-time');
    if (rd) rd.textContent = `T ${Math.round(rp.t)}s / ${Math.round(span.max)}s`;

    // Incident rail (rebuild only when the incident set changes).
    const key = span.min + '|' + span.max + '|' + inc.length;
    if (key !== rp.railKey) {
      rp.railKey = key;
      const denom = (span.max - span.min) || 1;
      const KC = { conflict: '#ff3b3b', closed: '#f39c12', stop: '#e0b040', hold: '#4aa8ff' };
      document.getElementById('rp-rail').innerHTML = inc.map(e =>
        `<span class="rp-mark" style="left:${((e.simT - span.min) / denom) * 100}%;background:${KC[e.kind] || '#888'}"></span>`
      ).join('');
    }
  }

  // ── Build DOM ──────────────────────────────────────────────────────────────
  _build(container) {
    const overlay = document.createElement('div');
    overlay.id = 'ui-overlay';
    overlay.innerHTML = `
      <!-- Left: Config & controls -->
      <div id="panel-config" class="panel">
        <div class="panel-title" data-i18n="panel.config">${t('panel.config')}</div>

        <label class="ctrl-label"><span data-i18n="cfg.interval">${t('cfg.interval')}</span><span id="val-interval">25</span></label>
        <input type="range" id="sl-interval" min="8" max="60" value="25" step="1">

        <label class="ctrl-label" data-i18n="cfg.runwayMode">${t('cfg.runwayMode')}</label>
        <select id="sel-rwys" class="sel-input">
          <option value="2" data-i18n="cfg.dual">${t('cfg.dual')}</option>
          <option value="1" data-i18n="cfg.single">${t('cfg.single')}</option>
        </select>

        <label class="ctrl-label"><span data-i18n="cfg.gateCount">${t('cfg.gateCount')}</span><span id="val-gates">6</span></label>
        <input type="range" id="sl-gates" min="4" max="12" value="6" step="1">

        <label class="ctrl-label"><span data-i18n="cfg.bridgeCount">${t('cfg.bridgeCount')}</span><span id="val-bridges">4</span></label>
        <input type="range" id="sl-bridges" min="0" max="6" value="4" step="1">

        <button id="btn-apply" class="btn-primary" data-i18n="cfg.apply">${t('cfg.apply')}</button>

        <hr class="divider">
        <div class="panel-subtitle" data-i18n="cfg.emergency">${t('cfg.emergency')}</div>
        <button id="btn-spawn"   class="btn-success"   data-i18n="cfg.spawn">${t('cfg.spawn')}</button>
        <button id="btn-hold"    class="btn-warn"      data-i18n="cfg.groundStop">${t('cfg.groundStop')}</button>
        <button id="btn-resume"  class="btn-secondary" data-i18n="cfg.resume">${t('cfg.resume')}</button>

        <hr class="divider">
        <div class="panel-subtitle" data-i18n="cfg.atc">${t('cfg.atc')}</div>
        <div id="atc-status" class="ctrl-label" style="flex-direction:column; gap:3px">
          <span><span data-i18n="cfg.next">${t('cfg.next')}</span><span id="atc-next" style="color:var(--text)">—</span> <span data-i18n="cfg.nextUnit">${t('cfg.nextUnit')}</span></span>
          <span><span data-i18n="cfg.onGround">${t('cfg.onGround')}</span><span id="atc-count" style="color:var(--text)">0</span></span>
        </div>
        <label class="an-auto" style="margin-top:5px"><input type="checkbox" id="cfg-meter" checked> <span data-i18n="cfg.metering">${t('cfg.metering')}</span></label>
        <label class="an-auto" style="margin-top:4px"><input type="checkbox" id="cfg-set"> <span data-i18n="cfg.set">${t('cfg.set')}</span></label>
        <label class="an-auto" style="margin-top:4px"><input type="checkbox" id="cfg-agl" checked> <span data-i18n="cfg.agl">${t('cfg.agl')}</span></label>
      </div>

      <!-- Right: Flight board -->
      <div id="panel-flights" class="panel">
        <div class="panel-title" data-i18n="panel.flights">${t('panel.flights')}</div>
        <div class="fids-header">
          <span data-i18n="fids.flight">${t('fids.flight')}</span><span data-i18n="fids.airline">${t('fids.airline')}</span><span data-i18n="fids.state">${t('fids.state')}</span><span data-i18n="fids.gate">${t('fids.gate')}</span>
        </div>
        <div id="flight-rows"></div>
      </div>

      <!-- Bottom: Stats bar -->
      <div id="stats-bar">
        <div class="stat-item"><span class="stat-lbl" data-i18n="stat.arrivals">${t('stat.arrivals')}</span><span id="s-arrivals" class="stat-val">0</span></div>
        <div class="stat-item"><span class="stat-lbl" data-i18n="stat.departures">${t('stat.departures')}</span><span id="s-departures" class="stat-val">0</span></div>
        <div class="stat-item"><span class="stat-lbl" data-i18n="stat.onGround">${t('stat.onGround')}</span><span id="s-onground" class="stat-val">0</span></div>
        <div class="stat-item"><span class="stat-lbl" data-i18n="stat.gateUtil">${t('stat.gateUtil')}</span><span id="s-gateutil" class="stat-val">0%</span></div>
        <div class="stat-item"><span class="stat-lbl" data-i18n="stat.throughput">${t('stat.throughput')}</span><span id="s-throughput" class="stat-val">0</span></div>
        <div class="stat-sep"></div>
        <button id="act-pause" class="act-btn" data-i18n="act.pause">${t('act.pause')}</button>
        <button id="act-live" class="act-btn" data-i18n="act.live">${t('act.live')}</button>
        <button id="act-save" class="act-btn" data-i18n="act.save">${t('act.save')}</button>
      </div>

      <!-- LIVE 数据源对接对话框 -->
      <div id="live-dialog" style="display:none">
        <div class="live-card">
          <div class="live-h" data-i18n="live.title">${t('live.title')}</div>
          <div class="live-desc" data-i18n="live.desc">${t('live.desc')}</div>
          <input id="live-url" class="live-url" type="text" placeholder="wss://…/airport-feed" value="wss://">
          <div class="live-status" id="live-status" data-i18n="live.st.idle">${t('live.st.idle')}</div>
          <div class="live-btns">
            <button id="live-connect" class="act-btn" data-i18n="live.connect">${t('live.connect')}</button>
            <button id="live-disconnect" class="btn-secondary" data-i18n="live.disconnect">${t('live.disconnect')}</button>
            <button id="live-close" class="btn-secondary" data-i18n="live.close">${t('live.close')}</button>
          </div>
        </div>
      </div>

      <!-- 恢复上次运行状态提示条 -->
      <div id="restore-bar" style="display:none">
        <span id="restore-msg"></span>
        <button id="restore-yes" class="act-btn" data-i18n="save.restore">${t('save.restore')}</button>
        <button id="restore-no" class="btn-secondary" data-i18n="save.discard">${t('save.discard')}</button>
      </div>

      <!-- Event log -->
      <div id="event-log">
        <div class="log-title" data-i18n="panel.log">${t('panel.log')}</div>
        <div id="log-items"></div>
      </div>

      <!-- Gate focus: exit button + ground-handling detail panel -->
      <button id="btn-exit-gate" class="btn-secondary" style="display:none" data-i18n="gd.exit">${t('gd.exit')}</button>

      <div id="panel-gate-detail" class="panel" style="display:none">
        <div class="panel-title"><span data-i18n="fids.gate">${t('fids.gate')}</span> <span id="gd-gate">—</span> <span data-i18n="gd.suffix">${t('gd.suffix')}</span></div>
        <div id="gd-flight" class="gd-flight" data-i18n="gd.waiting">${t('gd.waiting')}</div>
        <div id="gd-stand" class="gd-stand"></div>
        <div id="gd-acdm" class="gd-acdm"></div>
        <div class="gd-overall-row">
          <div class="gd-overall-track"><div id="gd-overall-bar"></div></div>
          <span id="gd-overall-pct">0%</span>
        </div>
        <div id="gd-nodes"></div>
      </div>

      <!-- Turnaround Control wall: multi-gate POBT watchlist (Assaia-style) -->
      <div id="panel-turnwall" class="panel">
        <div class="panel-title" data-i18n="panel.turnwall">${t('panel.turnwall')}</div>
        <div id="tw-head" class="tw-head"></div>
        <div id="tw-cards" class="tw-cards"></div>
      </div>

      <!-- Stand-plan Gantt: rule-based allocation, RMS-style (collapsed by default) -->
      <div id="panel-standplan" class="panel">
        <div class="panel-title" data-i18n="panel.standplan">${t('panel.standplan')}</div>
        <div id="sp-body" class="sp-body"></div>
      </div>

      <!-- OOOI wire feed + ASPM taxi-time stats (collapsed by default) -->
      <div id="panel-oooi" class="panel">
        <div class="panel-title" data-i18n="panel.oooi">${t('panel.oooi')}</div>
        <div id="oooi-aspm" class="oooi-aspm"></div>
        <div id="oooi-ticker" class="oooi-ticker"></div>
      </div>

      <!-- Demand-Capacity Balancing hotspot forecast (collapsed by default) -->
      <div id="panel-dcb" class="panel">
        <div class="panel-title" data-i18n="panel.dcb">${t('panel.dcb')}</div>
        <div id="dcb-head" class="dcb-head"></div>
        <div id="dcb-body" class="dcb-body"></div>
      </div>

      <!-- AMAN arrival ladder (collapsed by default) -->
      <div id="panel-aman" class="panel">
        <div class="panel-title" data-i18n="panel.aman">${t('panel.aman')}</div>
        <div id="aman-cols" class="aman-cols"></div>
      </div>

      <!-- Disruption / what-if console (collapsed by default) -->
      <div id="panel-whatif" class="panel">
        <div class="panel-title" data-i18n="panel.whatif">${t('panel.whatif')}</div>
        <div id="wi-banner" class="wi-banner" style="display:none"></div>
        <div class="wi-lbl" data-i18n="wi.weather">${t('wi.weather')}</div>
        <div id="wi-weather" class="wi-seg">
          ${['VMC', 'MVMC', 'IMC', 'LVP'].map((k, i) => `<button class="wi-wx" data-level="${i}">${k}</button>`).join('')}
        </div>
        <div class="wi-lbl" data-i18n="wi.runways">${t('wi.runways')}</div>
        <div id="wi-runways" class="wi-seg">
          <button class="wi-rwy" data-rwy="RWY1">RWY1</button>
          <button class="wi-rwy" data-rwy="RWY2">RWY2</button>
        </div>
        <div class="wi-lbl" data-i18n="wi.delta">${t('wi.delta')}</div>
        <div id="wi-delta" class="wi-delta"></div>
      </div>

      <!-- RECALL surface replay + time-scrubber (collapsed by default) -->
      <div id="panel-replay" class="panel">
        <div class="panel-title" data-i18n="panel.replay">${t('panel.replay')}</div>
        <canvas id="replay-canvas" class="radar-canvas"></canvas>
        <div class="rp-railwrap"><div id="rp-rail" class="rp-rail"></div>
          <input type="range" id="rp-scrub" class="rp-scrub" min="0" max="1000" value="0"></div>
        <div class="rp-ctrls">
          <button id="rp-play" class="rp-btn">▶</button>
          <button id="rp-prev" class="rp-btn" title="prev incident">⏮</button>
          <button id="rp-next" class="rp-btn" title="next incident">⏭</button>
          <button id="rp-speed" class="rp-btn rp-speed">1×</button>
          <span id="rp-time" class="rp-time" data-i18n="rp.recording">${t('rp.recording')}</span>
        </div>
      </div>

      <!-- ASDE-X surface surveillance radar (collapsed by default) -->
      <div id="panel-radar" class="panel">
        <div class="panel-title" data-i18n="panel.radar">${t('panel.radar')}</div>
        <canvas id="radar-canvas" class="radar-canvas"></canvas>
      </div>

      <!-- A-SMGCS runway safety net / RIMCAS (collapsed by default) -->
      <div id="panel-safetynet" class="panel">
        <div class="panel-title" data-i18n="panel.safetynet">${t('panel.safetynet')}</div>
        <div id="sn-runways" class="sn-runways"></div>
        <div id="sn-kpis" class="sn-kpis"></div>
        <div class="sn-loghead" data-i18n="sn.logHead">${t('sn.logHead')}</div>
        <div id="sn-log" class="sn-log"></div>
      </div>

      <!-- Data algorithm layer: analytics + optimization + run log -->
      <div id="panel-analytics" class="panel">
        <div class="panel-title" data-i18n="panel.analytics">${t('panel.analytics')}</div>
        <div id="an-metrics" class="an-grid"></div>
        <div class="an-row">
          <label class="an-auto"><input type="checkbox" id="an-auto" checked> <span data-i18n="an.autoOpt">${t('an.autoOpt')}</span></label>
          <button id="an-export" class="btn-secondary" data-i18n="an.export">${t('an.export')}</button>
        </div>
        <div class="an-head" data-i18n="an.head">${t('an.head')}</div>
        <div id="an-decisions" class="an-decisions"></div>
      </div>
    `;

    container.appendChild(overlay);
    this._bindControls();
    return overlay;
  }

  _bindControls() {
    const sl = document.getElementById('sl-interval');
    const vl = document.getElementById('val-interval');
    sl.addEventListener('input', () => {
      vl.textContent = sl.value;
      this._cfg.arrivalInterval = +sl.value;
    });

    document.getElementById('sel-rwys').addEventListener('change', e => {
      this._cfg.runways = +e.target.value;
    });

    const slGates   = document.getElementById('sl-gates');
    const slBridges = document.getElementById('sl-bridges');
    slGates.addEventListener('input', () => {
      const gc = +slGates.value;
      document.getElementById('val-gates').textContent = gc;
      this._cfg.gateCount = gc;
      // Bridges cannot exceed gates.
      slBridges.max = gc;
      if (+slBridges.value > gc) { slBridges.value = gc; }
      document.getElementById('val-bridges').textContent = slBridges.value;
      this._cfg.bridgeCount = +slBridges.value;
    });
    slBridges.addEventListener('input', () => {
      document.getElementById('val-bridges').textContent = slBridges.value;
      this._cfg.bridgeCount = +slBridges.value;
    });

    document.getElementById('btn-apply').addEventListener('click', () => {
      this._cb('reconfigure', this._cfg);
    });

    document.getElementById('btn-exit-gate').addEventListener('click', () => {
      this._cb('exitGate');
    });
    document.getElementById('btn-spawn').addEventListener('click', () => {
      this._cb('spawnNow');
    });
    document.getElementById('btn-hold').addEventListener('click', () => {
      this._cb('groundStop');
    });
    document.getElementById('btn-resume').addEventListener('click', () => {
      this._cb('resume');
    });

    document.getElementById('an-auto').addEventListener('change', e => {
      this._cb('toggleAutoOpt', { on: e.target.checked });
    });
    document.getElementById('cfg-meter').addEventListener('change', e => {
      this._cb('toggleMetering', { on: e.target.checked });
    });
    document.getElementById('cfg-set').addEventListener('change', e => {
      this._cb('toggleSET', { on: e.target.checked });
    });
    document.getElementById('cfg-agl').addEventListener('change', e => {
      this._cb('toggleGuidance', { on: e.target.checked });
    });
    document.getElementById('wi-weather').addEventListener('click', e => {
      const b = e.target.closest('.wi-wx');
      if (b) this._cb('setWeather', { level: +b.dataset.level });
    });
    document.getElementById('wi-runways').addEventListener('click', e => {
      const b = e.target.closest('.wi-rwy');
      if (b) this._cb('toggleRunway', { runway: b.dataset.rwy, closed: !b.classList.contains('wi-closed') });
    });
    document.getElementById('an-export').addEventListener('click', () => {
      this._cb('exportLog');
    });

    // Turnaround Control wall — click a card to focus that gate.
    document.getElementById('tw-cards').addEventListener('click', e => {
      const card = e.target.closest('.tw-card');
      if (card && card.dataset.gate) this._cb('focusGate', { gateId: card.dataset.gate });
    });

    // Stand-plan Gantt — click an occupied row to focus that gate.
    document.getElementById('sp-body').addEventListener('click', e => {
      const row = e.target.closest('.sp-row');
      if (row && row.dataset.gate && row.querySelector('.sp-bar, .sp-inbound')) {
        this._cb('focusGate', { gateId: row.dataset.gate });
      }
    });
  }

  // ── Turnaround Control wall (multi-gate POBT watchlist) ──────────────────────
  updateTurnWall(wall) {
    const cont = document.getElementById('tw-cards');
    if (!cont) return;
    const cards  = (wall && wall.cards) || [];
    const clock  = wall ? wall.clock : 0;
    const atRisk = wall ? wall.atRisk : 0;

    const head = document.getElementById('tw-head');
    if (head) {
      head.className = 'tw-head' + (atRisk > 0 ? ' at-risk' : '');
      head.textContent = !cards.length ? ''
        : atRisk > 0 ? tf('tw.atRiskN', { n: atRisk })
                     : tf('tw.onTrackN', { n: cards.length });
    }
    if (!cards.length) { cont.innerHTML = `<div class="tw-empty">${t('tw.empty')}</div>`; return; }

    cont.innerHTML = cards.map(c => {
      // Risk chip reuses the OTP color idiom: on-target / minor / at-risk.
      const band = c.riskSec <= c.tol ? 'tw-good' : c.riskSec <= 2 * c.tol ? 'tw-warn' : 'tw-bad';
      const chip = c.tobtSim == null ? '—' : `${c.riskSec > 0 ? '+' : ''}${c.riskSec.toFixed(0)}s`;
      const strip = c.nodes.map(n => `<span class="tw-seg tw-s${n.s}" style="background:${n.c}"></span>`).join('');
      const foot = c.held
        ? `<span class="tw-hold">${t('tw.held')}</span>`
        : `<span class="tw-pobt">${tf('tw.pobt', { s: Math.max(0, c.pobtSim - clock).toFixed(0) })}</span>`;
      return `
        <div class="tw-card" data-gate="${c.gate}" title="${c.callsign} · ${c.gate}">
          <div class="tw-card-top">
            <span class="tw-cs">${c.callsign}</span>
            <span class="tw-gate">${c.gate}</span>
            <span class="tw-chip ${band}">${chip}</span>
          </div>
          <div class="tw-strip">${strip}</div>
          <div class="tw-foot">${foot}</div>
        </div>`;
    }).join('');
  }

  // ── Stand-plan Gantt (rule-based allocation, gates × rolling time) ───────────
  updateStandPlan(plan) {
    const body = document.getElementById('sp-body');
    if (!body || !plan) return;
    const span = plan.winEnd - plan.winStart || 1;
    const clampPct = (v) => Math.max(0, Math.min(100, v));
    const nowFrac = clampPct(((plan.now - plan.winStart) / span) * 100) / 100;

    const rows = plan.gates.map(g => {
      const badges =
        `<span class="sp-b ${g.contact ? 'sp-contact' : 'sp-remote'}">${g.contact ? t('stand.contact') : t('stand.remote')}</span>` +
        (g.wide ? `<span class="sp-b sp-wide">W</span>` : '');
      let track = '';
      if (g.bar) {
        const s0 = Math.max(g.bar.startSim, plan.winStart);
        const s1 = Math.min(g.bar.endSim, plan.winEnd);
        const left = clampPct(((s0 - plan.winStart) / span) * 100);
        const width = Math.max(3, clampPct(((s1 - s0) / span) * 100));
        const cls = g.bar.held ? 'sp-bar-held' : g.bar.predicted ? 'sp-bar-plan' : 'sp-bar-done';
        track = `<div class="sp-bar ${cls}" data-gate="${g.id}" style="left:${left}%;width:${width}%" title="${g.bar.cs}">${g.bar.cs}</div>`;
      } else if (g.inbound) {
        const left = clampPct(nowFrac * 100);
        track = `<div class="sp-inbound" style="left:${left}%">${g.inbound.cs} · ${t('sp.inbound')}</div>`;
      }
      return `
        <div class="sp-row" data-gate="${g.id}">
          <div class="sp-label">${g.id}${badges}</div>
          <div class="sp-track">${track}</div>
        </div>`;
    }).join('');

    // Single now-line over the track column (62px label + 4px grid gap = 66px).
    const nowLine = `<div class="sp-now" style="left:calc(66px + (100% - 66px) * ${nowFrac})"></div>`;
    body.innerHTML = nowLine + rows;
  }

  // ── ASDE-X surface surveillance radar ────────────────────────────────────────
  updateSurfaceRadar(snapshot, stages) {
    if (this._radar) this._radar.update(snapshot, stages);
  }

  // ── Demand-Capacity Balancing hotspot forecast ───────────────────────────────
  updateDCB(fc) {
    if (!fc) return;
    const head = document.getElementById('dcb-head');
    if (head) {
      if (fc.nextHotspotSec != null) {
        head.className = 'dcb-head dcb-hot';
        head.textContent = tf('dcb.next', { s: fc.nextHotspotSec });
      } else {
        head.className = 'dcb-head dcb-ok';
        head.textContent = t('dcb.clear');
      }
    }
    const body = document.getElementById('dcb-body');
    if (!body) return;
    const CHART_H = 40;
    body.innerHTML = ['RWY1', 'RWY2'].map(key => {
      const r = fc.runways[key];
      const scale = Math.max(r.closed ? 1 : r.bins[0].cap, 2,
        ...r.bins.map(b => b.arr + b.dep));
      const bars = r.bins.map(b => {
        const depH = (b.dep / scale) * CHART_H;
        const arrH = (b.arr / scale) * CHART_H;
        const capY = r.closed ? CHART_H : CHART_H - (b.cap / scale) * CHART_H;
        return `<div class="dcb-col${b.hot ? ' dcb-colhot' : ''}" style="height:${CHART_H}px">` +
               `<div class="dcb-arr" style="height:${arrH}px"></div>` +
               `<div class="dcb-dep" style="height:${depH}px"></div>` +
               (r.closed ? '' : `<div class="dcb-cap" style="top:${capY}px"></div>`) +
               `</div>`;
      }).join('');
      const label = r.closed ? `${key} <span class="dcb-closed">${t('dcb.closed')}</span>`
                             : `${key} <span class="dcb-cap-n">${r.effSep}s</span>`;
      return `<div class="dcb-rwy"><div class="dcb-rlabel">${label}</div><div class="dcb-chart">${bars}</div></div>`;
    }).join('');
  }

  // ── AMAN arrival ladder ──────────────────────────────────────────────────────
  updateAman(ladder) {
    const host = document.getElementById('aman-cols');
    if (!host || !ladder) return;
    const CATCLS = { H: 'wake-h', M: 'wake-m', S: 'wake-s' };
    const col = (key) => {
      const rungs = ladder[key] || [];
      const body = rungs.length
        ? rungs.map(r => {
            const ttl = r.ttl > 0.5 ? `<span class="aman-ttl">−${Math.round(r.ttl)}s</span>` : '';
            return `<div class="aman-rung"><span class="aman-seq">${r.seq}</span>` +
                   `<span class="aman-cs">${r.cs}</span>` +
                   `<span class="aman-cat ${CATCLS[r.cat] || ''}">${r.cat}</span>` +
                   `<span class="aman-sta">${Math.round(r.sta - ladder.clock)}s</span>${ttl}</div>`;
          }).join('')
        : `<div class="aman-empty">${t('aman.none')}</div>`;
      return `<div class="aman-col"><div class="aman-rwy">${key}</div>${body}</div>`;
    };
    host.innerHTML = col('RWY1') + col('RWY2');
  }

  // ── Disruption / what-if console ─────────────────────────────────────────────
  updateDisruption(d, delta) {
    if (!d) return;
    document.querySelectorAll('#wi-weather .wi-wx').forEach(b => {
      b.classList.toggle('wi-on', +b.dataset.level === d.weather);
    });
    document.querySelectorAll('#wi-runways .wi-rwy').forEach(b => {
      b.classList.toggle('wi-closed', !!d.runwaysClosed[b.dataset.rwy]);
    });
    const banner = document.getElementById('wi-banner');
    if (banner) {
      if (d.active) {
        const closed = Object.keys(d.runwaysClosed).filter(k => d.runwaysClosed[k]);
        const bits = [];
        if (d.weather > 0) bits.push(`${d.weatherKey}`);
        if (closed.length) bits.push(tf('wi.closed', { r: closed.join('/') }));
        banner.textContent = tf('wi.activeBanner', { s: bits.join(' · ') });
        banner.style.display = 'block';
      } else {
        banner.style.display = 'none';
      }
    }
    const dEl = document.getElementById('wi-delta');
    if (dEl) {
      if (!delta) { dEl.innerHTML = `<span class="wi-empty">${t('wi.noBaseline')}</span>`; return; }
      // Down-is-bad for util; up-is-bad for taxi-out/dep-wait. A null delta
      // means the metric had no baseline data yet → shown as "—" (unknown).
      const row = (label, val, unit, goodWhenNeg) => {
        if (val == null) return `<div class="wi-drow"><span>${label}</span><span>—</span></div>`;
        const cls = Math.abs(val) < 0.05 ? '' : ((val < 0) === goodWhenNeg ? 'wi-good' : 'wi-bad');
        const sign = val > 0 ? '+' : '';
        return `<div class="wi-drow"><span>${label}</span><span class="${cls}">${sign}${val.toFixed(unit === '%' ? 0 : 1)}${unit}</span></div>`;
      };
      // Sim-time outcome metrics only (throughput is wall-clock-based and would
      // not reflect a sim-time scenario cleanly).
      dEl.innerHTML =
        row(t('an.gateUtil'),   delta.gateUtil == null ? null : delta.gateUtil * 100, '%', false) +
        row(t('an.taxiOut'),    delta.avgTaxiOut, 's', true) +
        row(t('an.avgDepWait'), delta.avgDepWait, 's', true);
    }
  }

  // ── A-SMGCS runway safety net (RIMCAS) ───────────────────────────────────────
  updateSafetyNets(st) {
    if (!st) return;
    const KIND = { 0: 'clear', 1: 'caution', 2: 'alarm' };
    const rw = document.getElementById('sn-runways');
    if (rw) {
      rw.innerHTML = Object.keys(st.runways).map(k => {
        const stage = st.runways[k].stage;
        const kind = KIND[stage];
        return `<div class="sn-rwy sn-${kind}"><span class="sn-rwy-id">${k}</span>` +
               `<span class="sn-rwy-stat">${t('sn.' + kind)}</span></div>`;
      }).join('');
    }
    const kp = document.getElementById('sn-kpis');
    if (kp) {
      const mm = Math.floor(st.streakSec / 60), ss = Math.round(st.streakSec % 60);
      const streak = `${mm}:${String(ss).padStart(2, '0')}`;
      kp.innerHTML =
        `<div class="sn-kpi"><span class="sn-k">${t('sn.streak')}</span><span class="sn-v${st.everAlarmed ? '' : ' sn-good'}">${streak}</span></div>` +
        `<div class="sn-kpi"><span class="sn-k">${t('sn.alarms')}</span><span class="sn-v${st.alarms ? ' sn-bad' : ''}">${st.alarms}</span></div>` +
        `<div class="sn-kpi"><span class="sn-k">${t('sn.cautions')}</span><span class="sn-v">${st.cautions}</span></div>`;
    }
    const lg = document.getElementById('sn-log');
    if (lg) {
      lg.innerHTML = st.log.length
        ? st.log.map(e => {
            const kind = e.peak === 2 ? t('sn.alarm') : t('sn.caution');
            return `<div class="sn-logline sn-${e.peak === 2 ? 'alarm' : 'caution'}">` +
                   `${tf('sn.episode', { rwy: e.runway, kind, dur: Math.round(e.durSec) })}</div>`;
          }).join('')
        : `<div class="sn-empty">${t('sn.noAlerts')}</div>`;
    }
  }

  // ── OOOI wire feed + ASPM taxi-time stats ────────────────────────────────────
  updateOOOI(events, aspm) {
    const tbl = document.getElementById('oooi-aspm');
    if (tbl && aspm) {
      const cell = (s) => s && s.n ? `${s.med}/${s.p90}` : '—';
      const rows = Object.keys(aspm).map(rwy =>
        `<div class="oooi-arow"><span class="oooi-rwy">${rwy}</span>` +
        `<span>${t('aspm.out')} <b>${cell(aspm[rwy].taxiOut)}</b></span>` +
        `<span>${t('aspm.in')} <b>${cell(aspm[rwy].taxiIn)}</b></span></div>`).join('');
      tbl.innerHTML = `<div class="oooi-ahead">${t('aspm.head')}</div>${rows}`;
    }
    const feed = document.getElementById('oooi-ticker');
    if (feed) {
      const evs = events || [];
      if (!evs.length) { feed.innerHTML = `<div class="oooi-empty">${t('oooi.wait')}</div>`; return; }
      feed.innerHTML = evs.map(e => {
        const d = new Date(e.wall);
        const p2 = (n) => String(n).padStart(2, '0');
        const z = `${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`;
        return `<div class="oooi-line"><span class="oooi-code oooi-${e.code}">${e.code.padEnd(4)}</span>` +
               `<span class="oooi-z">${z}</span> ${e.cs} <span class="oooi-loc">${e.gate ?? '—'}·${e.rwy}</span></div>`;
      }).join('');
    }
  }

  // ── Analytics / optimization layer panel ─────────────────────────────────────
  updateAnalytics({ metrics, decisions, logCounts }) {
    const m = metrics || {};
    const cell = (label, val, cls = '') =>
      `<div class="an-cell${cls ? ' ' + cls : ''}"><span class="an-k">${label}</span><span class="an-v">${val}</span></div>`;
    const fmtKg = kg => kg >= 999.5 ? `${(kg / 1000).toFixed(1)} t` : `${Math.round(kg)} kg`;
    const grid = document.getElementById('an-metrics');
    if (grid) {
      // A-CDM on-time performance — color-coded KPI (green ≥85%, amber ≥70%, red below).
      const otpPct = Math.round((m.otp ?? 1) * 100);
      const otpCls = m.otpCount ? (otpPct >= 85 ? 'an-good' : otpPct >= 70 ? 'an-warn' : 'an-bad') : '';
      const otpVal = m.otpCount ? `${otpPct}%` : '—';
      grid.innerHTML =
        cell(t('an.onTime'),     otpVal, otpCls) +
        cell(t('an.gateUtil'),   `${Math.round((m.gateUtil ?? 0) * 100)}%`) +
        cell(t('an.interval'),   `${m.interval ?? '—'}s`) +
        cell(t('an.avgTaxiIn'),  `${(m.avgTaxiIn ?? 0).toFixed(0)}s`) +
        cell(t('an.avgDepWait'), `${(m.avgDepWait ?? 0).toFixed(0)}s`) +
        cell(t('an.avgTurn'),    `${(m.avgTurn ?? 0).toFixed(0)}s`) +
        cell(t('an.taxiOut'),    `${(m.avgTaxiOut ?? 0).toFixed(0)}s`) +
        cell(t('an.gateHold'),   m.meterHolds ? `${(m.gateHold ?? 0).toFixed(0)}s ×${m.meterHolds}` : '—') +
        cell(t('an.fuelSaved'),  `${Math.round(m.fuelSavedKg ?? 0)} kg`, (m.fuelSavedKg ?? 0) > 0 ? 'an-good' : '') +
        cell(t('an.contact'),    m.standCount ? `${Math.round((m.standContactPct ?? 1) * 100)}%` : '—') +
        cell(t('an.standFit'),   m.standCount ? `${Math.round((m.standFitPct ?? 1) * 100)}%` : '—',
             m.standCount && (m.standFitPct ?? 1) >= 0.9 ? 'an-good' : '') +
        cell(t('an.taxiCO2'),    `${fmtKg(m.taxiCO2Kg ?? 0)}`) +
        cell(t('an.setSaved'),   m.setSavedKg ? `${fmtKg(m.setCO2Kg ?? 0)}·${Math.round((m.setCutPct ?? 0) * 100)}%` : '—',
             (m.setSavedKg ?? 0) > 0 ? 'an-good' : '') +
        cell(t('an.throughput'), `${m.throughput ?? 0}`) +
        cell(t('an.noGate'),     `${m.noGate ?? 0}`);
    }
    const dec = document.getElementById('an-decisions');
    if (dec) {
      const items = (decisions || []).map(d => {
        const reason = tf(`an.reason${d.reason.kind}`, d.reason);
        const text = tf('an.decAction', { a: d.from, b: d.to, reason });
        return `<div class="an-dec"><span class="an-dect">T+${d.simT}s</span>${text}</div>`;
      }).join('');
      const counts = logCounts
        ? `<div class="an-dec an-logcount">${tf('an.logCounts', { e: logCounts.events, s: logCounts.snapshots, t: logCounts.turnarounds })}</div>`
        : '';
      dec.innerHTML = counts + (items || `<div class="an-dec an-logcount">${t('an.noActions')}</div>`);
    }
  }

  // ── Flight board ───────────────────────────────────────────────────────────
  updateFlightBoard(flights) {
    const container = document.getElementById('flight-rows');
    if (!container) return;

    const STATE_CLASS = {
      TAXIING_IN:  'state-taxiing-in',
      AT_GATE:     'state-at-gate',
      GATE_HOLD:   'state-holding',   // DMAN gate hold — reuse the amber style
      PUSHBACK:    'state-pushback',
      TAXIING_OUT: 'state-taxiing-out',
      HOLDING:     'state-holding',
      TAKEOFF:     'state-takeoff',
      DONE:        'state-done',
    };
    container.innerHTML = flights.slice(0, 12).map(f => {
      const key = f.holdingAtGate ? 'GATE_HOLD' : f.state;
      const cls = STATE_CLASS[key] ?? 'state-done';
      const txt = t('state.' + key, f.state);
      return `
        <div class="flight-row">
          <span class="fr-callsign">${f.callsign}</span>
          <span class="fr-airline">${t('airline.' + f.airline, f.airline)}</span>
          <span class="fr-state ${cls}">${txt}</span>
          <span class="fr-gate">${f.gate ?? f.gateId ?? '—'}</span>
        </div>`;
    }).join('');
  }

  // Re-apply translations to all static text after a language switch.
  applyLang() {
    this._root.querySelectorAll('[data-i18n]').forEach(el => {
      el.textContent = t(el.dataset.i18n);
    });
  }

  // ── Stats bar ──────────────────────────────────────────────────────────────
  updateStats({ arrivals, departures, onGround, gateUtil, throughput }) {
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    set('s-arrivals',   arrivals);
    set('s-departures', departures);
    set('s-onground',   onGround);
    set('s-gateutil',   `${Math.round(gateUtil * 100)}%`);
    set('s-throughput', throughput);
  }

  // ── ATC status ─────────────────────────────────────────────────────────────
  updateATC({ nextIn, count }) {
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    set('atc-next',  nextIn);
    set('atc-count', count);
  }

  // ── Gate config (sync sliders after a reconfigure) ───────────────────────────
  setGateConfig({ gateCount, bridgeCount }) {
    this._cfg.gateCount   = gateCount;
    this._cfg.bridgeCount = bridgeCount;
    const slG = document.getElementById('sl-gates');
    const slB = document.getElementById('sl-bridges');
    if (slG) { slG.value = gateCount; document.getElementById('val-gates').textContent = gateCount; }
    if (slB) { slB.max = gateCount; slB.value = bridgeCount; document.getElementById('val-bridges').textContent = bridgeCount; }
  }

  // ── Gate focus / ground-handling detail ──────────────────────────────────────
  showExitButton() { const e = document.getElementById('btn-exit-gate'); if (e) e.style.display = 'block'; }
  hideExitButton() { const e = document.getElementById('btn-exit-gate'); if (e) e.style.display = 'none'; }

  enterGateDetail(gateId) {
    const gd = document.getElementById('gd-gate'); if (gd) gd.textContent = gateId;
    const el = document.getElementById('panel-gate-detail');
    if (el) { el.style.display = ''; this._wm.setVisible(el, true); }   // dock-managed visibility
    this.showExitButton();
  }

  exitGateDetail() {
    const el = document.getElementById('panel-gate-detail');
    if (el) this._wm.setVisible(el, false);
    this.hideExitButton();
  }

  updateGateDetail({ gateId, flight, plan }) {
    const g = document.getElementById('gd-gate'); if (g) g.textContent = gateId ?? '—';
    const fEl = document.getElementById('gd-flight');
    if (fEl) {
      fEl.textContent = flight
        ? `${flight.callsign} · ${t('airline.' + flight.airline, flight.airline)} · ${flight.type}`
        : t('gd.waiting');
    }
    // Stand-allocation class chips (contact/remote · wide/narrow).
    const standEl = document.getElementById('gd-stand');
    if (standEl) {
      const s = flight && flight.stand;
      standEl.innerHTML = s
        ? `<span class="sp-badge ${s.contact ? 'sp-contact' : 'sp-remote'}">${s.contact ? t('stand.contact') : t('stand.remote')}</span>` +
          `<span class="sp-badge ${s.wide ? 'sp-wide' : 'sp-narrow'}">${s.wide ? t('stand.wide') : t('stand.narrow')}</span>`
        : '';
    }
    // A-CDM milestone strip (times shown relative to arrival / ATA).
    const acdm = document.getElementById('gd-acdm');
    if (acdm) {
      const ms = flight && flight.milestones ? flight.milestones : null;
      if (ms && ms.ATA) {
        const base = ms.ATA.sim;
        const cell = (code) => {
          const m = ms[code];
          const val = m ? `+${Math.max(0, m.sim - base).toFixed(0)}s` : '—';
          return `<span class="acdm-cell${m ? ' set' : ''}"><span class="acdm-code">${code}</span><span class="acdm-t">${val}</span></span>`;
        };
        acdm.innerHTML = `<div class="acdm-head">${t('gd.acdm')}</div>` +
          ['ATA', 'AIBT', 'TOBT', 'TSAT', 'AOBT', 'ATOT'].map(cell).join('');
      } else {
        acdm.innerHTML = '';
      }
    }

    const bar = document.getElementById('gd-overall-bar');
    const pct = document.getElementById('gd-overall-pct');
    const overall = plan ? Math.round(plan.overall * 100) : 0;
    if (bar) bar.style.width = `${overall}%`;
    if (pct) pct.textContent = `${overall}%`;

    const nodesEl = document.getElementById('gd-nodes');
    if (!nodesEl) return;
    if (!plan) { nodesEl.innerHTML = ''; return; }
    const tfmt = (s) => (s == null ? '—' : `${s.toFixed(0)}s`);
    nodesEl.innerHTML = plan.nodes.map(n => {
      // Each node shows its actual start→end timestamps (sim-sec from gate-in).
      const times = n.done ? `${tfmt(n.actualStart)}→${tfmt(n.actualEnd)}`
                  : n.active ? `${tfmt(n.actualStart)}→…` : '';
      return `
      <div class="gd-node ${n.active ? 'active' : n.done ? 'done' : ''}">
        <div class="gd-node-row">
          <span class="gd-node-label" style="color:${n.color}">${t('node.' + n.id, n.label)}</span>
          <span class="gd-node-time">${times}</span>
        </div>
        <div class="gd-node-track"><div class="gd-node-bar" style="width:${(n.progress * 100) | 0}%;background:${n.color}"></div></div>
      </div>`;
    }).join('');
  }

  // ── Event log ──────────────────────────────────────────────────────────────
  log(msg, type = 'info') {
    const now  = new Date();
    const time = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}:${now.getSeconds().toString().padStart(2,'0')}`;
    this._log.unshift({ time, msg, type });
    if (this._log.length > 80) this._log.pop();

    const c = document.getElementById('log-items');
    if (!c) return;
    c.innerHTML = this._log.slice(0, 18).map(e =>
      `<div class="log-item log-${e.type}"><span class="log-time">${e.time}</span>${e.msg}</div>`
    ).join('');
  }
}
