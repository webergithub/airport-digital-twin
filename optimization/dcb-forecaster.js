/**
 * DCBForecaster — rolling Demand-Capacity Balancing (DCB) hotspot forecast.
 *
 * The twin's other layers are all current-state; this is its first forward-
 * looking one. Like EUROCONTROL/SESAR PJ09 Advanced DCB, the EUROCONTROL
 * Airport Operations Plan (rolling D-0 plan) and NASA ATD-2's ~1-hour Surface
 * Metering forecasts, it projects predicted movements into rolling time bins
 * per runway, compares them against the runway's declared capacity, and flags
 * "hotspots" where forecast demand exceeds capacity — before the congestion
 * actually arrives.
 *
 * Predictions are heuristic (no ML): departures from predicted off-block
 * (POBT) + a taxi-out lead or the runway-queue position × separation; arrivals
 * from the AMAN ladder's Scheduled Times of Arrival plus a short extrapolation
 * of the scheduler's next spawns. Capacity per bin = bin ÷ effective separation
 * (widened by weather, floored by metering, zero on a closed runway).
 *
 * It reads only the standard snapshot + the scheduler's public stats.
 */

import { RUNWAY_LIMITS } from '../control/runway-controller.js';

const MIN_SEP   = RUNWAY_LIMITS.MIN_SEP_SEC;  // 6 s base runway separation
const METER_GAP = 8;                          // RELEASE_GAP used by DMAN metering
const BIN       = 25;                         // sim-seconds per forecast bin
const NBINS     = 6;                          // → 150 s rolling horizon
const TAXI_LEAD = 42;                         // gate off-block → wheels-off lead
const APPROACH_LEAD = 16;                     // future spawn → threshold crossing
const FUTURE_ARR = 4;                         // extrapolated future arrivals to project

export class DCBForecaster {
  constructor(api, scheduler) { this._api = api; this._sch = scheduler; this._fc = null; }

  /** Recompute the forecast from one standard snapshot. */
  update(snapshot) {
    const now = snapshot.simTimeSec;
    const rwStat = {};
    for (const r of snapshot.runways) rwStat[r.runway] = r;
    const closedMap = (snapshot.disruptions && snapshot.disruptions.runwaysClosed) || { RWY1: false, RWY2: false };
    const metering = !!snapshot.metering;

    const runways = {};
    for (const key of ['RWY1', 'RWY2']) {
      const sep0 = MIN_SEP * ((rwStat[key] && rwStat[key].sepFactor) || 1);
      const effSep = metering ? Math.max(sep0, METER_GAP) : sep0;
      const closed = !!closedMap[key];
      const bins = [];
      for (let i = 0; i < NBINS; i++) {
        bins.push({ t0: +(now + i * BIN).toFixed(0), arr: 0, dep: 0, cap: closed ? 0 : +(BIN / effSep).toFixed(2) });
      }
      runways[key] = { closed, effSep: +effSep.toFixed(1), bins };
    }

    const put = (key, t, kind) => {
      const r = runways[key]; if (!r) return;
      // Past-due demand (e.g. a ready departure held at the gate past its frozen
      // POBT, or an arrival already at the threshold) is imminent — bin it into
      // the current window rather than dropping it, or the forecast would
      // paradoxically cool as a held-departure backlog grows.
      const i = Math.max(0, Math.floor((t - now) / BIN));
      if (i < NBINS) r.bins[i][kind]++;
    };

    // Demand from live flights.
    for (const f of snapshot.flights) {
      const r = runways[f.runway]; if (!r) continue;
      if (f.state === 'TAXIING_IN' && f.position.y > 2 && f.sta != null) {
        put(f.runway, f.sta, 'arr');                                  // AMAN-sequenced arrival
      } else if (f.state === 'HOLDING') {
        put(f.runway, now + ((f.slot || 0) + 1) * r.effSep, 'dep');   // queue position × separation
      } else if (f.state === 'PUSHBACK' || f.state === 'TAXIING_OUT') {
        put(f.runway, now + 22, 'dep');                               // en route to the runway
      } else if (f.state === 'AT_GATE') {
        const off = f.pobtSim != null ? f.pobtSim : now + 40;
        put(f.runway, off + TAXI_LEAD, 'dep');                        // predicted off-block + taxi-out
      }
    }

    // Extrapolated future arrivals from the scheduler (alternating open runways).
    const st = this._sch.getStats ? this._sch.getStats() : { nextIn: 20, interval: 20, floor: 0 };
    const eff = Math.max(st.interval || 20, st.floor || 0);
    const openRw = ['RWY1', 'RWY2'].filter(k => !runways[k].closed);
    for (let k = 0; k < FUTURE_ARR && openRw.length; k++) {
      const landT = now + (st.nextIn || 0) + k * eff + APPROACH_LEAD;
      put(openRw[k % openRw.length], landT, 'arr');
    }

    // Flag hotspots (demand over capacity, or any demand on a closed runway).
    let nextHot = null, worst = 0;
    for (const key of ['RWY1', 'RWY2']) {
      for (const b of runways[key].bins) {
        const dem = b.arr + b.dep;
        b.hot = b.cap > 0 ? dem > b.cap + 0.001 : dem > 0;
        const ratio = b.cap > 0 ? dem / b.cap : (dem > 0 ? 99 : 0);
        if (ratio > worst) worst = ratio;
        if (b.hot && (nextHot == null || b.t0 - now < nextHot)) nextHot = Math.round(b.t0 - now);
      }
    }
    this._fc = { now: +now.toFixed(1), binSec: BIN, nbins: NBINS, runways,
                 nextHotspotSec: nextHot, worstRatio: +worst.toFixed(2) };
  }

  getForecast() { return this._fc; }
}
