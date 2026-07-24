/**
 * Flight — state machine + waypoint path follower for one aircraft.
 *
 * Path coordinate system matches airport3d.js world layout.
 * Aircraft always land/take-off heading east (+X direction).
 *
 * AT_GATE is driven by a TurnaroundPlan (control/turnaround-plan.js): the flight
 * leaves the gate when the 13-node ground-handling schedule completes.
 * Departures are sequenced by RunwayController via slot / retargetSlot /
 * clearForTakeoff (control/runway-controller.js).
 */

import { getGates } from './gate-layout.js';
import { TurnaroundPlan } from './turnaround-plan.js';

export const FS = {
  TAXIING_IN:  'TAXIING_IN',
  AT_GATE:     'AT_GATE',
  PUSHBACK:    'PUSHBACK',
  TAXIING_OUT: 'TAXIING_OUT',
  HOLDING:     'HOLDING',
  TAKEOFF:     'TAKEOFF',
  DONE:        'DONE',
};

// Speeds in world-units per second
const TAXI     = 3.2;
export const FAST = 14.0;  // landing deceleration start / takeoff end (also nominal approach)
const SLOT_GAP = 9;     // departure queue slot spacing (center-to-center)
export const THRESHOLD_X = -72;      // touchdown x (arrivals cross the threshold here)
const MIN_APPROACH = 6.5;            // slowest metered approach speed (AMAN absorption floor)

// Right-skewed turnaround multiplier: ~60% near-target, ~25% minor overrun,
// ~15% significant overrun — mirrors real ground-handling delay distributions.
function _turnFactor() {
  const r = Math.random();
  if (r < 0.60) return 0.95 + Math.random() * 0.10;   // 0.95–1.05 (on-time)
  if (r < 0.85) return 1.05 + Math.random() * 0.15;   // 1.05–1.20 (minor delay)
  return 1.20 + Math.random() * 0.30;                 // 1.20–1.50 (significant)
}

const holdXof = runway => (runway === 'RWY1' ? -45 : -55);
const rzOf    = runway => (runway === 'RWY1' ? -25 : -42);
const exitXof = runway => (runway === 'RWY1' ?  45 :  55);

// Pick closest apron connector column for a gate
function connX(gx) {
  return gx < -5 ? -25 : gx > 5 ? 25 : 0;
}

function buildArrivalPath(runway, gateId) {
  const gate = getGates().find(g => g.id === gateId);
  if (!gate) return [];
  const cx    = connX(gate.x);
  const rz    = rzOf(runway);
  const exitX = exitXof(runway);

  // Aircraft flies in from the west on final approach (airborne, descending),
  // touches down, rolls out, then taxis to the gate. `y` is altitude above
  // ground (0 = on the ground). Arrivals exit at x=45/55 and never go west of
  // cx (max -25), clear of the departure queue west of holdX.
  return [
    { x: -260,   z: rz, y: 44, speed: FAST, tag: 'meter_fix'  }, // AMAN metering fix (sequencing horizon)
    { x: -130,   z: rz, y: 16, speed: FAST, tag: 'approach'   }, // on final, high
    { x: -72,    z: rz, y: 0,  speed: FAST, tag: 'land_start' }, // touchdown (threshold)
    { x: exitX,  z: rz, y: 0,  speed: TAXI, tag: 'land_end'   }, // roll out / brake
    { x: exitX,  z: -10, y: 0                                  },
    { x: cx,     z: -10, y: 0                                  },
    { x: cx,     z:  0,  y: 0                                  },
    { x: gate.x, z:  0,  y: 0                                  },
    { x: gate.x, z: 12,  y: 0, speed: 0, tag: 'at_gate'        },
  ];
}

