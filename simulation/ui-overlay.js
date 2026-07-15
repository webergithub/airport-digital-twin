/**
 * HTML UI overlay — config panel, flight board, stats bar, event log.
 * Panels are wrapped as draggable / minimizable / resizable windows.
 */

import { WindowManager } from './window-manager.js';
import { t, tf } from './i18n.js';

export class UIOverlay {
  constructor(container, onAction) {
    this._cb    = onAction;
    this._log   = [];
    this._root  = this._build(container);
    this._cfg   = { arrivalInterval: 25, runways: 2, gateCount: 6, bridgeCount: 4 };

    // Make the overlay panels into movable windows (titles read from each panel).
    this._wm = new WindowManager();
    ['panel-config', 'panel-flights', 'event-log', 'panel-gate-detail', 'panel-analytics', 'panel-turnwall']
      .forEach(id => this._wm.register(document.getElementById(id)));
    this._wm.register(document.getElementById('panel-standplan'), { collapsed: true });
    this._wm.register(document.getElementById('panel-oooi'), { collapsed: true });
    this._wm.register(document.getElementById('panel-safetynet'), { collapsed: true });
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
    const set = (id, disp) => { const e = document.getElementById(id); if (e) e.style.display = disp; };
    const gd = document.getElementById('gd-gate'); if (gd) gd.textContent = gateId;
    set('panel-gate-detail', 'flex');   // .win uses flex layout
    set('panel-config', 'none');
    set('panel-turnwall', 'none');      // wall shares the top-center zone with ← exit
    this.showExitButton();
  }

  exitGateDetail() {
    const set = (id, disp) => { const e = document.getElementById(id); if (e) e.style.display = disp; };
    set('panel-gate-detail', 'none');
    set('panel-config', 'flex');
    set('panel-turnwall', '');          // restore stylesheet default
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
