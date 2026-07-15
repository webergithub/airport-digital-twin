/**
 * SurfaceRadar — an ASDE-X / A-SMGCS surface-surveillance display.
 *
 * A top-down tower-radar picture of the movement area (the one map-based view
 * the twin lacked): the static airfield, plus every aircraft as a heading-
 * rotated target with a leader-lined data block (callsign, type, gate|runway,
 * groundspeed) and a fading track-history trail — as on FAA ASDE-X / ASSC and
 * Saab/Searidge digital-tower displays. Runway strips flash amber/red straight
 * from the RIMCAS safety net so a runway conflict reads on the map too.
 *
 * Consumes only the standard JSON snapshot + the safety-net stages; draws to a
 * Canvas2D. World coordinates match airport3d.js (runways z=-25/-42, taxiway
 * z=-10, apron z≈8, gates z=12; runway span x∈[-74,74]).
 */

const WX0 = -86, WX1 = 86, WZ0 = -48, WZ1 = 17;   // world window (movement area)
const TRAIL_MAX = 22;                              // track-history points per target
const MS_TO_KT = 1.94384;

const ROLE = {
  TAXIING_IN:  '#4aa8ff',   // arrival
  AT_GATE:     '#2ecc71',   // parked
  PUSHBACK:    '#f1c40f',   // pushback
  TAXIING_OUT: '#f39c12',   // taxi out
  HOLDING:     '#e0b040',   // holding short
  TAKEOFF:     '#ff6a4a',   // departing / rolling
};

