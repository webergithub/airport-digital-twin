/**
 * TaxiConflictMonitor — A-SMGCS Level 3 conflict detection on the taxiway /
 * apron movement area.
 *
 * The EUROCONTROL A-SMGCS specification's Airport Safety Support Service goes
 * beyond runway alerting (RMCA — our RIMCAS module): it also raises conflict
 * and conformance alerts for traffic on TAXIWAYS and the apron (CMAC / CATC),
 * and Level 3 systems detect conflicts across the whole movement area. This
 * module adds that layer: pairwise proximity + closure prediction for taxiing
 * aircraft, with the RIMCAS-style two-stage escalation.
 *
 * Pure snapshot consumer (like RIMCAS): positions + speeds + headings in, an
 * advisory picture out — it never steers the traffic. Stationary queues (both
 * aircraft holding) are NOT conflicts; an alert needs genuine closure.
 */

const UNIT_M     = 8;      // world unit → metres
const CAUTION_M  = 70;     // closing inside this range → caution (amber)
const ALARM_M    = 36;     // closing inside this range → alarm (red)
// Two aircraft legitimately sit AT the enforced separation bubble (~17.6 m)
// when car-following — that is normal ops, not a conflict. The 'anyway' tier
// therefore also requires actual closure, like the other tiers.
const ANYWAY_M = 18;     // closer than this → alarm even without closure
const MIN_CLOSE  = 0.4;    // m/s of closure below which a pair is "not closing"
const TTC_MAX    = 10;     // s — predicted-conflict horizon (time to CPA)

const GROUND = new Set(['TAXIING_IN', 'TAXIING_OUT', 'PUSHBACK', 'HOLDING']);

export class TaxiConflictMonitor {
  constructor() {
    this._ep = new Map();      // pairKey → { level, startSim, peak }
    this._cautions = 0;
    this._alarms = 0;
    this._minSepM = Infinity;  // closest recorded pair distance during any episode
    this._log = [];            // closed episodes, newest first
    this._live = [];
  }

  update(snapshot) {
    const now = snapshot.simTimeSec;
    // Ground movers only; exclude runway occupancy (RIMCAS owns the runways).
    const g = snapshot.flights.filter(f =>
      GROUND.has(f.state) && f.position.y < 1 && f.position.z > -20);

    this._live = [];
    const seen = new Set();
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        const a = g[i], b = g[j];
        const dx = (a.position.x - b.position.x) * UNIT_M;
        const dz = (a.position.z - b.position.z) * UNIT_M;
        const distM = Math.hypot(dx, dz);
        if (distM > CAUTION_M * 1.6) continue;

        // Closure rate: positive when the pair is converging.
        const va = this._vel(a), vb = this._vel(b);
        const closing = distM > 0.1
          ? -((dx * (va.x - vb.x) + dz * (va.z - vb.z)) / distM) : 0;

        let level = 0;
        // Two aircraft parked AT the enforced separation bubble (~17.6 m) while
        // car-following are normal ops, not a conflict — the proximity tier
        // therefore also demands actual closure.
        if (distM < ANYWAY_M && closing > 0.2) level = 2;
        else if (closing > MIN_CLOSE) {
          const ttc = distM / closing;
          if (distM < ALARM_M || ttc < TTC_MAX * 0.4) level = 2;
          else if (distM < CAUTION_M || ttc < TTC_MAX) level = 1;
        }
        if (!level) continue;

        const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
        seen.add(key);
        let ep = this._ep.get(key);
        if (!ep) { ep = { level: 0, startSim: now, peak: 0, pair: '' }; this._ep.set(key, ep); }
        ep.pair = `${a.callsign}·${b.callsign}`;
        if (level > ep.peak) ep.peak = level;
        ep.level = level;
        if (distM < this._minSepM) this._minSepM = distM;

        this._live.push({
          a: a.callsign, b: b.callsign, distM: +distM.toFixed(0),
          ttcSec: closing > MIN_CLOSE ? +(distM / closing).toFixed(1) : null,
          level,
          ax: a.position.x, az: a.position.z, bx: b.position.x, bz: b.position.z,
        });
      }
    }

    // Close episodes whose pair separated (or left the ground picture).
    for (const [key, ep] of [...this._ep]) {
      if (seen.has(key)) continue;
      if (ep.peak === 2) this._alarms++; else if (ep.peak === 1) this._cautions++;
      this._log.unshift({ pair: ep.pair || key, peak: ep.peak,
        durSec: +(now - ep.startSim).toFixed(1), sim: +now.toFixed(1) });
      if (this._log.length > 20) this._log.pop();
      this._ep.delete(key);
    }
    this._live.sort((x, y) => y.level - x.level || x.distM - y.distM);
  }

  _vel(f) {
    const spd = f.speedMps || 0;                       // already m/s in the snapshot
    const h = (f.headingDeg || 0) * Math.PI / 180;
    // headingDeg was computed as atan2(dir.x, dir.z) — recover the unit vector.
    return { x: Math.sin(h) * spd, z: Math.cos(h) * spd };
  }

  getStatus() {
    return {
      live: this._live.slice(0, 6).map(({ ax, az, bx, bz, ...r }) => r),
      links: this._live.map(l => ({ ax: l.ax, az: l.az, bx: l.bx, bz: l.bz, level: l.level })),
      cautions: this._cautions,
      alarms: this._alarms,
      minSepM: Number.isFinite(this._minSepM) ? +this._minSepM.toFixed(0) : null,
      activeMax: this._live.length ? this._live[0].level : 0,
    };
  }
}
