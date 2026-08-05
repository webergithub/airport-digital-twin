/**
 * ALCMS — Airfield Lighting Control & Monitoring System.
 *
 * Modern airfields run their lighting through an ALCMS (ADB SAFEGATE, OCEM):
 * real-time single-lamp failure detection (<60 s vs the old nightly walk),
 * circuit health, and predictive maintenance. ICAO ties serviceability to
 * operations: CAT II/III needs ≥95% of approach (inner 450 m) and runway
 * centreline lights serviceable AND no two adjacent lamps out; miss the minima
 * and low-visibility operations are impaired.
 *
 * This module models that asset layer, advisory-only:
 *  - 9 lighting circuits (edge / centreline / approach per runway, taxiway
 *    greens, stop bars) with per-lamp stochastic failures,
 *  - adjacent-pair detection on the critical circuits (the CAT III rule),
 *  - one maintenance crew: dispatched to the worst degraded circuit, replaces
 *    failed lamps at a fixed rate, then moves on (repairs are logged),
 *  - ICAO minima per circuit (95% critical / 85% general) → OK / DEGRADED /
 *    BELOW-MINIMA, plus an LVP-IMPAIRED advisory when low-visibility weather
 *    coincides with a critical circuit below minima.
 */

const RATE = 4e-5;          // lamp failures per lamp-second (tuned for visible activity)
const REPAIR_PER_S = 0.7;   // lamps replaced per sim-second while a crew works
const CRIT_MIN = 0.95;      // ICAO minima for critical circuits (approach/CL/stop bars)
const GEN_MIN  = 0.85;      // general circuits
const CRIT_DISPATCH = 0.98; // crew rolls before minima are threatened
const GEN_DISPATCH  = 0.92;
const DETECT_SEC = 6;       // real ALCMS single-lamp detection <60 s → ~6 sim-s

const CIRCUITS = [
  { id: 'R1E', key: 'agl.c.r1e', lamps: 72, critical: false },
  { id: 'R1C', key: 'agl.c.r1c', lamps: 60, critical: true },
  { id: 'R1A', key: 'agl.c.r1a', lamps: 30, critical: true },
  { id: 'R2E', key: 'agl.c.r2e', lamps: 72, critical: false },
  { id: 'R2C', key: 'agl.c.r2c', lamps: 60, critical: true },
  { id: 'R2A', key: 'agl.c.r2a', lamps: 30, critical: true },
  { id: 'TGA', key: 'agl.c.tga', lamps: 48, critical: false },
  { id: 'TGB', key: 'agl.c.tgb', lamps: 48, critical: false },
  { id: 'SB',  key: 'agl.c.sb',  lamps: 12, critical: true },
];

export class ALCMS {
  constructor() {
    this._c = CIRCUITS.map(c => ({ ...c, failed: new Set(), reported: new Set(), pending: [] }));
    this._lastSim = null;
    this._crew = { busy: false, circuit: null, queue: [] };
    this._repairs = 0;        // completed circuit repairs
    this._lampsReplaced = 0;
    this._repairCarry = 0;
    this._log = [];           // recent repair completions
  }

  update(snapshot) {
    const now = snapshot.simTimeSec;
    const dt = this._lastSim == null ? 0 : Math.max(0, now - this._lastSim);
    this._lastSim = now;
    if (dt === 0) return;

    // 1. Stochastic single-lamp failures (the ALCMS detects them instantly).
    for (const c of this._c) {
      const expected = c.lamps * RATE * dt;
      if (Math.random() < expected) {
        const lamp = Math.floor(Math.random() * c.lamps);
        if (!c.failed.has(lamp)) {
          c.failed.add(lamp);
          // The system takes time to notice: reported state trails physical.
          c.pending.push({ lamp, at: now + DETECT_SEC });
        }
      }
      while (c.pending.length && c.pending[0].at <= now) {
        const { lamp } = c.pending.shift();
        if (c.failed.has(lamp)) c.reported.add(lamp);
      }
      for (const lamp of c.reported) if (!c.failed.has(lamp)) c.reported.delete(lamp);
    }

    // 2. Crew dispatch: worst circuit past its dispatch threshold.
    if (!this._crew.busy) {
      let worst = null, worstGap = 0;
      for (const c of this._c) {
        const svc = 1 - c.reported.size / c.lamps;   // crews react to what is REPORTED
        const thr = c.critical ? CRIT_DISPATCH : GEN_DISPATCH;
        const gap = thr - svc;
        if (c.reported.size > 0 && gap > worstGap) { worst = c; worstGap = gap; }
      }
      if (worst) { this._crew = { busy: true, circuit: worst.id, queue: [] }; }
    }

    // 3. Active repair: replace lamps at a fixed rate until the circuit is clean.
    if (this._crew.busy) {
      const c = this._c.find(x => x.id === this._crew.circuit);
      if (!c || c.failed.size === 0) {
        if (c) {
          this._repairs++;
          this._log.unshift({ id: c.id, key: c.key, sim: +now.toFixed(1) });
          if (this._log.length > 6) this._log.pop();
        }
        this._crew = { busy: false, circuit: null, queue: [] };
        this._repairCarry = 0;
      } else {
        this._repairCarry += REPAIR_PER_S * dt;
        while (this._repairCarry >= 1 && c.failed.size > 0) {
          const first = c.failed.values().next().value;
          c.failed.delete(first);
          this._lampsReplaced++;
          this._repairCarry -= 1;
        }
      }
    }
  }

  /** CAT III adjacency rule: two neighbouring lamps both out. */
  _adjacentOut(c) {
    for (const i of c.failed) if (c.failed.has((i + 1) % c.lamps)) return true;
    return false;
  }

  getStatus(weatherLevel = 0) {
    let totalLamps = 0, totalFailed = 0;
    let anyCritBelow = false, anyDegraded = false;
    const circuits = this._c.map(c => {
      const svc = 1 - c.reported.size / c.lamps;    // the panel shows the ALCMS view
      const min = c.critical ? CRIT_MIN : GEN_MIN;
      const adj = c.critical && this._adjacentOut(c);
      const status = (svc < min || adj) ? 'below'
                   : (svc < (c.critical ? CRIT_DISPATCH : GEN_DISPATCH)) ? 'degraded' : 'ok';
      if (status === 'below' && c.critical) anyCritBelow = true;
      if (status !== 'ok') anyDegraded = true;
      totalLamps += c.lamps; totalFailed += c.reported.size;
      return { id: c.id, key: c.key, lamps: c.lamps, failed: c.reported.size,
               svcPct: +(svc * 100).toFixed(1), critical: c.critical, status,
               adjacentOut: adj };
    });
    return {
      circuits,
      overallPct: +((1 - totalFailed / totalLamps) * 100).toFixed(1),
      anyCritBelow, anyDegraded,
      lvpImpaired: weatherLevel >= 3 && anyCritBelow,
      crew: { busy: this._crew.busy, circuit: this._crew.circuit },
      repairs: this._repairs,
      lampsReplaced: this._lampsReplaced,
      log: this._log.slice(0, 4),
    };
  }
}
