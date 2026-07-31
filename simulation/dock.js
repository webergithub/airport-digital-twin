/**
 * Dock — three edge rails (top / left / right) that group the overlay's windows
 * by role and toggle them. Each rail is a vertical/horizontal strip of small
 * buttons (icon only when collapsed, icon + name when expanded). Clicking a
 * button shows that window (and raises it); a ⚙ settings popover holds a global
 * "solo mode" — opening a window closes the others in the same rail.
 *
 * Windows are the panels registered with WindowManager (opts.hidden hides them
 * initially). The dock is the single entry point for showing/hiding them.
 */
import { t, onLangChange } from './i18n.js';

const LS_SOLO = 'airporttwin_dock_solo';
const LS_LABELS = 'airporttwin_dock_labels';
const LS_OPEN = 'airporttwin_dock_open';   // remembered window layout (which panels are open)
const LS_RAILS = 'airporttwin_dock_rails'; // per-rail collapsed state {top:0|1,left:0|1,right:0|1}
const LS_RAILVIS = 'airporttwin_dock_railvis'; // per-rail visibility (settings "close rail")
const LS_ICON = 'airporttwin_dock_icon';   // dock icon size in px (resize control)
const LS_RAILLBL = 'airporttwin_dock_raillbl'; // per-rail label expansion {top,left,right}

// Phone-sized viewport → dock becomes a bottom strip and panels become sheets.
const MOBILE_MQ = '(max-width: 860px)';
export const isMobile = () => window.matchMedia(MOBILE_MQ).matches;

// Window → { side, icon, i18n title key, i18n core-function key }. Order
// defines rail order. gate-detail is contextual (opened by clicking a gate)
// and intentionally absent.
export const DOCK_ITEMS = [
  // Top rail — Control（改变仿真的控制面板 + 运行指挥总览）
  { id: 'panel-apoc',      side: 'top',   icon: '🎛', key: 'panel.apoc',      d: 'dock.d.apoc' },
  { id: 'panel-config',    side: 'top',   icon: '✈', key: 'panel.config',    d: 'dock.d.config' },
  { id: 'panel-whatif',    side: 'top',   icon: '🌩', key: 'panel.whatif',    d: 'dock.d.whatif' },
  // Left rail — Operations（运行监控）
  { id: 'panel-flights',   side: 'left',  icon: '🛬', key: 'panel.flights',   d: 'dock.d.flights' },
  { id: 'panel-aman',      side: 'left',  icon: '🛫', key: 'panel.aman',      d: 'dock.d.aman' },
  { id: 'panel-slots',     side: 'left',  icon: '🎫', key: 'panel.slots',     d: 'dock.d.slots' },
  { id: 'panel-wasg',      side: 'left',  icon: '📅', key: 'panel.wasg',      d: 'dock.d.wasg' },
  { id: 'panel-turnwall',  side: 'left',  icon: '🕑', key: 'panel.turnwall',  d: 'dock.d.turnwall' },
  { id: 'panel-standplan', side: 'left',  icon: '🅿', key: 'panel.standplan', d: 'dock.d.standplan' },
  { id: 'panel-vdgs',      side: 'left',  icon: '🎯', key: 'panel.vdgs',      d: 'dock.d.vdgs' },
  { id: 'panel-radar',     side: 'left',  icon: '🛰', key: 'panel.radar',     d: 'dock.d.radar' },
  { id: 'panel-deice',     side: 'left',  icon: '❄', key: 'panel.deice',     d: 'dock.d.deice' },
  { id: 'panel-bags',      side: 'left',  icon: '🧳', key: 'panel.bags',      d: 'dock.d.bags' },
  { id: 'panel-gse',       side: 'left',  icon: '🚜', key: 'panel.gse',       d: 'dock.d.gse' },
  { id: 'panel-fuel',      side: 'left',  icon: '⛽', key: 'panel.fuel',      d: 'dock.d.fuel' },
  { id: 'panel-alcms',     side: 'left',  icon: '💡', key: 'panel.alcms',     d: 'dock.d.alcms' },
  { id: 'event-log',       side: 'left',  icon: '📝', key: 'panel.log',       d: 'dock.d.log' },
  // Right rail — Analysis & Safety（分析与安全）
  { id: 'panel-analytics', side: 'right', icon: '📈', key: 'panel.analytics', d: 'dock.d.analytics' },
  { id: 'panel-dcb',       side: 'right', icon: '📊', key: 'panel.dcb',       d: 'dock.d.dcb' },
  { id: 'panel-safetynet', side: 'right', icon: '🚨', key: 'panel.safetynet', d: 'dock.d.safetynet' },
  { id: 'panel-grf',       side: 'right', icon: '🛞', key: 'panel.grf',       d: 'dock.d.grf' },
  { id: 'panel-arff',      side: 'right', icon: '🚒', key: 'panel.arff',      d: 'dock.d.arff' },
  { id: 'panel-wildlife',  side: 'right', icon: '🦅', key: 'panel.wildlife',  d: 'dock.d.wildlife' },
  { id: 'panel-oooi',      side: 'right', icon: '📻', key: 'panel.oooi',      d: 'dock.d.oooi' },
  { id: 'panel-noise',     side: 'right', icon: '🔊', key: 'panel.noise',     d: 'dock.d.noise' },
  { id: 'panel-energy',    side: 'right', icon: '🔌', key: 'panel.energy',    d: 'dock.d.energy' },
  { id: 'panel-notam',     side: 'right', icon: '📰', key: 'panel.notam',     d: 'dock.d.notam' },
  { id: 'panel-replay',    side: 'right', icon: '🎞', key: 'panel.replay',    d: 'dock.d.replay' },
];

