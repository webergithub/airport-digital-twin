/**
 * SlotMonitor — ATFM / CTOT slot-adherence monitoring (EUROCONTROL Network
 * Manager style).
 *
 * In European ops a regulated departure receives a CTOT (Calculated Take-Off
 * Time) from the Network Manager; the aircraft must become airborne inside the
 * standard slot tolerance window (CTOT −5/+10 min). Slot adherence is a named
 * network KPI: it is monitored monthly, and airports whose non-adherence
 * reaches 20% of regulated departures must file action plans. A-CDM exists in
 * large part to hit these windows (TOBT → TSAT sequencing feeds the CTOT).
 *
 * This module is advisory-only (pure snapshot consumer, module-local state):
 *  - a deterministic ~40% of departures are "regulated": on first sight of a
 *    TOBT the flight gets a CTOT = TOBT + taxi estimate + a small
 *    deterministic offset (no RNG — stable under replay/restore),
 *  - the tolerance window is scaled to the twin's compressed timescale
 *    (−10/+20 sim-s standing in for the real −5/+10 min),
 *  - when ATOT appears the slot closes as early / compliant / late,
 *  - open slots carry a live takeoff prediction so the panel can flag AT-RISK
 *    and MISSED slots while there is still time to react.
 */

const WIN_EARLY = 10;   // sim-s before CTOT still inside the window  (real: −5 min)
const WIN_LATE  = 20;   // sim-s after CTOT still inside the window   (real: +10 min)
const TAXI_EST  = 26;   // sim-s pushback→airborne planning estimate
const REG_RATIO = 5;    // hash % 5 < 2  → ~40% of departures regulated

export class SlotMonitor {
  constructor() {
    this._slots = new Map();   // flightId → slot record
    this._closed = [];         // recent closed slots, newest first
    this._tally = { closed: 0, compliant: 0, early: 0, late: 0 };
  }

  /** Deterministic per-flight hash — stable (no RNG), and multiplicatively
   *  mixed so CONSECUTIVE flight numbers don't cluster into one bucket. */
  _regulated(cs) {
    let h = 0;
    for (const ch of cs) h = (h * 31 + ch.charCodeAt(0)) | 0;
    h = Math.imul(h ^ (h >>> 15), 2654435761);
    return ((h >>> 16) % REG_RATIO) < 2;
  }

  update(snapshot) {
    const now = snapshot.simTimeSec;

    for (const f of snapshot.flights) {
      const tobt = f.milestones && f.milestones.TOBT;
      if (!tobt) continue;

      let s = this._slots.get(f.id);
      if (!s) {
        if (!this._regulated(f.callsign)) { this._slots.set(f.id, { skip: true }); continue; }
        // CTOT: planned airborne time + a deterministic 0–14 s network offset.
        const ofs = (Math.abs(f.callsign.charCodeAt(2) * 7 + f.callsign.length) % 15);
        s = {
          cs: f.callsign, runway: f.runway,
          ctot: +(tobt.sim + TAXI_EST + ofs).toFixed(1),
          closedAt: null, verdict: null,
        };
        this._slots.set(f.id, s);
      }
      if (s.skip || s.verdict) continue;

      const atot = f.milestones.ATOT;
      if (atot) {
        // Slot closes at wheels-off.
        const d = atot.sim - s.ctot;
        s.verdict = d < -WIN_EARLY ? 'early' : d > WIN_LATE ? 'late' : 'compliant';
        s.closedAt = atot.sim;
        s.devSec = +d.toFixed(1);
        this._tally.closed++; this._tally[s.verdict]++;
        this._closed.unshift({ cs: s.cs, ctot: s.ctot, devSec: s.devSec, verdict: s.verdict });
        if (this._closed.length > 24) this._closed.pop();
        continue;
      }

      // Live prediction for the open slot (coarse but honest).
      let pred;
      if (f.state === 'AT_GATE')       pred = Math.max(now, (f.pobtSim ?? tobt.sim)) + TAXI_EST;
      else if (f.state === 'PUSHBACK') pred = now + TAXI_EST * 0.8;
      else if (f.state === 'TAXIING_OUT' || f.state === 'HOLDING')
        pred = now + 8 + Math.max(0, f.slot) * 10;
      else if (f.state === 'TAKEOFF')  pred = now + 2;
      else continue;                                   // arrivals etc. — not yet relevant
      s.predSec = +pred.toFixed(1);
      s.state = f.state;
      s.status = now > s.ctot + WIN_LATE ? 'missed'
               : pred > s.ctot + WIN_LATE * 0.6 ? 'risk'
               : 'ok';
    }

    // Drop records for flights that left the snapshot (pruned after DONE).
    const ids = new Set(snapshot.flights.map(f => f.id));
    for (const id of this._slots.keys()) {
      const s = this._slots.get(id);
      if (!ids.has(id) && (s.skip || s.verdict)) this._slots.delete(id);
    }
  }

  getStatus() {
    const t = this._tally;
    const open = [...this._slots.values()]
      .filter(s => !s.skip && !s.verdict && s.status)
      .sort((a, b) => a.ctot - b.ctot)
      .map(s => ({ cs: s.cs, runway: s.runway, ctot: s.ctot,
                   winLo: +(s.ctot - WIN_EARLY).toFixed(1), winHi: +(s.ctot + WIN_LATE).toFixed(1),
                   predSec: s.predSec, state: s.state, status: s.status }));
    return {
      winEarly: WIN_EARLY, winLate: WIN_LATE,
      regulated: t.closed + open.length,
      closed: t.closed, compliant: t.compliant, early: t.early, late: t.late,
      adherencePct: t.closed ? +(t.compliant / t.closed * 100).toFixed(0) : null,
      open, recent: this._closed.slice(0, 8),
    };
  }
}
