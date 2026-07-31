/**
 * SlotCoordination — declared capacity & slot coordination (IATA WASG).
 *
 * The SEASONAL half of airport capacity, and a different object from the
 * day-of-operation ATFM/CTOT layer the twin already models in slot-monitor.js:
 *
 *   Months ahead, the competent authority DECLARES coordination parameters
 *   under Art. 6 of Council Reg. (EEC) 95/93 — a rolling hourly (R60) triple of
 *   arrival / departure / total movement limits PLUS a sub-hourly (R10)
 *   smoothing triple that stops the hour being flown as one burst. An
 *   independent coordinator then allocates every movement a SLOT against that
 *   table, where an arrival slot is a planned ON-BLOCK time (SIBT) and a
 *   departure slot a planned OFF-BLOCK time (SOBT). After the season the
 *   coordinator runs slot monitoring (WASG Annex 12.9): off-slot duration per
 *   movement, screened by MEAN versus STANDARD DEVIATION — a large mean with a
 *   small spread is structural slot misuse, a large spread is just operations.
 *
 * The declaration itself is chosen by a delay criterion: raise the candidate
 * rate, simulate, and take the highest rate whose average queueing delay stays
 * under an accepted bound (UK convention 10 min; ACI quotes 5-12). So the twin
 * can finally ask a question no existing panel can: WAS THE DECLARED CAPACITY
 * SET TOO HIGH?
 *
 * The twin previously had no plan at all — arrivals are spawned stochastically
 * with no SOBT/SIBT — so nothing on screen could be compared against intent.
 * This module supplies that missing planning horizon.
 *
 * Deliberately NOT claimed:
 *   • no allocation to named airlines, no historic precedence / grandfathering
 *     / 80-20 use-it-or-lose-it, no SSIM SCR/SMA/SAL message exchange;
 *   • it never re-times a flight — the plan is advisory and the module measures
 *     the gap, exactly as post-season monitoring does;
 *   • parameters are scaled to this twin's compressed timescale, not real hours.
 */

// Windows scaled to the twin's timescale, preserving the real 6:1 R60:R10 ratio.
const R60_SEC = 600;
const R10_SEC = 100;

// Declared coordination parameters, shaped after the IAA's Dublin Winter 2026
// decision: sub-limits deliberately SUM ABOVE the total, so the total binds
// first, and the single-runway table is materially tighter than the dual.
// Calibrated against this twin's measured demand (~34 movements/600 s,
// ~5.7/100 s dual) so the declaration binds at peaks rather than constantly.
const PARAMS = {
  2: { r60: { total: 36, arr: 22, dep: 22 }, r10: { total: 8, arr: 5, dep: 5 } },
  1: { r60: { total: 26, arr: 16, dep: 16 }, r10: { total: 6, arr: 4, dep: 4 } },
};

// A slot is a planned ON-BLOCK / OFF-BLOCK time, NOT a landing time — so the
// filed arrival time is the ETA plus a scheduled taxi-in allowance. Omitting it
// biases every arrival late by exactly the taxi-in, which the Annex 12.9 screen
// then (correctly) reports as structural misuse — of the schedule, not the
// airline. Measured mean taxi-in in this twin is ~50 s.
const SCHED_TAXI_IN_SEC = 50;
const SCHED_GROUND_SEC = 70;   // planned ground time filed with the schedule
const DELAY_CRIT_SEC   = 60;   // the 10-minute delay criterion on this timescale
const MISUSE_MEAN_SEC  = 45;   // Annex 12.9 screen: mean beyond this…
const MISUSE_SD_RATIO  = 0.8;  // …with spread below mean×this ⇒ structural

export class SlotCoordination {
  constructor() {
    this._plan = new Map();     // flightId → { sibt, sobt, refused }
    this._seen = new Set();
    this._slots = [];           // allocated slot times: { t, kind }
    this._devs = [];            // off-slot durations (both kinds)
    this._results = [];
    this._refused = 0;
    this._runways = 2;
    this._lastSim = 0;
  }

  _params() { return PARAMS[this._runways] || PARAMS[2]; }

  /** Movements already allocated inside a window ending at t. */
  _count(t, span, kind) {
    let total = 0, arr = 0, dep = 0;
    for (const s of this._slots) {
      if (s.t > t - span && s.t <= t + span) {
        total++; if (s.kind === 'arr') arr++; else dep++;
      }
    }
    return { total, arr, dep };
  }

