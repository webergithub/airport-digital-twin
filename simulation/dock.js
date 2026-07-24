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
  { id: 'panel-turnwall',  side: 'left',  icon: '🕑', key: 'panel.turnwall',  d: 'dock.d.turnwall' },
  { id: 'panel-standplan', side: 'left',  icon: '🅿', key: 'panel.standplan', d: 'dock.d.standplan' },
  { id: 'panel-radar',     side: 'left',  icon: '🛰', key: 'panel.radar',     d: 'dock.d.radar' },
  { id: 'panel-deice',     side: 'left',  icon: '❄', key: 'panel.deice',     d: 'dock.d.deice' },
  { id: 'event-log',       side: 'left',  icon: '📝', key: 'panel.log',       d: 'dock.d.log' },
  // Right rail — Analysis & Safety（分析与安全）
  { id: 'panel-analytics', side: 'right', icon: '📈', key: 'panel.analytics', d: 'dock.d.analytics' },
  { id: 'panel-dcb',       side: 'right', icon: '📊', key: 'panel.dcb',       d: 'dock.d.dcb' },
  { id: 'panel-safetynet', side: 'right', icon: '🚨', key: 'panel.safetynet', d: 'dock.d.safetynet' },
  { id: 'panel-oooi',      side: 'right', icon: '📻', key: 'panel.oooi',      d: 'dock.d.oooi' },
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
    this._expanded = true;    // default: detail cards (big icon + name + core function); ⇔ collapses to icons
    try {
      this._solo = localStorage.getItem(LS_SOLO) === '1';
      this._expanded = localStorage.getItem(LS_LABELS) !== '0';
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
    const want = new Set(saved);
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
    // Edge panels shift outward to clear the wider detail-card rails.
    document.body.classList.toggle('dock-wide', this._expanded);

    for (const side of ['top', 'left', 'right']) {
      const rail = document.createElement('div');
      rail.className = `dock-rail dock-${side}`;
      const items = DOCK_ITEMS.filter(it => it.side === side);
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
      `<label class="dock-set-row"><input type="checkbox" id="dock-solo"${this._solo ? ' checked' : ''}>` +
      `<span data-i18n="dock.solo">${t('dock.solo')}</span></label>`;
    root.appendChild(pop);

    document.body.appendChild(root);
    this._root = root; this._pop = pop;
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
    if (show && this._solo) {
      // Solo: close every other window in the same rail before opening this one.
      for (const it of DOCK_ITEMS) {
        if (it.side === side && it.id !== id) {
          const o = document.getElementById(it.id);
          if (o && this._wm.isVisible(o)) this._wm.setVisible(o, false);
        }
      }
    }
    this._wm.setVisible(el, show);
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
    this._btns.forEach((b, id) => {
      const it = DOCK_ITEMS.find(x => x.id === id);
      if (!it) return;
      b.querySelector('.dock-lbl').textContent = clean(t(it.key));
      b.querySelector('.dock-dsc').textContent = t(it.d);
      b.title = `${clean(t(it.key))} — ${t(it.d)}`;
    });
  }
}
