/**
 * TurnaroundPlan — the ground-handling state machine for one parked aircraft.
 *
 * A 13-node service schedule (上轮挡 → 牵引车推出) with overlapping windows.
 * start/dur are FRACTIONS of total turnaround time, so the whole choreography
 * scales with one scalar `totalSec`. This object is the SINGLE SOURCE OF TRUTH
 * for both the UI Gantt and the 3D service-vehicle triggers.
 *
 * `side` = where the vehicle parks relative to the parked aircraft (nose toward
 * −Z at the gate): nose / fwdR / aftR / aftL / underL / bridge.
 */

export const TN = {
  CHOCKS_ON:    'CHOCKS_ON',     // 上轮挡
  BRIDGE:       'BRIDGE',        // 接廊桥/客梯
  DEPLANE:      'DEPLANE',       // 下客
  UNLOAD_BAG:   'UNLOAD_BAG',    // 下行李
  CATERING:     'CATERING',      // 配餐
  WATER:        'WATER',         // 清水车
  LAV:          'LAV',           // 污水车
  GARBAGE:      'GARBAGE',       // 垃圾车
  REFUEL:       'REFUEL',        // 加油
  LOAD_BAG:     'LOAD_BAG',      // 上行李
  BOARD:        'BOARD',         // 上客
  CHOCKS_OFF:   'CHOCKS_OFF',    // 撤轮挡
  PUSHBACK_TUG: 'PUSHBACK_TUG',  // 牵引车推出
};

// id, label, start-fraction, duration-fraction, side, vehicle, color
export const NODE_DEFS = [
  { id: TN.CHOCKS_ON,    label: '上轮挡',     start: 0.00, dur: 0.05, side: 'nose',   vehicle: 'chocks',   color: '#9aa7b5' },
  { id: TN.BRIDGE,       label: '接廊桥/客梯', start: 0.03, dur: 0.07, side: 'bridge', vehicle: 'bridge',   color: '#4aa8ff' },
  { id: TN.DEPLANE,      label: '下客',       start: 0.10, dur: 0.18, side: 'bridge', vehicle: 'none',     color: '#2ecc71' },
  { id: TN.UNLOAD_BAG,   label: '下行李',     start: 0.10, dur: 0.22, side: 'aftR',   vehicle: 'baggage',  color: '#e67e22' },
  { id: TN.CATERING,     label: '配餐',       start: 0.20, dur: 0.30, side: 'fwdR',   vehicle: 'catering', color: '#f39c12' },
  { id: TN.WATER,        label: '清水车',     start: 0.18, dur: 0.16, side: 'aftL',   vehicle: 'water',    color: '#1abc9c' },
  { id: TN.LAV,          label: '污水车',     start: 0.34, dur: 0.16, side: 'aftL',   vehicle: 'lavatory', color: '#8a6d3b' },
  { id: TN.GARBAGE,      label: '垃圾车',     start: 0.30, dur: 0.12, side: 'fwdR',   vehicle: 'garbage',  color: '#7f8c8d' },
  { id: TN.REFUEL,       label: '加油',       start: 0.22, dur: 0.34, side: 'underL', vehicle: 'fuel',     color: '#e74c3c' },
  { id: TN.LOAD_BAG,     label: '上行李',     start: 0.50, dur: 0.22, side: 'aftR',   vehicle: 'baggage',  color: '#d35400' },
  { id: TN.BOARD,        label: '上客',       start: 0.62, dur: 0.26, side: 'bridge', vehicle: 'none',     color: '#27ae60' },
  { id: TN.CHOCKS_OFF,   label: '撤轮挡',     start: 0.90, dur: 0.05, side: 'nose',   vehicle: 'chocks',   color: '#9aa7b5' },
  { id: TN.PUSHBACK_TUG, label: '牵引车推出', start: 0.93, dur: 0.07, side: 'nose',   vehicle: 'tug',      color: '#f1c40f' },
];

// Precedence: services that physically cannot start before another finishes.
// (Boarding needs deplaning done; loading needs unloading done; the closers
// need everything else buttoned up.)
const PRECEDES = {
  BOARD: ['DEPLANE'],
  LOAD_BAG: ['UNLOAD_BAG'],
  CHOCKS_OFF: ['DEPLANE', 'UNLOAD_BAG', 'CATERING', 'WATER', 'LAV', 'GARBAGE', 'REFUEL', 'LOAD_BAG', 'BOARD'],
  PUSHBACK_TUG: ['CHOCKS_OFF'],
};

