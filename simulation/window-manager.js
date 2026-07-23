/**
 * WindowManager — turns overlay panels into draggable / minimizable / resizable
 * windows. Each registered panel gets a title bar (drag handle + minimize
 * button) and a corner resize grip; its content is wrapped in a scrollable body.
 *
 * No DOM framework — plain pointer events. Panels keep their CSS start position
 * until first dragged/resized, then switch to explicit left/top/width/height.
 */
export class WindowManager {
  constructor() { this._z = 50; }

  register(el, opts = {}) {
    if (!el || el.classList.contains('win')) return el;
    el.classList.add('win');

    const srcTitle = el.querySelector(':scope > .panel-title, :scope > .log-title');
    const titleHTML = opts.title ?? srcTitle?.innerHTML ?? '窗口';
    const i18nKey = srcTitle?.dataset?.i18n;   // carry i18n so titles re-localize

    // Drop the original title element (the bar replaces it)
    el.querySelectorAll(':scope > .panel-title, :scope > .log-title').forEach(t => t.remove());

    // Title bar
    const bar = document.createElement('div');
    bar.className = 'win-bar';
    bar.innerHTML =
      `<span class="win-title"${i18nKey ? ` data-i18n="${i18nKey}"` : ''}>${titleHTML}</span>` +
      `<button class="win-min" title="最小化 / 还原" aria-label="minimize">—</button>`;

    // Wrap remaining content into a scrollable body
    const body = document.createElement('div');
    body.className = 'win-body';
    while (el.firstChild) body.appendChild(el.firstChild);

    el.appendChild(bar);
    el.appendChild(body);

    if (opts.resizable !== false) {
      const grip = document.createElement('div');
      grip.className = 'win-resize';
      el.appendChild(grip);
      this._bindResize(el, grip);
    }

    this._bindDrag(el, bar);
    this._bindMinimize(el, bar.querySelector('.win-min'));
    el.addEventListener('pointerdown', () => this._raise(el), true);

    if (opts.collapsed) el.classList.add('win-collapsed');
    if (opts.hidden) el.classList.add('win-hidden');
    return el;
  }

  /** Show / hide a registered window (dock entry point). */
  setVisible(el, on) {
    if (!el) return;
    el.classList.toggle('win-hidden', !on);
    if (on) { el.classList.remove('win-collapsed'); this._raise(el); }
    this._onVis && this._onVis(el, !!on);
  }
  isVisible(el) { return !!el && !el.classList.contains('win-hidden'); }
  /** Single visibility-change hook (the dock refreshes its active states here). */
  onVisibility(cb) { this._onVis = cb; }

  _raise(el) { el.style.zIndex = String(++this._z); }

  // Convert a CSS-positioned panel to explicit left/top so it can be moved.
  _detach(el) {
    if (el.dataset.winDetached) return;
    const r = el.getBoundingClientRect();
    el.style.left = r.left + 'px';
    el.style.top = r.top + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    el.style.transform = 'none';          // some panels use translateX(-50%)
    el.dataset.winDetached = '1';
  }

  _bindDrag(el, handle) {
    let sx, sy, ox, oy, dragging = false;
    const onMove = (e) => {
      if (!dragging) return;
      const nx = Math.max(0, Math.min(window.innerWidth - 60, ox + e.clientX - sx));
      const ny = Math.max(0, Math.min(window.innerHeight - 24, oy + e.clientY - sy));
      el.style.left = nx + 'px';
      el.style.top = ny + 'px';
    };
    const onUp = () => {
      dragging = false;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.win-min')) return;
      e.preventDefault();
      this._detach(el);
      this._raise(el);
      const r = el.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      dragging = true;
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
  }

  _bindResize(el, grip) {
    let sx, sy, ow, oh, resizing = false;
    const onMove = (e) => {
      if (!resizing) return;
      el.style.width = Math.max(170, ow + e.clientX - sx) + 'px';
      el.style.height = Math.max(70, oh + e.clientY - sy) + 'px';
    };
    const onUp = () => {
      resizing = false;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      this._detach(el);
      this._raise(el);
      el.classList.remove('win-collapsed');
      el.style.maxHeight = 'none';
      el.style.maxWidth = 'none';
      const r = el.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ow = r.width; oh = r.height;
      resizing = true;
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
  }

  _bindMinimize(el, btn) {
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const collapsed = el.classList.toggle('win-collapsed');
      btn.textContent = collapsed ? '▢' : '—';
    });
  }
}