export class SurfaceRadar {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.trails = new Map();      // flightId → [{x,z}, …]
  }

  /** Clear all track-history trails (used on a backward seek during replay). */
  resetTrails() { this.trails.clear(); }

  _fit() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return null;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    const s = Math.min(w / (WX1 - WX0), h / (WZ1 - WZ0));
    const ox = (w - (WX1 - WX0) * s) / 2, oy = (h - (WZ1 - WZ0) * s) / 2;
    return { dpr, w, h, s, ox, oy };
  }

  _tf(x, z, v) { return [(x - WX0) * v.s + v.ox, (z - WZ0) * v.s + v.oy]; }

  /** snapshot = api.getSnapshot(); stages = { RWY1: 0|1|2, RWY2: 0|1|2 }. */
  update(snapshot, stages) {
    const v = this._fit();
    if (!v) return;                          // panel collapsed / zero-size
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(v.dpr, v.dpr);
    ctx.clearRect(0, 0, v.w, v.h);
    ctx.fillStyle = '#0a0e14';
    ctx.fillRect(0, 0, v.w, v.h);

    this._drawAirfield(ctx, v, snapshot, stages || {});
    this._drawTrails(ctx, v, snapshot);
    this._drawTargets(ctx, v, snapshot, stages || {});
    ctx.restore();
  }

  _rect(ctx, v, x0, x1, z0, z1, fill) {
    const [ax, az] = this._tf(x0, z0, v), [bx, bz] = this._tf(x1, z1, v);
    ctx.fillStyle = fill;
    ctx.fillRect(ax, az, bx - ax, bz - az);
  }

  _drawAirfield(ctx, v, snapshot, stages) {
    // Runways (+ optional RIMCAS occupancy tint), taxiway, apron.
    for (const [key, rz] of [['RWY1', -25], ['RWY2', -42]]) {
      this._rect(ctx, v, -74, 74, rz - 3.5, rz + 3.5, '#191d24');
      const st = stages[key] || 0;
      if (st) {
        ctx.globalAlpha = st === 2 ? 0.45 : 0.28;
        this._rect(ctx, v, -74, 74, rz - 3.5, rz + 3.5, st === 2 ? '#ff2626' : '#ffb020');
        ctx.globalAlpha = 1;
      }
      // centreline dashes
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
      const [lx0, lz] = this._tf(-70, rz, v), [lx1] = this._tf(70, rz, v);
      ctx.beginPath(); ctx.moveTo(lx0, lz); ctx.lineTo(lx1, lz); ctx.stroke();
      ctx.setLineDash([]);
    }
    this._rect(ctx, v, -70, 70, -12.5, -7.5, '#141920');   // taxiway A (z=-10)
    this._rect(ctx, v, -36, 36, -2, 18, '#1b2431');        // apron
    // Gate stubs
    for (const g of snapshot.gates || []) {
      this._rect(ctx, v, g.x - 0.5, g.x + 0.5, 11.5, 13, g.wide ? '#3a5a86' : '#33405280');
    }
  }

  _drawTrails(ctx, v, snapshot) {
    const live = new Set(snapshot.flights.map(f => f.id));
    for (const id of [...this.trails.keys()]) if (!live.has(id)) this.trails.delete(id);
    for (const f of snapshot.flights) {
      if (f.state === 'DONE') continue;
      const arr = this.trails.get(f.id) || [];
      const last = arr[arr.length - 1];
      if (!last || Math.hypot(last.x - f.position.x, last.z - f.position.z) > 0.8) {
        arr.push({ x: f.position.x, z: f.position.z });
        if (arr.length > TRAIL_MAX) arr.shift();
        this.trails.set(f.id, arr);
      }
      if (arr.length < 2) continue;
      for (let i = 1; i < arr.length; i++) {
        const [ax, az] = this._tf(arr[i - 1].x, arr[i - 1].z, v);
        const [bx, bz] = this._tf(arr[i].x, arr[i].z, v);
        ctx.strokeStyle = `rgba(120,180,230,${(i / arr.length) * 0.5})`;
        ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(ax, az); ctx.lineTo(bx, bz); ctx.stroke();
      }
    }
  }

  _drawTargets(ctx, v, snapshot, stages) {
    ctx.font = '9px monospace';
    ctx.textBaseline = 'middle';
    for (const f of snapshot.flights) {
      if (f.state === 'DONE') continue;
      const [px, py] = this._tf(f.position.x, f.position.z, v);
      const held = f.holdingAtGate;
      let color = held ? '#b06bff' : (ROLE[f.state] || '#cfd8e3');
      // On a runway that is in RIMCAS conflict → force red.
      const onConflictRwy = (stages[f.runway] === 2) &&
        Math.abs(f.position.z - (f.runway === 'RWY1' ? -25 : -42)) < 4 && f.position.y < 2;
      if (onConflictRwy) color = '#ff3b3b';

      // Heading chevron: world dir (sin,cos) of headingDeg maps to screen (x→x, z→y).
      const hd = (f.headingDeg || 0) * Math.PI / 180;
      const ang = Math.atan2(Math.cos(hd), Math.sin(hd));   // screen-space angle
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(ang);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(5, 0); ctx.lineTo(-3.5, 3); ctx.lineTo(-1.5, 0); ctx.lineTo(-3.5, -3);
      ctx.closePath(); ctx.fill();
      ctx.restore();

      // Data block (callsign + type·gate|rwy·speed) with a short leader line.
      // Stagger the block into 3 vertical lanes (by callsign) so the tags of
      // aircraft queued close together on a runway/taxiway don't stack.
      const kt = Math.round((f.speedMps || 0) * MS_TO_KT);
      const loc = f.state === 'AT_GATE' || held ? (f.gate || '') : f.runway;
      const lane = (f.callsign.charCodeAt(f.callsign.length - 1) % 3) - 1;   // -1 / 0 / +1
      const bx = px + 8, by = py - 9 + lane * 10;
      ctx.strokeStyle = 'rgba(180,200,220,0.4)'; ctx.lineWidth = 0.75;
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(bx - 1, by + 4); ctx.stroke();
      ctx.fillStyle = color;
      ctx.fillText(f.callsign, bx, by);
      ctx.fillStyle = 'rgba(200,214,228,0.75)';
      ctx.fillText(`${f.type[0]}·${loc}·${kt}kt`, bx, by + 9);
    }
  }
}
