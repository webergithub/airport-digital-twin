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

export class TurnaroundPlan {
  constructor(totalSec = 60, startWallClock = null) {
    this.totalSec = totalSec;
    this.t = 0; // elapsed sim-seconds since arriving at gate
    this.startWallClock = startWallClock; // optional absolute ms at gate-arrival
    this.nodes = NODE_DEFS.map(d => ({
      id: d.id, label: d.label, side: d.side, vehicle: d.vehicle, color: d.color,
      start: d.start * totalSec,            // planned start (sec from gate-in)
      end:  (d.start + d.dur) * totalSec,   // planned end
      dur:   d.dur * totalSec,
      active: false, done: false, progress: 0,
      actualStart: null,                    // recorded sim-sec when it actually began
      actualEnd: null,                      // recorded sim-sec when it actually finished
    }));
  }

  update(dt) {
    this.t += dt;
    for (const n of this.nodes) {
      if (this.t < n.start)       { n.active = false; n.done = false; n.progress = 0; }
      else if (this.t >= n.end)   {
        if (n.actualStart === null) n.actualStart = n.start;  // started + finished same tick
        if (n.actualEnd === null)   n.actualEnd = this.t;     // record completion time
        n.active = false; n.done = true; n.progress = 1;
      } else {
        if (n.actualStart === null) n.actualStart = this.t;   // record first activation
        n.active = true; n.done = false; n.progress = (this.t - n.start) / n.dur;
      }
    }
  }

  get complete() { return this.t >= this.totalSec; }
  get overall()  { return Math.min(1, this.t / this.totalSec); }

  /** Sim-seconds of ground handling still remaining on the critical path.
   *  The last node (pushback tug) ends at totalSec, so this is the predicted
   *  time until the aircraft is ready to leave the gate — the basis for POBT. */
  remainingSec() { return Math.max(0, this.totalSec - this.t); }

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