function buildDeparturePath(runway, gateId, slot = 0) {
  const gate  = getGates().find(g => g.id === gateId);
  if (!gate) return [];
  const cx    = connX(gate.x);
  const rz    = rzOf(runway);
  const holdX = holdXof(runway);

  const path = [
    { x: gate.x, z: 12, y: 0, speed: TAXI * 0.45, tag: 'pushback' },
    { x: gate.x, z:  0, y: 0, speed: TAXI,        tag: 'taxi_out' },  // → TAXIING_OUT (enqueue trigger)
    { x: cx,     z:  0, y: 0                                        },
    { x: cx,     z: -10, y: 0                                       },
  ];
  // ALL holds are hold-short ON THE TAXIWAY (z=-10) — never on the runway. Slot 0
  // is the hold-short line at holdX; waiting slots stack EAST of it (behind), so
  // flights line up in order without taxiing through the ones ahead. Only after
  // clearance does the front flight enter the runway and roll (the runway holds
  // at most one aircraft at a time — see RunwayController).
  const slotX = slot === 0 ? holdX : holdX + slot * SLOT_GAP;
  path.push({ x: slotX, z: -10, y: 0, speed: 0,    tag: 'holding' });
  path.push({ x: holdX, z: rz,  y: 0, speed: TAXI, tag: 'takeoff' }); // enter runway + line up
  path.push({ x: 30,    z: rz,  y: 0,  speed: FAST });                // ground roll, accelerating
  path.push({ x: 75,    z: rz,  y: 9,  speed: FAST });                // rotate + initial climb
  path.push({ x: 150,   z: rz,  y: 46, speed: FAST });                // climb out (airborne)
  return path;
}

// Rebuild a departing flight's path from its CURRENT position to a (new) slot.
// First waypoint = current position, so the follower continues with no teleport.
function buildDepartureTail(runway, slot, fromX, fromZ) {
  const rz    = rzOf(runway);
  const holdX = holdXof(runway);
  const path  = [{ x: fromX, z: fromZ, y: 0 }];

  // Still on the apron? Route via the connector before the taxiway.
  if (fromZ > -9) {
    const cx = connX(fromX);
    path.push({ x: cx, z: 0, y: 0 });
    path.push({ x: cx, z: -10, y: 0 });
  }
  // Hold-short on the taxiway (never on the runway); waiting slots stack east.
  const slotX = slot === 0 ? holdX : holdX + slot * SLOT_GAP;
  path.push({ x: slotX, z: -10, y: 0, speed: 0,    tag: 'holding' });
  path.push({ x: holdX, z: rz,  y: 0, speed: TAXI, tag: 'takeoff' });
  path.push({ x: 30,    z: rz,  y: 0,  speed: FAST });
  path.push({ x: 75,    z: rz,  y: 9,  speed: FAST });
  path.push({ x: 150,   z: rz,  y: 46, speed: FAST });
  return path;
}

let _uid = 1;

export class Flight {
  constructor({ callsign, airline, type, runway, gateId, color, turnaroundTime = 60 }) {
    this.id             = `FL${String(_uid++).padStart(3, '0')}`;
    this.callsign       = callsign;
    this.airline        = airline ?? '';
    this.type           = type ?? 'MEDIUM';
    this.runway         = runway;
    this.gateId         = gateId;
    this.color          = color ?? 0xddddee;
    // Planned/target turnaround — drives the A-CDM TOBT (Target Off-Block Time).
    this.turnaroundTime = turnaroundTime;
    // Actual turnaround varies (right-skewed, like real ops): most flights are
    // near-target, a minority overrun due to late ground handling. The gap
    // between actual and target off-block is what A-CDM punctuality measures.
    this.actualTurnaround = Math.round(turnaroundTime * _turnFactor());

    this.state          = FS.TAXIING_IN;
    this.stateTimer     = 0;
    this._wps           = buildArrivalPath(runway, gateId);
    this._wi            = 0;
    this._wp            = 0;   // progress 0–1 along current segment
    this._spd           = FAST;
    this.currentSpeed   = 0;   // actual speed this tick (world units/s)
    this.done           = false;
    this.touchedDown    = false; // set at the touchdown waypoint (wheels-on / ALDT)

    // AMAN arrival management (set by ArrivalManager each tick while on approach)
    this.wakeCat    = { SMALL: 'S', MEDIUM: 'M', LARGE: 'H' }[this.type] || 'M';
    this.eta = null; this.sta = null; this.timeToLose = null; this.seqIdx = null;
    this._amanSpeed = 0;       // metered approach speed to hit the STA (0 = unmetered)

    // Departure-queue state
    this.slot           = 0;
    this._queued        = false;

    // Ground-handling plan (created on entering AT_GATE)
    this.turnaround     = null;

    // A-CDM milestones (recorded by AirportAPI): ATA/AIBT/TOBT/ARDT/TSAT/AOBT/ATOT
    this.milestones     = {};

    // DMAN departure metering: while true, a turnaround-complete flight waits
    // at the gate (engines off) for its TSAT start-up approval before pushback.
    this.gateHold       = false;

    // Stand-allocation rationale (set by AirportAPI): { contact, wide, classMatch, score }.
    this.stand          = null;

    const w0 = this._wps[0] ?? { x: 0, z: 0, y: 0 };
    this.x   = w0.x;
    this.z   = w0.z;
    this.y   = w0.y ?? 0;       // altitude above ground
    this._takeoffX0 = 0;        // x where the takeoff roll began (for speed ramp)
  }

