/**
 * ArrivalManager — an AMAN (Arrival Manager) for the two shared runways.
 *
 * Real AMAN / E-AMAN systems (EUROCONTROL AMAN, Heathrow Intelligent Approach,
 * MAESTRO/Orthogon) compute each inbound's ETA to the runway threshold, build a
 * runway-feasible landing sequence honouring wake-turbulence / time-based
 * separation minima, assign each flight a Scheduled Time of Arrival (STA) and a
 * "time to lose" (delay), and have the aircraft absorb that delay by speed
 * control on final. This mirror of RunwayController does exactly that:
 *
 *   ETA[i] = now + distance-to-threshold / nominal approach speed
 *   STA[i] = max(ETA[i], STA[i-1] + wakeSep(cat[i-1], cat[i]))
 *   metered approach speed = distance / (STA − now)   → spaces arrivals on final
 *
 * It also reports, per runway, whether an arrival currently occupies the final /
 * rollout window so RunwayController can hold departures off a shared runway
 * (RIMCAS stays as the safety backstop). Advisory sequencing only — it sets the
 * approach speed the aircraft flies; it never teleports or hard-stops traffic.
 */

import { FS, FAST, THRESHOLD_X } from './flight-manager.js';

const RZ = { RWY1: -25, RWY2: -42 };
// RECAT-EU-style wake separation, leader→follower, compressed to sim-seconds.
const SEP = {
  H: { H: 8, M: 12, S: 14 },
  M: { H: 7, M: 8,  S: 11 },
  S: { H: 6, M: 7,  S: 8  },
};
const RWY_GUARD = 4;    // an arrival within this many sec of the threshold blocks departures
                        // (short-final only — matches the compressed approach timescale)

export class ArrivalManager {
  constructor() {
    this._busy = { RWY1: false, RWY2: false };
    this._ladder = { RWY1: [], RWY2: [] };
    this._clock = 0;
  }

  /** Sequence inbound traffic per runway and set each arrival's ETA/STA/speed. */
  service(flights, clock) {
    this._clock = clock;
    for (const key of Object.keys(RZ)) {
      const rz = RZ[key];
      let busy = false;
      const inbound = [];
      for (const f of flights.values()) {
        if (f.runway !== key || f.state !== FS.TAXIING_IN) continue;
        // Still rolling out on the runway strip (landed, not yet turned off) → busy.
        if (f.y < 2 && Math.abs(f.z - rz) < 4 && f.x > THRESHOLD_X - 6 && f.x < 80) { busy = true; continue; }
        if (f.y <= 1) continue;                     // on the ground taxiing to the gate
        const dist = THRESHOLD_X - f.x;             // >0 while west of the threshold
        if (dist <= 0) continue;
        inbound.push({ f, dist, eta: clock + dist / FAST });
      }
      inbound.sort((a, b) => a.eta - b.eta);

      let prevSta = -Infinity, prevCat = null;
      inbound.forEach((it, i) => {
        const cat = it.f.wakeCat;
        const sep = prevCat ? (SEP[prevCat]?.[cat] ?? 8) : 0;
        const sta = Math.max(it.eta, prevSta + sep);
        it.f.eta = +it.eta.toFixed(1);
        it.f.sta = +sta.toFixed(1);
        it.f.timeToLose = +(sta - it.eta).toFixed(1);
        it.f.seqIdx = i + 1;
        // Speed to hit the STA (clamped inside Flight.update to the approach band).
        it.f._amanSpeed = it.dist / Math.max(0.5, sta - clock);
        if (sta - clock < RWY_GUARD) busy = true;
        prevSta = sta; prevCat = cat;
      });

      this._busy[key] = busy;
      this._ladder[key] = inbound.map(it => ({
        cs: it.f.callsign, cat: it.f.wakeCat, seq: it.f.seqIdx,
        eta: it.f.eta, sta: it.f.sta, ttl: it.f.timeToLose,
      }));
    }
  }

  /** True while an arrival occupies a runway's final/rollout window. */
  runwayBusy(key) { return !!this._busy[key]; }

  /** Ladder data for the AMAN HMI: per-runway inbound sequence (soonest first). */
  getLadder() {
    return { clock: +this._clock.toFixed(1), RWY1: this._ladder.RWY1, RWY2: this._ladder.RWY2 };
  }
}