/** Right-skewed per-node duration multiplier — drawn when the node STARTS,
 *  not when the aircraft is created, so nothing knows the outcome in advance.
 *  Illustrative shape (not fitted to carrier data): mostly ~on-plan, a fat
 *  tail of overruns. */
function nodeFactor() {
  const r = Math.random();
  if (r < 0.55) return 0.9 + Math.random() * 0.2;    // 0.90–1.10 on plan
  if (r < 0.85) return 1.1 + Math.random() * 0.25;   // 1.10–1.35 slow
  return 1.35 + Math.random() * 0.45;                // 1.35–1.80 overrun tail
}

export class TurnaroundPlan {
  constructor(totalSec = 60, startWallClock = null) {
    this.totalSec = totalSec;              // the PLANNED total (drives TOBT)
    this.t = 0; // elapsed sim-seconds since arriving at gate
    this.realisedSec = null;               // set once, when handling completes
    this.startWallClock = startWallClock; // optional absolute ms at gate-arrival
    this.nodes = NODE_DEFS.map(d => ({
      id: d.id, label: d.label, side: d.side, vehicle: d.vehicle, color: d.color,
      start: d.start * totalSec,            // planned start (sec from gate-in)
      end:  (d.start + d.dur) * totalSec,   // planned end
      dur:   d.dur * totalSec,
      durActual: null,                      // drawn at activation — unknown before
      active: false, done: false, progress: 0,
      actualStart: null,                    // recorded sim-sec when it actually began
      actualEnd: null,                      // recorded sim-sec when it actually finished
    }));
    this._byId = new Map(this.nodes.map(n => [n.id, n]));
  }

  /** Advance realised execution. Each node runs on ITS OWN clock: it becomes
   *  eligible at its planned start once its predecessors are done, draws its
   *  realised duration at that moment (never before), and progresses at
   *  1/durActual — stretched by the service-condition factor the control
   *  layer supplies (weather slows outdoor handling). Plan-vs-actual variance
   *  is therefore real, and nothing in the twin knows the outcome up front. */
  update(dt, stretch = 1) {
    this.t += dt;
    let allDone = true;
    for (const n of this.nodes) {
      if (n.done) continue;
      const predsDone = (PRECEDES[n.id] || []).every(id => this._byId.get(id).done);
      if (!n.active) {
        allDone = false;
        if (this.t >= n.start && predsDone) {
          n.active = true;
          n.actualStart = +this.t.toFixed(1);
          n.durActual = n.dur * nodeFactor();
        }
        continue;
      }
      n.progress = Math.min(1, n.progress + dt / (n.durActual * Math.max(1, stretch)));
      if (n.progress >= 1) {
        n.active = false; n.done = true;
        n.actualEnd = +this.t.toFixed(1);
      } else allDone = false;
    }
    if (allDone && this.realisedSec === null) this.realisedSec = +this.t.toFixed(1);
  }

  get complete() { return this.realisedSec !== null; }
  get overall()  {
    const tot = this.nodes.reduce((s, n) => s + n.dur, 0);
    const got = this.nodes.reduce((s, n) => s + n.dur * (n.done ? 1 : n.progress), 0);
    return Math.min(1, got / tot);
  }

  /** Rough remaining-handling estimate (planned pace on the unfinished share).
   *  An estimate by construction — the realised durations are still unknown. */
  remainingSec() { return Math.max(0, (1 - this.overall) * this.totalSec); }

  getActiveNodes() { return this.nodes.filter(n => n.active); }

  /** Completed node timeline with start/end timestamps — for the run log. */
  timeline() {
    const base = this.startWallClock;
    return this.nodes.map(n => ({
      id: n.id, label: n.label,
      plannedStart: +n.start.toFixed(1), plannedEnd: +n.end.toFixed(1),
      actualStart: n.actualStart === null ? null : +n.actualStart.toFixed(1),
      actualEnd:   n.actualEnd   === null ? null : +n.actualEnd.toFixed(1),
      startedAt: (base != null && n.actualStart != null) ? base + n.actualStart * 1000 : null,
      endedAt:   (base != null && n.actualEnd   != null) ? base + n.actualEnd   * 1000 : null,
      done: n.done,
    }));
  }

  snapshot() {
    return {
      totalSec: this.totalSec, t: this.t, overall: this.overall,
      nodes: this.nodes.map(n => ({
        id: n.id, label: n.label, color: n.color,
        start: n.start, end: n.end, dur: n.dur,
        active: n.active, done: n.done, progress: n.progress,
        actualStart: n.actualStart, actualEnd: n.actualEnd,
      })),
    };
  }
}