  /** Would granting `kind` at time t bust any declared limit? */
  _fits(t, kind) {
    const p = this._params();
    for (const [span, lim] of [[R60_SEC / 2, p.r60], [R10_SEC / 2, p.r10]]) {
      const c = this._count(t, span, kind);
      if (c.total + 1 > lim.total) return false;
      if (kind === 'arr' && c.arr + 1 > lim.arr) return false;
      if (kind === 'dep' && c.dep + 1 > lim.dep) return false;
    }
    return true;
  }

  update(snapshot) {
    const now = snapshot.simTimeSec;
    this._lastSim = now;
    this._runways = snapshot.activeRunways || 2;

    for (const f of snapshot.flights) {
      // ── Seasonal allocation: an airline files an arrival + its departure with
      //    a planned ground time; the coordinator grants both or refuses.
      if (!this._seen.has(f.id)) {
        this._seen.add(f.id);
        const sibt = +((f.eta != null ? f.eta : now) + SCHED_TAXI_IN_SEC).toFixed(1);
        const sobt = +(sibt + SCHED_GROUND_SEC).toFixed(1);
        if (this._fits(sibt, 'arr') && this._fits(sobt, 'dep')) {
          this._slots.push({ t: sibt, kind: 'arr' }, { t: sobt, kind: 'dep' });
          this._plan.set(f.id, { sibt, sobt, refused: false, cs: f.callsign });
        } else {
          this._refused++;
          this._plan.set(f.id, { sibt: null, sobt: null, refused: true, cs: f.callsign });
        }
      }

      // ── Post-season monitoring: off-slot duration at the planned milestones.
      const p = this._plan.get(f.id);
      if (!p || p.refused) continue;
      const ms = f.milestones || {};
      if (ms.AIBT && !p.arrDone) {
        p.arrDone = true;
        this._record(p.cs, 'arr', ms.AIBT.sim - p.sibt, now);
      }
      if (ms.AOBT && !p.depDone) {
        p.depDone = true;
        this._record(p.cs, 'dep', ms.AOBT.sim - p.sobt, now);
      }
    }

    // Keep the allocation ledger bounded to the live planning horizon.
    const cutoff = now - R60_SEC * 3;
    if (this._slots.length > 600) this._slots = this._slots.filter(s => s.t > cutoff);
  }

  _record(cs, kind, dev, now) {
    const d = +dev.toFixed(1);
    this._devs.push(d);
    if (this._devs.length > 500) this._devs.shift();
    this._results.push({ cs, kind, devSec: d, onSlot: Math.abs(d) <= 15, sim: +now.toFixed(1) });
    if (this._results.length > 300) this._results.shift();
  }

  getStatus() {
    const p = this._params();
    const now = this._lastSim;
    const live = {
      r60: this._count(now, R60_SEC / 2, null),
      r10: this._count(now, R10_SEC / 2, null),
    };
    const n = this._devs.length;
    const mean = n ? this._devs.reduce((a, b) => a + b, 0) / n : 0;
    const sd = n > 1
      ? Math.sqrt(this._devs.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) : 0;
    const onSlot = this._results.filter(r => r.onSlot).length;

    // WASG Annex 12.9 screen and the delay-based capacity verdict.
    const misuse = n >= 10 && Math.abs(mean) > MISUSE_MEAN_SEC && sd < Math.abs(mean) * MISUSE_SD_RATIO;
    const verdict = n < 10 ? 'pending'
                  : mean > DELAY_CRIT_SEC ? 'overDeclared'
                  : mean < DELAY_CRIT_SEC * 0.35 ? 'headroom' : 'balanced';
    // Level follows from how hard the declaration actually binds.
    const level = this._refused > 0 ? 3
                : live.r60.total >= p.r60.total * 0.8 ? 2 : 1;

    return {
      runways: this._runways,
      params: p, r60Sec: R60_SEC, r10Sec: R10_SEC,
      live,
      level,
      allocated: this._slots.length,
      refused: this._refused,
      closed: this._results.length,
      onSlot,
      adherencePct: this._results.length ? Math.round(onSlot / this._results.length * 100) : null,
      meanDevSec: +mean.toFixed(1),
      sdDevSec: +sd.toFixed(1),
      structuralMisuse: misuse,
      delayCritSec: DELAY_CRIT_SEC,
      verdict,
      recent: this._results.slice(-6).reverse(),
    };
  }
}