  // ── Update ─────────────────────────────────────────────────────────────────
  update(dt) {
    if (this.done) return;
    this.stateTimer += dt;

    if (this.state === FS.AT_GATE) {
      this.currentSpeed = 0;
      if (this.turnaround) this.turnaround.update(dt);
      // Depart once turnaround completes AND the DMAN gate hold (departure
      // metering — awaiting TSAT start-up approval) has been released.
      if ((!this.turnaround || this.turnaround.complete) && !this.gateHold) this._startDeparture();
      return;
    }

    // HOLDING: wait for RunwayController.clearForTakeoff() — no self-clearing timer.
    if (this.state === FS.HOLDING) { this.currentSpeed = 0; return; }

    // Winter de-icing hold: frozen at the apron until treatment completes (DCR).
    // Only ever set on a departing flight while TAXIING_OUT (DeiceManager).
    if (this._deiceHold) { this.currentSpeed = 0; return; }

    const cur = this._wps[this._wi];
    const nxt = this._wps[this._wi + 1];
    if (!nxt) { this._onEnd(); return; }

    // Horizontal segment length (altitude change doesn't affect ground speed).
    const seg = Math.hypot(nxt.x - cur.x, nxt.z - cur.z);
    if (seg < 0.001) { this._advance(); return; }

    // Takeoff: accelerate TAXI→FAST over the first ~55 units of roll (smooth
    // across the climb waypoints, ramped by distance not per-segment).
    let spd = this._spd;
    if (this.state === FS.TAKEOFF) {
      const roll = Math.abs(this.x - this._takeoffX0);
      spd = TAXI + (FAST - TAXI) * Math.min(1, roll / 55);
    } else if (this.state === FS.TAXIING_IN && this.y > 1 && this._amanSpeed > 0) {
      // AMAN: fly the metered approach speed to absorb the assigned delay and
      // hit the Scheduled Time of Arrival, spacing arrivals on final.
      spd = Math.max(MIN_APPROACH, Math.min(FAST, this._amanSpeed));
    }

    this.currentSpeed = spd;
    this._wp += (spd * dt) / seg;
    if (this._wp >= 1) { this._wp = 0; this._advance(); }

    const p = this.getPosition();
    this.x  = p.x;
    this.z  = p.z;
    this.y  = p.y;
  }

  _advance() {
    this._wi++;
    if (this._wi >= this._wps.length) { this._onEnd(); return; }
    const wp = this._wps[this._wi];
    if (wp.speed !== undefined) this._spd = wp.speed;
    this._onWaypoint(wp);
  }

  _onWaypoint(wp) {
    switch (wp.tag) {
      case 'land_start':
        this.touchedDown = true;    // wheels-on (touchdown) → ALDT / OOOI 'ON'
        break;
      case 'at_gate':
        this.state      = FS.AT_GATE;
        this.stateTimer = 0;
        this.turnaround = new TurnaroundPlan(this.actualTurnaround, Date.now());
        break;
      case 'taxi_out':
        // Leaving the gate apron — eligible for runway queue enqueue.
        this.state = FS.TAXIING_OUT;
        break;
      case 'holding':
        this.state = FS.HOLDING;
        break;
      case 'takeoff':
        this.state = FS.TAKEOFF;
        this._takeoffX0 = this.x;   // mark roll start for the speed ramp
        break;
    }
  }

