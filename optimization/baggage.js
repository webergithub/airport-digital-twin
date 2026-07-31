/**
 * BaggageSystem — BHS sortation + IATA Resolution 753 tracking.
 *
 * Resolution 753 obliges carriers to track every bag at FOUR mandatory points —
 * acceptance from the passenger, loading onto the departing aircraft, custody
 * exchange on transfer, and delivery to the passenger — and airports own the
 * infrastructure (BHS, BRS, sortation, arrival scanning) that produces those
 * scans. The operational levers are sortation THROUGHPUT (bags/min) and the
 * MISHANDLING RATE (bags per 1000 passengers), the industry's headline KPI.
 *
 * This models that layer off the twin's existing turnaround nodes — the bag
 * flow is already simulated as UNLOAD_BAG / LOAD_BAG service windows, so the
 * scans map onto real events rather than being invented:
 *   AIBT + UNLOAD_BAG active   → bags enter the BHS (arrival)
 *   UNLOAD_BAG done            → DELIVERY scan (or TRANSFER for connecting bags)
 *   LOAD_BAG active            → ACCEPTANCE scan, bags drawn from the sorter
 *   AOBT (off-block)           → LOADED scan; anything still in the sorter for
 *                                that flight is MISHANDLED (it missed the bin)
 * Sortation has finite capacity: demand above it forms a backlog, and a backlog
 * that outlives a departure is exactly how bags get mishandled in reality.
 * Advisory only — it never alters flight behaviour.
 */

const BAGS_BY_CAT = { S: 30, M: 95, H: 240 };   // bags per flight by wake class
const PAX_BY_CAT  = { S: 40, M: 160, H: 300 };  // passengers, for the per-1000 rate
const SORT_RATE   = 26;      // bags/sim-second the sorter can move (whole BHS)
const XFER_SHARE  = 0.22;    // share of arriving bags that are connecting

export class BaggageSystem {
  constructor() {
    this._lastSim = null;
    this._sorter = 0;                 // bags currently in the sortation loop
    this._perFlight = new Map();      // flightId → { toLoad, loaded, cat }
    this._seen = { in: new Set(), out: new Set(), done: new Set() };
    this._scans = { acceptance: 0, loaded: 0, transfer: 0, delivery: 0 };
    this._handled = 0;
    this._mishandled = 0;
    this._pax = 0;
    this._peakBacklog = 0;
    this._recent = [];                // recent mishandling incidents
  }

  update(snapshot) {
    const now = snapshot.simTimeSec;
    const dt = this._lastSim == null ? 0 : Math.max(0, now - this._lastSim);
    this._lastSim = now;
    if (dt === 0) return;

    let demand = 0;                   // bags asking for sorter capacity this tick

    for (const f of snapshot.flights) {
      const cat = f.wakeCat || 'M';
      const bags = BAGS_BY_CAT[cat] ?? BAGS_BY_CAT.M;

      // ── Arrival side: bags off the aircraft enter the BHS ──────────────────
      if (f.state === 'AT_GATE' && f.turnaround && f.turnaround.nodes) {
        const unload = f.turnaround.nodes.find(n => n.id === 'UNLOAD_BAG');
        if (unload && unload.active && !this._seen.in.has(f.id)) {
          this._seen.in.add(f.id);
          this._sorter += bags;
          this._pax += PAX_BY_CAT[cat] ?? PAX_BY_CAT.M;
        }
        if (unload && unload.done && !this._seen.done.has(f.id)) {
          this._seen.done.add(f.id);
          const xfer = Math.round(bags * XFER_SHARE);
          this._scans.transfer += xfer;
          this._scans.delivery += bags - xfer;   // terminating bags reach the belt
          this._sorter = Math.max(0, this._sorter - (bags - xfer));
          this._handled += bags - xfer;
        }

        // ── Departure side: acceptance while the load node runs ──────────────
        const load = f.turnaround.nodes.find(n => n.id === 'LOAD_BAG');
        if (load && load.active && !this._perFlight.has(f.id)) {
          this._perFlight.set(f.id, { toLoad: bags, loaded: 0, cat });
          this._scans.acceptance += bags;
        }
      }

      // Bags flow onto the aircraft at the sorter's rate while it is loading.
      const rec = this._perFlight.get(f.id);
      if (rec && f.state === 'AT_GATE' && rec.loaded < rec.toLoad) demand += rec.toLoad - rec.loaded;
    }

    // Apportion finite sortation capacity across the flights still loading.
    if (demand > 0) {
      const cap = SORT_RATE * dt;
      const share = Math.min(1, cap / demand);
      for (const [id, rec] of this._perFlight) {
        if (rec.loaded >= rec.toLoad) continue;
        const want = rec.toLoad - rec.loaded;
        rec.loaded = Math.min(rec.toLoad, rec.loaded + want * share);
      }
    }

    // ── Off-block closes the flight's bag record (Resolution 753 "loaded") ───
    for (const f of snapshot.flights) {
      const rec = this._perFlight.get(f.id);
      if (!rec || !f.milestones || !f.milestones.AOBT || this._seen.out.has(f.id)) continue;
      this._seen.out.add(f.id);
      const loaded = Math.floor(rec.loaded);
      const missed = Math.max(0, rec.toLoad - loaded);
      this._scans.loaded += loaded;
      this._handled += loaded;
      this._sorter = Math.max(0, this._sorter - loaded);
      if (missed > 0) {
        this._mishandled += missed;
        this._recent.unshift({ cs: f.callsign, missed, sim: +now.toFixed(1) });
        if (this._recent.length > 6) this._recent.pop();
      }
      this._perFlight.delete(f.id);
    }

    if (this._sorter > this._peakBacklog) this._peakBacklog = this._sorter;
    if (this._seen.in.size > 400) { this._seen.in.clear(); this._seen.out.clear(); this._seen.done.clear(); }
  }

  getStatus() {
    const total = this._handled + this._mishandled;
    const rate = this._pax > 0 ? (this._mishandled / this._pax) * 1000 : 0;
    // Resolution 753 compliance: share of bag movements carrying their scan.
    const scans = this._scans.acceptance + this._scans.loaded +
                  this._scans.transfer + this._scans.delivery;
    return {
      backlog: Math.round(this._sorter),
      peakBacklog: Math.round(this._peakBacklog),
      handled: Math.round(this._handled),
      mishandled: this._mishandled,
      mishandleRate: +rate.toFixed(1),        // per 1000 passengers
      totalBags: Math.round(total),
      scans: { ...this._scans },
      scanTotal: scans,
      loadingFlights: this._perFlight.size,
      recent: this._recent.slice(0, 4),
    };
  }
}
