/**
 * FuelFarm — jet-fuel supply: farm stock, hydrant network, resilience.
 *
 * Airports run their Jet A-1 chain under JIG standards (ICAO's Doc 9977 manual
 * covers the supply system): bulk tanks at the fuel farm, an underground
 * pressurised HYDRANT network serving the contact stands, and bowser trucks
 * for remote positions. Farm stock is a resilience metric — airports hold a
 * strategic buffer ("days of cover") against upstream interruptions, with
 * SCADA-monitored levels and scheduled tanker/pipeline replenishment.
 *
 * Advisory model, driven from the snapshot:
 *  - each departure's uplift is booked at off-block (AOBT), sized by wake
 *    class; contact stands draw through the hydrant, remote stands by bowser,
 *  - stock depletes; below the reorder point a tanker delivery is ordered and
 *    arrives after a lead time (deliveries are logged),
 *  - a rolling burn rate yields HOURS OF COVER at the current tempo — the
 *    twin's honest, timescale-scaled version of days-of-cover,
 *  - low-stock raises an advisory alert (APOC capacity domain).
 */

const CAPACITY_KL   = 600;
const INITIAL_KL    = 420;
const REORDER_KL    = 250;   // order a tanker below this level
const DELIVERY_KL   = 200;   // per delivery (capped at capacity)
const LEAD_SEC      = 60;    // order → arrival lead time (sim-s)
const UPLIFT_KL     = { S: 4, M: 10, H: 28 };   // per departure by wake class
const BURN_WINDOW   = 600;   // rolling burn-rate window (sim-s)

export class FuelFarm {
  constructor() {
    this._stock = INITIAL_KL;
    this._booked = new Set();      // flight ids whose uplift is already booked
    this._uplifts = 0;
    this._upliftKL = 0;
    this._hydrant = 0;             // uplifts via hydrant (contact stands)
    this._burnLog = [];            // { sim, kl } for the rolling rate
    this._pending = null;          // { etaSim } outstanding tanker order
    this._deliveries = 0;
    this._recent = [];             // recent uplifts, newest first
    this._lastSim = 0;
  }

  update(snapshot) {
    const now = snapshot.simTimeSec;
    this._lastSim = now;
    const bridgeByGate = new Map((snapshot.gates || []).map(g => [g.id, !!g.hasBridge]));

    // 1. Book each departure's uplift once, at off-block (fuel went on during
    //    the turnaround; AOBT is the clean, always-stamped booking point).
    for (const f of snapshot.flights) {
      if (!f.milestones || !f.milestones.AOBT || this._booked.has(f.id)) continue;
      this._booked.add(f.id);
      const kl = UPLIFT_KL[f.wakeCat] ?? UPLIFT_KL.M;
      const viaHydrant = bridgeByGate.get(f.gate) === true;
      this._stock = Math.max(0, this._stock - kl);
      this._uplifts++; this._upliftKL += kl;
      if (viaHydrant) this._hydrant++;
      this._burnLog.push({ sim: now, kl });
      this._recent.unshift({ cs: f.callsign, kl, hydrant: viaHydrant, sim: +now.toFixed(1) });
      if (this._recent.length > 8) this._recent.pop();
    }
    if (this._booked.size > 400) {
      const ids = new Set(snapshot.flights.map(f => f.id));
      for (const id of this._booked) if (!ids.has(id)) this._booked.delete(id);
    }

    // 2. Rolling burn rate + replenishment orders.
    const cutoff = now - BURN_WINDOW;
    this._burnLog = this._burnLog.filter(b => b.sim > cutoff);
    if (!this._pending && this._stock < REORDER_KL) {
      this._pending = { etaSim: now + LEAD_SEC };
    }
    if (this._pending && now >= this._pending.etaSim) {
      this._stock = Math.min(CAPACITY_KL, this._stock + DELIVERY_KL);
      this._deliveries++;
      this._pending = null;
    }
  }

  getStatus() {
    const burnKL = this._burnLog.reduce((s, b) => s + b.kl, 0);
    const hourlyBurn = burnKL * (3600 / BURN_WINDOW);      // kL per sim-hour
    const coverHours = hourlyBurn > 0 ? +(this._stock / hourlyBurn).toFixed(1) : null;
    return {
      stockKL: +this._stock.toFixed(1),
      capacityKL: CAPACITY_KL,
      stockPct: +(this._stock / CAPACITY_KL * 100).toFixed(0),
      hourlyBurnKL: +hourlyBurn.toFixed(1),
      coverHours,
      low: this._stock < REORDER_KL,
      uplifts: this._uplifts,
      upliftKL: +this._upliftKL.toFixed(0),
      hydrantSharePct: this._uplifts ? Math.round(this._hydrant / this._uplifts * 100) : null,
      deliveries: this._deliveries,
      pendingEtaSec: this._pending ? +Math.max(0, this._pending.etaSim - this._lastSim).toFixed(0) : null,
      recent: this._recent.slice(0, 6),
    };
  }
}