  _onEnd() {
    this.done  = true;
    this.state = FS.DONE;
  }

  _startDeparture() {
    this.state      = FS.PUSHBACK;
    this.stateTimer = 0;
    this.slot       = 0;
    this._queued    = false;
    this._wps       = buildDeparturePath(this.runway, this.gateId, 0);
    this._wi        = 0;
    this._wp        = 0;
    this._spd       = TAXI * 0.45;
  }

  // ── Departure-queue control (called by RunwayController) ─────────────────────
  retargetSlot(slot) {
    if (this.state !== FS.HOLDING && this.state !== FS.TAXIING_OUT) return;
    this.slot = slot;
    this._wps = buildDepartureTail(this.runway, slot, this.x, this.z);
    this._wi  = 0;
    this._wp  = 0;
    this._spd = TAXI;
    if (this.state === FS.HOLDING) this.state = FS.TAXIING_OUT; // resume taxiing forward
  }

  clearForTakeoff() {
    if (this.state !== FS.HOLDING || this.slot !== 0) return;
    // Resume from the threshold hold: taxi to the takeoff start, then the
    // 'takeoff' waypoint flips state to TAKEOFF and the roll begins.
    this.state = FS.TAXIING_OUT;
    this._spd  = TAXI;
  }

  // ── Position / direction ───────────────────────────────────────────────────
  getPosition() {
    const cur = this._wps[this._wi];
    const nxt = this._wps[this._wi + 1];
    if (!cur) return { x: this.x, y: this.y ?? 0, z: this.z };
    if (!nxt) return { x: cur.x, y: cur.y ?? 0, z: cur.z };
    return {
      x: cur.x + (nxt.x - cur.x) * this._wp,
      y: (cur.y ?? 0) + ((nxt.y ?? 0) - (cur.y ?? 0)) * this._wp,
      z: cur.z + (nxt.z - cur.z) * this._wp,
    };
  }

  getDirection() {
    const cur = this._wps[this._wi];
    const nxt = this._wps[this._wi + 1];
    if (cur && nxt) {
      const dx = nxt.x - cur.x, dz = nxt.z - cur.z;
      const len = Math.hypot(dx, dz) || 1;
      return { x: dx / len, z: dz / len };
    }
    // At the final waypoint (e.g. parked at the gate): keep the heading of the
    // last segment, so the aircraft stays nose-in toward the terminal instead of
    // snapping to a default east heading.
    const prev = this._wps[this._wi - 1];
    if (cur && prev) {
      const dx = cur.x - prev.x, dz = cur.z - prev.z;
      const len = Math.hypot(dx, dz) || 1;
      return { x: dx / len, z: dz / len };
    }
    return { x: 1, z: 0 };
  }

  /**
   * Remaining GROUND route from the current position — the taxi path the
   * Follow-the-Greens guidance lights lead the aircraft along. Returns [] while
   * airborne; stops at the runway hold (never routes onto the runway itself).
   */
  getGroundRoute() {
    if ((this.y ?? 0) > 2) return [];
    // z between the taxiway (-10) and the runways (-25/-42): on a runway. Guidance
    // never lights the runway — for a landing aircraft the green carpet only
    // begins once it has turned off onto the taxiway.
    const onRunway = z => z < -18;
    if (onRunway(this.z)) return [];
    const pts = [{ x: this.x, z: this.z }];
    for (let i = this._wi + 1; i < this._wps.length; i++) {
      const w = this._wps[i];
      if ((w.y ?? 0) > 2 || w.tag === 'takeoff' || onRunway(w.z)) break;  // climb / runway
      pts.push({ x: w.x, z: w.z });
    }
    return pts;
  }

  // ── Status for UI ──────────────────────────────────────────────────────────
  /** True while a ready (turnaround-complete) flight is metered at the gate. */
  get isGateHeld() {
    return this.state === FS.AT_GATE && this.gateHold &&
           !!(this.turnaround && this.turnaround.complete);
  }

  get turnaroundLive() { return this.turnaround; }
  getTurnaround() { return this.turnaround ? this.turnaround.snapshot() : null; }

