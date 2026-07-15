/**
 * RunwaySafetyNet — an A-SMGCS Level 2 runway safety net (RIMCAS / RMCA).
 *
 * Real A-SMGCS surface-surveillance systems (Saab Aerobahn Runway & Surface
 * Safety, FAA ASDE-X, EUROCONTROL A-SMGCS Spec v2.0) run automatic runway
 * conflict monitoring & alerting: a two-stage escalation warns controllers when
 * a runway is occupied while another aircraft is landing or lined up —
 *   Stage 1 CAUTION (amber, ~30 s out)  →  Stage 2 ALARM (red, ~15 s / two on
 *   the runway simultaneously).
 *
 * This twin's two runways are each SHARED by arrivals and departures, and
 * control/runway-controller.js only sequences departures against each other —
 * arrivals rolling out are never deconflicted from departures. So this monitor
 * surfaces GENUINE, already-occurring runway-occupancy conflicts. It is
 * advisory only: it reads the standard JSON snapshot and never alters control
 * logic (like the real safety net, it alerts — it does not brake the aircraft).
 */

const RZ = { RWY1: -25, RWY2: -42 };   // runway centreline z (matches airport3d)
const TOUCHDOWN_X = -72;               // arrivals touch down here, roll east
const UNIT_M = 8;                      // snapshot speed is m/s; 1 world unit ≈ 8 m
// Time-to-threshold gates for a landing onto an occupied runway. Real RIMCAS
// uses ~30 s → ~15 s, but this sim's final approach is compressed to ~4 s
// (constant approach speed over ~58 world-units), so the two stages are scaled
// to that timescale to preserve the amber-caution → red-alarm escalation.
const CAUTION_TTT = 5;                 // s: landing this close to an occupied rwy → caution
const ALARM_TTT   = 2;                 // s: landing this close → alarm

export class RunwaySafetyNet {
  constructor(api) {
    this._api = api;
    this._simT = 0;
    this._st = {};                     // per-runway live episode state
    for (const k of Object.keys(RZ)) this._st[k] = { stage: 0, sinceSim: 0, startSim: 0, peak: 0 };
    this._log = [];                    // closed conflict episodes (recent first)
    this._alarms = 0;
    this._cautions = 0;
    this._lastAlarmSim = null;         // sim-time of the most recent alarm
  }

  /** Ingest one standard snapshot; recompute each runway's conflict stage. */
  update(snapshot) {
    this._simT = snapshot.simTimeSec;
    for (const key of Object.keys(RZ)) {
      const rz = RZ[key];
      const onRwy = snapshot.flights.filter(f =>
        f.runway === key &&
        Math.abs(f.position.z - rz) < 4 &&
        f.position.y < 1.5 &&                                   // physically on the ground/runway
        f.position.x > TOUCHDOWN_X - 6 && f.position.x < 80 &&
        (f.state === 'TAKEOFF' || f.state === 'TAXIING_IN'));

      // Nearest arrival on short final (airborne, west of the threshold).
      let minTtt = Infinity;
      for (const f of snapshot.flights) {
        if (f.runway !== key || f.state !== 'TAXIING_IN') continue;
        if (f.position.y < 1.5 || f.position.y > 22) continue;  // airborne band only
        if (f.position.x >= TOUCHDOWN_X - 2) continue;          // must still be west of touchdown
        const distU = TOUCHDOWN_X - f.position.x;               // world units to touchdown
        const spdU  = Math.max(0.1, (f.speedMps || 0) / UNIT_M);
        minTtt = Math.min(minTtt, distU / spdU);
      }
      const holdingReady = snapshot.flights.some(f =>
        f.runway === key && f.state === 'HOLDING' && f.slot === 0);

      let stage = 0;
      if (onRwy.length >= 2) stage = 2;                          // two bodies on the runway
      else if (onRwy.length === 1 && minTtt <= ALARM_TTT) stage = 2;   // landing imminent onto occupied rwy
      else if (onRwy.length === 1 && (minTtt <= CAUTION_TTT || holdingReady)) stage = 1;

      this._apply(key, stage);
    }
    // Conflict-free streak = time since the last tick ANY runway was in alarm,
    // so it reads 0 throughout a live alarm (not just at its rising edge).
    if (Object.values(this._st).some(s => s.stage === 2)) this._lastAlarmSim = this._simT;
  }

  _apply(key, stage) {
    const s = this._st[key];
    if (stage > s.stage) {
      if (s.stage === 0) { s.startSim = this._simT; s.peak = 0; }   // new episode
      s.sinceSim = this._simT;
      if (stage > s.peak) {
        s.peak = stage;
        this._api.emit('rimcas_alert', { runway: key, stage, sim: +this._simT.toFixed(1) });
      }
    } else if (stage < s.stage && stage === 0) {
      // Episode cleared → archive it and tally by peak severity.
      this._log.unshift({ runway: key, peak: s.peak,
        startSim: +s.startSim.toFixed(1), endSim: +this._simT.toFixed(1),
        durSec: +(this._simT - s.startSim).toFixed(1) });
      if (this._log.length > 40) this._log.pop();
      if (s.peak === 2) this._alarms++; else if (s.peak === 1) this._cautions++;
      s.peak = 0;
    }
    s.stage = stage;
    if (stage) s.sinceSim = s.sinceSim || this._simT;
    else s.sinceSim = 0;
  }

  /** Current alert stage for a runway (0 clear / 1 caution / 2 alarm) — for the 3D overlay. */
  stage(key) { return this._st[key] ? this._st[key].stage : 0; }

  getStatus() {
    return {
      runways: Object.fromEntries(Object.keys(RZ).map(k =>
        [k, { stage: this._st[k].stage, sinceSim: this._st[k].sinceSim }])),
      alarms: this._alarms,
      cautions: this._cautions,
      streakSec: this._lastAlarmSim == null ? +this._simT.toFixed(1)
                                            : +(this._simT - this._lastAlarmSim).toFixed(1),
      everAlarmed: this._lastAlarmSim != null,
      log: this._log.slice(0, 6),
    };
  }
}