// Panel titles carry a leading emoji (window bars reuse them); the dock button
// already shows the icon, so strip it from the label to avoid doubling up.
const clean = (s) => s.replace(/^[^\p{L}\p{N}]+\s*/u, '');

const SIDE_TITLE = { top: 'dock.control', left: 'dock.ops', right: 'dock.analysis' };

export class Dock {
  constructor(wm) {
    this._wm = wm;
    this._btns = new Map();   // id → button element
    this._solo = false;
    this._expanded = false;   // default: macOS-style compact icon rails; ⇔ expands to detail cards
    this._railMin = { top: false, left: false, right: false };   // per-rail collapse (dock minimize)
    this._railVis = { top: true, left: true, right: true };      // per-rail visibility (dock close)
    this._railLbl = { top: false, left: false, right: false };   // per-rail full-name expansion
    this._iconPx = 21;                                           // dock icon size (dock resize)
    try {
      this._solo = localStorage.getItem(LS_SOLO) === '1';
      this._expanded = localStorage.getItem(LS_LABELS) === '1';
      const rm = JSON.parse(localStorage.getItem(LS_RAILS) || 'null');
      if (rm) for (const k of ['top', 'left', 'right']) this._railMin[k] = !!rm[k];
      const rv = JSON.parse(localStorage.getItem(LS_RAILVIS) || 'null');
      if (rv) for (const k of ['top', 'left', 'right']) this._railVis[k] = rv[k] !== 0;
      const rl = JSON.parse(localStorage.getItem(LS_RAILLBL) || 'null');
      if (rl) for (const k of ['top', 'left', 'right']) this._railLbl[k] = !!rl[k];
      const ip = parseInt(localStorage.getItem(LS_ICON) || '21', 10);
      if (ip >= 14 && ip <= 30) this._iconPx = ip;
    } catch (e) {}
    this._build();
    this._applySavedLayout();
    // Keep dock button active-states in sync however a window is shown/hidden.
    wm.onVisibility((el) => { this._refresh(); this._saveLayout(); });
    onLangChange(() => this._relabel());
  }