  getStatus() {
    return {
      id:       this.id,
      callsign: this.callsign,
      airline:  this.airline,
      type:     this.type,
      state:    this.state,
      gateId:   this.gateId,
      runway:   this.runway,
      milestones: this.milestones,
      holdingAtGate: this.isGateHeld,
      stand:    this.stand,
      wakeCat:  this.wakeCat,
      eta:      this.eta, sta: this.sta, timeToLose: this.timeToLose, seqIdx: this.seqIdx,
      turnaround: this.turnaround ? this.turnaround.snapshot() : null,
    };
  }

  // ── Save / restore (机场运行状态保存，下次打开继续) ──────────────────────────
  /** Plain-JSON state for persistence. DONE flights are not worth saving. */
  serialize() {
    return {
      callsign: this.callsign, airline: this.airline, type: this.type,
      runway: this.runway, gateId: this.gateId, color: this.color,
      state: this.state, x: +this.x.toFixed(2), z: +this.z.toFixed(2), y: +(this.y || 0).toFixed(2),
      slot: this.slot, gateHold: this.gateHold, touchedDown: this.touchedDown,
      actualTurnaround: this.actualTurnaround,
      turnaroundT: this.turnaround ? +this.turnaround.t.toFixed(1) : null,
      milestones: this.milestones, stand: this.stand,
      takeoffX0: this._takeoffX0,
    };
  }

  /** Rebuild a live Flight from serialize() output. Position snaps to the
   *  rebuilt waypoint path, so motion resumes without teleporting. */
  static restore(d) {
    const f = new Flight({ callsign: d.callsign, airline: d.airline, type: d.type,
                           runway: d.runway, gateId: d.gateId, color: d.color });
    f.actualTurnaround = d.actualTurnaround ?? f.actualTurnaround;
    f.milestones  = d.milestones || {};
    f.stand       = d.stand ?? null;
    f.gateHold    = !!d.gateHold;
    f.touchedDown = !!d.touchedDown;
    f.slot        = d.slot || 0;
    f.state       = d.state;
    f._takeoffX0  = d.takeoffX0 || 0;

    if (d.state === FS.AT_GATE) {
      f._wi = f._wps.length - 1; f._wp = 0;                 // parked at the at_gate wp
      f.turnaround = new TurnaroundPlan(f.actualTurnaround, Date.now());
      f.turnaround.t = d.turnaroundT || 0;
      f.turnaround.update(0);                               // recompute node flags
    } else if (d.state === FS.PUSHBACK || d.state === FS.TAKEOFF) {
      f._wps = buildDeparturePath(d.runway, d.gateId, 0);   // full path, then snap
      f._snapToPath(d.x, d.z);
    } else if (d.state === FS.TAXIING_OUT || d.state === FS.HOLDING) {
      f._wps = buildDepartureTail(d.runway, f.slot, d.x, d.z);  // resumes from here
      f._wi = 0; f._wp = 0;
      f._spd = TAXI;
    } else {
      f._snapToPath(d.x, d.z);                              // TAXIING_IN on arrival path
    }

    const p = f.getPosition();
    f.x = p.x; f.z = p.z; f.y = p.y;
    // Re-derive segment speed from the last speed-tagged waypoint at/before _wi.
    for (let i = f._wi; i >= 0; i--) {
      if (f._wps[i] && f._wps[i].speed !== undefined) { f._spd = f._wps[i].speed || f._spd; break; }
    }
    if (d.state === FS.PUSHBACK) f._spd = TAXI * 0.45;
    return f;
  }

  /** Set _wi/_wp to the closest point of the current waypoint path to (x,z). */
  _snapToPath(x, z) {
    let best = { d: Infinity, i: 0, t: 0 };
    for (let i = 0; i < this._wps.length - 1; i++) {
      const a = this._wps[i], b = this._wps[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const len2 = dx * dx + dz * dz;
      const t = len2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2)) : 0;
      const px = a.x + dx * t, pz = a.z + dz * t;
      const dist = (x - px) * (x - px) + (z - pz) * (z - pz);
      if (dist < best.d) best = { d: dist, i, t };
    }
    this._wi = best.i; this._wp = best.t;
  }
}
