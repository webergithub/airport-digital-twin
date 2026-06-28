/**
 * AnalyticsEngine — the data-algorithm layer (数据算法层).
 *
 * Ingests the standard JSON snapshot stream from the data layer, derives
 * operational metrics (gate utilization, taxi-in time, departure wait, runway
 * throughput, gate overflow), and CONTINUOUSLY OPTIMIZES control parameters:
 * it tunes the arrival interval to hold gate utilization near a target band and
 * to avoid gate overflow. Every optimization decision is logged.
 *
 * It reads only the snapshot + event stream (no reaching into internals), and
 * acts back through the public control API (scheduler.setInterval).
 */
export class AnalyticsEngine {
  constructor(api, scheduler, opts = {}) {
    this._api = api;
    this._sch = scheduler;
    this._targetUtil = opts.targetUtil ?? 0.6;
    this._autoOpt    = opts.autoOptimize ?? true;
    this._optEvery   = opts.optimizeEverySec ?? 10;

    this._simT = 0;
    this._optTimer = 0;
    this._util = [];                 // rolling gate-utilization samples
    this._taxiIn = [];               // spawn → gate durations (sec)
    this._depWait = [];              // gate-in → takeoff durations (sec)
    this._noGate = 0;                // cumulative gate-overflow rejections
    this._noGateSeen = 0;
    this._timing = new Map();        // flightId → { spawn, gateIn, takeoff }
    this._decisions = [];            // optimization action log

    this._wireEvents();
  }

  setAutoOptimize(on) { this._autoOpt = !!on; }
  get autoOptimize() { return this._autoOpt; }

  _wireEvents() {
    this._api.on('flight_spawned', f => this._timing.set(f.id, { spawn: this._simT }));
    this._api.on('flight_arrived', f => {
      const r = this._timing.get(f.id);
      if (r) { r.gateIn = this._simT; if (r.spawn != null) this._push(this._taxiIn, r.gateIn - r.spawn); }
    });
    this._api.on('flight_takeoff', f => {
      const r = this._timing.get(f.id);
      if (r) { r.takeoff = this._simT; if (r.gateIn != null) this._push(this._depWait, r.takeoff - r.gateIn); }
    });
    this._api.on('flight_departed', f => this._timing.delete(f.id));
    this._api.on('no_gate', () => { this._noGate++; });
  }

  _push(arr, v) { if (v >= 0 && isFinite(v)) { arr.push(v); if (arr.length > 80) arr.shift(); } }
  _avg(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
  _recentAvg(a, n) { const s = a.slice(-n); return s.length ? s.reduce((x, y) => x + y, 0) / s.length : 0; }

  /** Ingest one snapshot (called each logic tick). */
  update(snapshot, dt) {
    this._simT = snapshot.simTimeSec;
    this._util.push(snapshot.stats.gateUtil);
    if (this._util.length > 1200) this._util.shift();

    this._optTimer += dt;
    if (this._autoOpt && this._optTimer >= this._optEvery) {
      this._optTimer = 0;
      this._optimize();
    }
  }

  _optimize() {
    const util = this._recentAvg(this._util, 200);
    const newOverflow = this._noGate - this._noGateSeen;
    this._noGateSeen = this._noGate;
    const cur = this._sch.getStats().interval;
    let next = cur;
    let reason = null;                               // structured → UI formats per language

    if (util > this._targetUtil + 0.15 || newOverflow > 0) {
      next = Math.min(60, cur + 3);                 // slow arrivals — congestion/overflow
      reason = newOverflow > 0
        ? { kind: 'Overflow', n: newOverflow }
        : { kind: 'High', p: (util * 100) | 0 };
    } else if (util < this._targetUtil - 0.18) {
      next = Math.max(8, cur - 2);                  // speed up — under-utilized
      reason = { kind: 'Low', p: (util * 100) | 0 };
    }

    if (next !== cur) {
      this._sch.setInterval(next);
      this._decisions.unshift({ simT: Math.round(this._simT), from: cur, to: next, reason });
      if (this._decisions.length > 30) this._decisions.pop();
    }
  }

  getMetrics() {
    return {
      gateUtil:   this._recentAvg(this._util, 200),
      avgTaxiIn:  this._avg(this._taxiIn),
      avgDepWait: this._avg(this._depWait),
      noGate:     this._noGate,
      throughput: this._api.getStats().throughput,
      interval:   this._sch.getStats().interval,
      targetUtil: this._targetUtil,
      completed:  { taxiIn: this._taxiIn.length, dep: this._depWait.length },
    };
  }

  getDecisions() { return this._decisions.slice(0, 10); }
}