  /** Restore the remembered open-set over the registration defaults, if any. */
  _applySavedLayout() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(LS_OPEN) || 'null'); } catch (e) {}
    if (!Array.isArray(saved)) { this._refresh(); return; }
    // Phone sheets stack — restore at most the first remembered window there.
    const want = new Set(isMobile() ? saved.slice(0, 1) : saved);
    for (const it of DOCK_ITEMS) {
      const el = document.getElementById(it.id);
      if (el) this._wm.setVisible(el, want.has(it.id));
    }
    this._refresh();
  }

  _saveLayout() {
    const open = DOCK_ITEMS.filter(it => {
      const el = document.getElementById(it.id);
      return el && this._wm.isVisible(el);
    }).map(it => it.id);
    try { localStorage.setItem(LS_OPEN, JSON.stringify(open)); } catch (e) {}
  }

  _build() {
    const root = document.createElement('div');
    root.id = 'dock-root';
    root.className = this._expanded ? 'dock-expanded' : '';
    root.style.setProperty('--dock-ic', this._iconPx + 'px');
    this._rails = {};
    // Edge panels shift outward to clear the wider detail-card rails.
    document.body.classList.toggle('dock-wide', this._expanded);

    for (const side of ['top', 'left', 'right']) {
      const rail = document.createElement('div');
      rail.className = `dock-rail dock-${side}`;
      if (this._railMin[side]) rail.classList.add('dock-rail-min');
      if (!this._railVis[side]) rail.classList.add('dock-rail-off');
      if (this._railLbl[side]) { rail.classList.add('rail-labels');
        document.body.classList.add(`rail-${side}-labels`); }
      this._rails[side] = rail;
      const items = DOCK_ITEMS.filter(it => it.side === side);

      // Collapse chip — minimizes the whole rail down to this one button.
      const chip = document.createElement('button');
      chip.className = 'dock-chip';
      chip.title = t('dock.railMin');
      chip.dataset.i18nTitle = 'dock.railMin';
      chip.textContent = this._chipArrow(side);
      chip.addEventListener('click', () => this._toggleRail(side, rail, chip));
      rail.appendChild(chip);

      // Label-expansion chip: expands THIS rail's full names toward its open
      // side (left rail → rightward, right rail → leftward, top rail → down).
      const lch = document.createElement('button');
      lch.className = 'dock-chip dock-lblchip';
      lch.title = t('dock.railLbl');
      lch.textContent = this._lblArrow(side);
      lch.addEventListener('click', () => this._toggleRailLabels(side, rail, lch));
      rail.appendChild(lch);

      // group header (a role label; only visible when expanded)
      const head = document.createElement('div');
      head.className = 'dock-head';
      head.dataset.i18n = SIDE_TITLE[side];
      head.textContent = t(SIDE_TITLE[side]);
      rail.appendChild(head);

      for (const it of items) {
        const b = document.createElement('button');
        b.className = 'dock-btn';
        b.dataset.win = it.id;
        b.innerHTML =
          `<span class="dock-ic">${it.icon}</span>` +
          `<span class="dock-lbl">${clean(t(it.key))}</span>` +
          `<span class="dock-dsc">${t(it.d)}</span>`;
        b.title = `${clean(t(it.key))} — ${t(it.d)}`;
        b.addEventListener('click', () => this._toggleWin(it.id, side));
        rail.appendChild(b);
        this._btns.set(it.id, b);
      }

      // Top rail also carries the expand toggle + settings gear.
      if (side === 'top') {
        const spacer = document.createElement('div'); spacer.className = 'dock-spacer'; rail.appendChild(spacer);
        const exp = document.createElement('button');
        exp.className = 'dock-btn dock-util'; exp.id = 'dock-expand';
        exp.innerHTML = `<span class="dock-ic">⇔</span><span class="dock-lbl" data-i18n="dock.expand">${t('dock.expand')}</span>`;
        exp.title = t('dock.expand');
        exp.addEventListener('click', () => this._toggleExpand());
        rail.appendChild(exp);

        const gear = document.createElement('button');
        gear.className = 'dock-btn dock-util'; gear.id = 'dock-gear';
        gear.innerHTML = `<span class="dock-ic">⚙</span><span class="dock-lbl" data-i18n="dock.settings">${t('dock.settings')}</span>`;
        gear.title = t('dock.settings');
        gear.addEventListener('click', (e) => { e.stopPropagation(); this._toggleSettings(); });
        rail.appendChild(gear);
      }
      root.appendChild(rail);
    }

    // Settings popover
    const pop = document.createElement('div');
    pop.id = 'dock-settings';
    pop.style.display = 'none';
    pop.innerHTML =
      `<button id="dock-set-close" class="dock-set-close" title="✕">✕</button>` +
      `<label class="dock-set-row"><input type="checkbox" id="dock-solo"${this._solo ? ' checked' : ''}>` +
      `<span data-i18n="dock.solo">${t('dock.solo')}</span></label>` +
      `<div class="dock-set-h" data-i18n="dock.rails">${t('dock.rails')}</div>` +
      ['top', 'left', 'right'].map(sd =>
        `<label class="dock-set-row"><input type="checkbox" class="dock-railvis" data-side="${sd}"` +
        `${this._railVis[sd] ? ' checked' : ''}><span data-i18n="${SIDE_TITLE[sd]}">${t(SIDE_TITLE[sd])}</span></label>`).join('') +
      `<div class="dock-set-h" data-i18n="dock.iconSize">${t('dock.iconSize')}</div>` +
      `<input type="range" id="dock-icsz" class="dock-icsz" min="14" max="30" step="1" value="${this._iconPx}">`;
    root.appendChild(pop);

    document.body.appendChild(root);
    this._root = root; this._pop = pop;
    pop.querySelector('#dock-set-close').addEventListener('click', () => { pop.style.display = 'none'; });
    pop.querySelectorAll('.dock-railvis').forEach(cb => cb.addEventListener('change', (e) => {
      const sd = e.target.dataset.side;
      this._railVis[sd] = e.target.checked;
      this._rails[sd].classList.toggle('dock-rail-off', !e.target.checked);
      try { localStorage.setItem(LS_RAILVIS, JSON.stringify(
        { top: +this._railVis.top, left: +this._railVis.left, right: +this._railVis.right })); } catch (er) {}
    }));
    pop.querySelector('#dock-icsz').addEventListener('input', (e) => {
      this._iconPx = +e.target.value;
      this._root.style.setProperty('--dock-ic', this._iconPx + 'px');
      try { localStorage.setItem(LS_ICON, String(this._iconPx)); } catch (er) {}
    });
    pop.querySelector('#dock-solo').addEventListener('change', (e) => {
      this._solo = e.target.checked;
      try { localStorage.setItem(LS_SOLO, this._solo ? '1' : '0'); } catch (er) {}
    });
    // click-away closes the settings popover
    document.addEventListener('pointerdown', (e) => {
      if (this._pop.style.display !== 'none' && !this._pop.contains(e.target) &&
          e.target.id !== 'dock-gear' && !e.target.closest('#dock-gear')) {
        this._pop.style.display = 'none';
      }
    });
    this._refresh();
  }

  _toggleWin(id, side) {
    const el = document.getElementById(id);
    if (!el) return;
    const show = !this._wm.isVisible(el);
    // Phone layout shows panels as full-width bottom sheets — only one fits, so
    // opening a window always closes the rest. Desktop solo mode is per-rail.
    if (show && (this._solo || isMobile())) {
      for (const it of DOCK_ITEMS) {
        if (it.id === id) continue;
        if (!isMobile() && it.side !== side) continue;
        const o = document.getElementById(it.id);
        if (o && this._wm.isVisible(o)) this._wm.setVisible(o, false);
      }
    }
    this._wm.setVisible(el, show);
  }

  /** Chip arrow points toward the edge when open (collapse) and inward when minimized (restore). */
  _chipArrow(side) {
    const min = this._railMin[side];
    if (side === 'top')   return min ? '▾' : '▴';
    if (side === 'left')  return min ? '▸' : '◂';
    return min ? '◂' : '▸';
  }

  _lblArrow(side) {
    const on = this._railLbl[side];
    if (side === 'top')  return on ? '⇡' : '⇣';
    if (side === 'left') return on ? '⇠' : '⇢';
    return on ? '⇢' : '⇠';
  }

  _toggleRailLabels(side, rail, chip) {
    this._railLbl[side] = !this._railLbl[side];
    // Showing names implies the rail itself must be open.
    if (this._railLbl[side] && this._railMin[side]) {
      const minChip = rail.querySelector('.dock-chip:not(.dock-lblchip)');
      this._toggleRail(side, rail, minChip);
    }
    rail.classList.toggle('rail-labels', this._railLbl[side]);
    document.body.classList.toggle(`rail-${side}-labels`, this._railLbl[side]);
    chip.textContent = this._lblArrow(side);
    try { localStorage.setItem(LS_RAILLBL, JSON.stringify(
      { top: +this._railLbl.top, left: +this._railLbl.left, right: +this._railLbl.right })); } catch (e) {}
  }

  _toggleRail(side, rail, chip) {
    this._railMin[side] = !this._railMin[side];
    rail.classList.toggle('dock-rail-min', this._railMin[side]);
    chip.textContent = this._chipArrow(side);
    try { localStorage.setItem(LS_RAILS, JSON.stringify(
      { top: +this._railMin.top, left: +this._railMin.left, right: +this._railMin.right })); } catch (e) {}
  }

  _toggleExpand() {
    this._expanded = !this._expanded;
    this._root.classList.toggle('dock-expanded', this._expanded);
    document.body.classList.toggle('dock-wide', this._expanded);
    try { localStorage.setItem(LS_LABELS, this._expanded ? '1' : '0'); } catch (e) {}
  }

  _toggleSettings() {
    this._pop.style.display = this._pop.style.display === 'none' ? 'block' : 'none';
  }

  _refresh() {
    for (const [id, b] of this._btns) {
      const el = document.getElementById(id);
      b.classList.toggle('dock-active', !!el && this._wm.isVisible(el));
    }
  }

  _relabel() {
    this._root.querySelectorAll('[data-i18n]').forEach(el => {
      el.textContent = t(el.dataset.i18n);
    });
    const exp = this._root.querySelector('#dock-expand');
    if (exp) exp.title = t('dock.expand');
    const gear = this._root.querySelector('#dock-gear');
    if (gear) gear.title = t('dock.settings');
    this._root.querySelectorAll('.dock-chip:not(.dock-lblchip)').forEach(c => { c.title = t('dock.railMin'); });
    this._root.querySelectorAll('.dock-lblchip').forEach(c => { c.title = t('dock.railLbl'); });
    this._btns.forEach((b, id) => {
      const it = DOCK_ITEMS.find(x => x.id === id);
      if (!it) return;
      b.querySelector('.dock-lbl').textContent = clean(t(it.key));
      b.querySelector('.dock-dsc').textContent = t(it.d);
      b.title = `${clean(t(it.key))} — ${t(it.d)}`;
    });
  }
}
