/**
 * WildlifeMonitor — airport wildlife hazard management (WHM).
 *
 * ICAO Annex 14 + PANS-Aerodromes (Doc 9981) require every aerodrome to run a
 * wildlife hazard programme. The modern stack pairs an AVIAN RADAR (Robin
 * Radar-style 360° tracking of flock position/size/heading, day and night)
 * with DISPERSAL patrols (Scarecrow-style bio-acoustics) and mandatory strike
 * reporting (FAA/ICAO databases feed risk models).
 *
 * This module simulates that stack, advisory-only (flights are never steered):
 *  - a bird-activity cycle drives flock appearance near the grass margins and
 *    the western approach corridor; flocks drift slowly and eventually leave,
 *  - per-runway risk (LOW/MOD/HIGH) from flock size and proximity to the
 *    strip / approach cone — the avian-radar picture,
 *  - a HIGH level sustained for a few seconds dispatches a dispersal patrol
 *    (bio-acoustics): the offending flocks scatter, the action is logged,
 *  - an aircraft rolling/landing with a flock close aboard logs a NEAR-MISS,
 *    or a STRIKE when the miss distance is tiny — the ICAO-reportable events.
 */

const RZ = { RWY1: -25, RWY2: -42 };     // runway centrelines (world z)
const MAX_FLOCKS   = 6;
const FLOCK_TTL    = 140;    // sim-s before a flock departs on its own
const HIGH_SUSTAIN = 6;      // sim-s of HIGH before a patrol rolls
const PATROL_COOLDOWN = 25;  // sim-s between dispersal actions per runway
const NEAR_U   = 6;          // world units (≈48 m) → near-miss
const STRIKE_U = 0.6;        // world units (≈5 m ≈ half-span) → geometric CONTACT = strike

export class WildlifeMonitor {
  constructor() {
    this._flocks = [];
    this._nextId = 1;
    this._lastSim = null;
    this._risk = { RWY1: 'low', RWY2: 'low' };
    this._highSince = { RWY1: null, RWY2: null };
    this._patrolAt = { RWY1: -Infinity, RWY2: -Infinity };
    this._counts = { spawned: 0, dispersals: 0, strikes: 0, nearMiss: 0 };
    this._events = [];           // recent, newest first
    this._struck = new Set();    // flight ids already counted this pass
  }

  /** Bird activity 0..1 — a slow diurnal-style cycle over sim time. */
  activity(now) { return 0.5 + 0.5 * Math.sin(now / 300 * 2 * Math.PI); }

  update(snapshot) {
    const now = snapshot.simTimeSec;
    const dt = this._lastSim == null ? 0 : Math.max(0, now - this._lastSim);
    this._lastSim = now;
    if (dt === 0) return;

    const act = this.activity(now);

    // 1. Flock population: spawn near grass margins / west approach, drift, age out.
    if (this._flocks.length < MAX_FLOCKS && Math.random() < act * 0.02 * dt * 10) {
      const west = Math.random() < 0.35;
      this._flocks.push({
        id: this._nextId++,
        x: west ? -120 - Math.random() * 70 : -130 + Math.random() * 260,
        z: west ? RZ.RWY1 + (Math.random() * 10 - 5) : -52 + Math.random() * 34,
        size: 5 + Math.floor(Math.random() * 35),
        vx: (Math.random() - 0.5) * 1.6,
        vz: (Math.random() - 0.5) * 1.0,
        born: now,
      });
      this._counts.spawned++;
    }
    for (const f of this._flocks) {
      f.x += f.vx * dt; f.z += f.vz * dt;
      if (Math.random() < 0.02) { f.vx = (Math.random() - 0.5) * 1.6; f.vz = (Math.random() - 0.5) * 1.0; }
    }
    this._flocks = this._flocks.filter(f =>
      now - f.born < FLOCK_TTL && f.x > -220 && f.x < 220 && f.z > -90 && f.z < 70);

    // 2. Avian-radar risk per runway (strip + a coarse western approach cone).
    for (const key of ['RWY1', 'RWY2']) {
      const rz = RZ[key];
      let level = 'low';
      for (const f of this._flocks) {
        const inStrip = Math.abs(f.z - rz) < 5 && f.x > -90 && f.x < 100;
        const nearStrip = Math.abs(f.z - rz) < 16 && f.x > -130 && f.x < 130;
        const bigNear = f.size >= 18 && nearStrip;
        if (inStrip || (bigNear && Math.abs(f.z - rz) < 9)) { level = 'high'; break; }
        if (nearStrip) level = 'mod';
      }
      this._risk[key] = level;

      // 3. Dispersal patrol on sustained HIGH (with per-runway cooldown).
      if (level === 'high') {
        if (this._highSince[key] == null) this._highSince[key] = now;
        if (now - this._highSince[key] >= HIGH_SUSTAIN &&
            now - this._patrolAt[key] >= PATROL_COOLDOWN) {
          this._patrolAt[key] = now;
          this._counts.dispersals++;
          let scattered = 0;
          this._flocks = this._flocks.filter(f => {
            const inZone = Math.abs(f.z - rz) < 16 && f.x > -130 && f.x < 130;
            if (inZone) scattered++;
            return !inZone;
          });
          this._event({ kind: 'dispersal', rwy: key, n: scattered, sim: now });
          this._highSince[key] = null;
        }
      } else {
        this._highSince[key] = null;
      }
    }

    // 4. Near-miss / strike vs departing & short-final traffic.
    for (const a of snapshot.flights) {
      if (a.state !== 'TAKEOFF' &&
          !(a.state === 'TAXIING_IN' && a.altitudeM > 4 && a.position.x > -110)) continue;
      for (const f of this._flocks) {
        const d = Math.hypot(a.position.x - f.x, a.position.z - f.z);
        if (d < STRIKE_U && !this._struck.has(a.id + ':' + f.id)) {
          this._struck.add(a.id + ':' + f.id);
          this._counts.strikes++;
          this._event({ kind: 'strike', cs: a.callsign, rwy: a.runway, size: f.size, sim: now });
          f.size = Math.max(3, Math.floor(f.size / 3));   // flock scatters after impact
          f.vz += 1.2;
        } else if (d < NEAR_U && !this._struck.has(a.id + ':' + f.id + ':n')) {
          this._struck.add(a.id + ':' + f.id + ':n');
          this._counts.nearMiss++;
          this._event({ kind: 'nearmiss', cs: a.callsign, rwy: a.runway, distM: Math.round(d * 8), sim: now });
        }
      }
    }
    if (this._struck.size > 500) this._struck.clear();
  }

  _event(e) {
    this._events.unshift({ ...e, sim: +e.sim.toFixed(1) });
    if (this._events.length > 10) this._events.pop();
  }

  getStatus() {
    const worst = Object.values(this._risk).includes('high') ? 'high'
                : Object.values(this._risk).includes('mod') ? 'mod' : 'low';
    return {
      activityPct: this._lastSim == null ? 0 : Math.round(this.activity(this._lastSim) * 100),
      flocks: this._flocks.map(f => ({ x: +f.x.toFixed(1), z: +f.z.toFixed(1), size: f.size })),
      risk: { ...this._risk },
      worst,
      ...this._counts,
      events: this._events.slice(0, 6),
    };
  }
}
