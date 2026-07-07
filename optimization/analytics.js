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

// A320-class idle fuel burn, both engines (kg per engines-on second) — used to
// estimate fuel saved by DMAN gate holds (waiting engines-off instead of in queue).
const IDLE_BURN_KG_S = 0.2;

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
    this._otp = { onTime: 0, total: 0 }; // A-CDM readiness punctuality (ARDT vs TOBT)
    this._turn = [];                 // actual turnaround durations (AOBT − AIBT)
    this._taxiOut = [];              // engines-on taxi-out durations (AOBT → ATOT)
    this._gateHold = [];             // engines-off DMAN holds (ARDT → TSAT), rolling
    this._holdCount = 0;             // cumulative count of metered holds
    this._fuelKg = 0;                // estimated fuel saved by metering holds
    this._alloc = { total: 0, contact: 0, match: 0 }; // stand-allocation quality
    // FAA ASPM-style per-runway taxi times: taxi-out (OUT→OFF, AOBT→ATOT) and
    // taxi-in (ON→IN, ALDT→AIBT — wheels-on to in-block), for median/P90.
    this._aspm = { RWY1: { out: [], in: [] }, RWY2: { out: [], in: [] } };

    this._wireEvents();
  }

  setAutoOptimize(on) { this._autoOpt = !!on; }
  get autoOptimize() { return this._autoOpt; }

  _wireEvents() {
    this._api.on('flight_spawned', f => {
      this._timing.set(f.id, { spawn: this._simT });
      const s = f.stand;                         // stand-allocation quality (RMS)
      if (s) { this._alloc.total++; if (s.contact) this._alloc.contact++; if (s.classMatch) this._alloc.match++; }
    });
    this._api.on('flight_arrived', f => {
      const r = this._timing.get(f.id);
      if (r) { r.gateIn = this._simT; if (r.spawn != null) this._push(this._taxiIn, r.gateIn - r.spawn); }
      const m = f.milestones, a = this._aspm[f.runway];   // ASPM taxi-in (ON→IN)
      if (m && m.ALDT && m.AIBT && a) this._push(a.in, m.AIBT.sim - m.ALDT.sim);
    });
    this._api.on('flight_takeoff', f => {
      const r = this._timing.get(f.id);
      if (r) { r.takeoff = this._simT; if (r.gateIn != null) this._push(this._depWait, r.takeoff - r.gateIn); }
      // A-CDM punctuality: was the flight READY (ARDT) by its target off-block
      // (TOBT)? Measuring readiness rather than AOBT keeps the KPI about
      // ground-handling performance — a metered gate hold (controlled delay
      // between ARDT and TSAT) does not count against punctuality.
      const m = f.milestones;
      if (m && m.ARDT && m.TOBT && m.AIBT) {
        const planned = m.TOBT.sim - m.AIBT.sim;
        const tol = Math.max(6, 0.1 * planned);        // ~10% ≈ 15-min A-CDM window
        this._otp.total++;
        if (m.ARDT.sim - m.TOBT.sim <= tol) this._otp.onTime++;
      }
      if (m && m.AOBT && m.AIBT) this._push(this._turn, m.AOBT.sim - m.AIBT.sim);
      // Surface-metering benefits (ATD-2 style): engines-on taxi-out time and
      // engines-off gate holds, converted to an idle-burn fuel estimate.
      if (m && m.AOBT && m.ATOT) {
        this._push(this._taxiOut, m.ATOT.sim - m.AOBT.sim);
        const a = this._aspm[f.runway];                  // ASPM taxi-out (OUT→OFF)
        if (a) this._push(a.out, m.ATOT.sim - m.AOBT.sim);
      }
      if (m && m.ARDT && m.TSAT) {
        const held = m.TSAT.sim - m.ARDT.sim;
        if (held > 0.5) {
          this._push(this._gateHold, held);
          this._holdCount++;
          this._fuelKg += held * IDLE_BURN_KG_S;
        }
      }
    });
    this._api.on('flight_departed', f => this._timing.delete(f.id));
    this._api.on('no_gate', () => { this._noGate++; });
  }

  _push(arr, v) { if (v >= 0 && isFinite(v)) { arr.push(v); if (arr.length > 80) arr.shift(); } }
  _avg(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
  _recentAvg(a, n) { const s = a.slice(-n); return s.length ? s.reduce((x, y) => x + y, 0) / s.length : 0; }
  // Nearest-rank percentile (p in 0..1) over a numeric array.
  _pct(a, p) {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))];
  }

  /** FAA ASPM-style taxi-time table: per-runway taxi-out/taxi-in median + P90. */
  getAspm() {
    const stat = (arr) => ({
      med: +this._pct(arr, 0.5).toFixed(0), p90: +this._pct(arr, 0.9).toFixed(0), n: arr.length,
    });
    const out = {};
    for (const rwy of Object.keys(this._aspm)) {
      out[rwy] = { taxiOut: stat(this._aspm[rwy].out), taxiIn: stat(this._aspm[rwy].in) };
    }
    return out;
  }

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
      otp:        this._otp.total ? this._otp.onTime / this._otp.total : 1,
      otpCount:   this._otp.total,
      avgTurn:    this._avg(this._turn),
      avgTaxiOut: this._avg(this._taxiOut),
      gateHold:   this._avg(this._gateHold),
      meterHolds: this._holdCount,
      fuelSavedKg: this._fuelKg,
      standContactPct: this._alloc.total ? this._alloc.contact / this._alloc.total : 1,
      standFitPct:     this._alloc.total ? this._alloc.match / this._alloc.total : 1,
      standRemote:     this._alloc.total - this._alloc.contact,
      standCount:      this._alloc.total,
      completed:  { taxiIn: this._taxiIn.length, dep: this._depWait.length },
    };
  }

  getDecisions() { return this._decisions.slice(0, 10); }
}
