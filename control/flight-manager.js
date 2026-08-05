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
// Planned turnaround by aircraft class, sim-s (real equivalents ~25/45/90 min).
// This is the PLAN (drives TOBT); the realised duration draws the multiplier.
export const TURN_BY_TYPE = { SMALL: 45, MEDIUM: 60, LARGE: 85 };
const MIN_APPROACH = 6.5;            // sim-units/s (timescale-compressed); NOT a real airspeed

// Right-skewed turnaround multiplier: ~60% near-target, ~25% minor overrun,
// ~15% significant overrun — mirrors real ground-handling delay distributions.
// (removed) _turnFactor — the at-creation outcome lottery. Realised durations
// are now drawn per node, at node start, inside TurnaroundPlan.

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
    // Arrivals taxi west on their OWN inner taxiway (z=-6.5) — the outer one
    // (z=-10) belongs to the departure queue; sharing it deadlocks the field.
    { x: exitX,  z: -6.5, y: 0                                 },
    // The apron connector is dual-lane too: arrivals climb on the east side
    // (cx+1.6), departures descend on the west side (cx-1.6). Sharing one
    // connector puts an inbound and an outbound nose-to-nose on it, which real
    // separation can only resolve by both stopping — a permanent deadlock.
    { x: cx + 1.6, z: -6.5, y: 0                               },
    // Main-taxiway leg uses the RIGHT-HAND lane for its direction of travel
    // (dual-lane z=±1.1): head-on traffic is separated by geometry.
    { x: cx + 1.6, z: (gate.x > cx ? 1.1 : -1.1), y: 0         },
    { x: gate.x,   z: (gate.x > cx ? 1.1 : -1.1), y: 0         },
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
    // Main-taxiway leg takes the right-hand lane FOR ITS DIRECTION OF TRAVEL,
    // mirroring the arrival rule. A departure runs gate→cx, i.e. exactly
    // opposite to the arrival serving the same gate, so it must take the OTHER
    // lane — hard-coding one lane put both on the same strip of asphalt and,
    // with real separation, deadlocked every gate west of the connector.
    { x: gate.x,   z: (gate.x > cx ? -1.1 : 1.1), y: 0, speed: TAXI, tag: 'taxi_out' },
    { x: cx - 1.6, z: (gate.x > cx ? -1.1 : 1.1), y: 0                              },
    // Merge SOUTH of the queue line (z=-13), run west there, and only then step
    // up into the hold line. Dropping straight onto z=-10 parks the connector
    // exit on top of the queue's tail — two aircraft then block each other at
    // ninety degrees and the whole departure flow gridlocks.
    { x: cx - 1.6, z: -13, y: 0                                     },
  ];
  // ALL holds are hold-short ON THE TAXIWAY (z=-10) — never on the runway. Slot 0
  // is the hold-short line at holdX; waiting slots stack EAST of it (behind), so
  // flights line up in order without taxiing through the ones ahead. Only after
  // clearance does the front flight enter the runway and roll (the runway holds
  // at most one aircraft at a time — see RunwayController).
  const slotX = slot === 0 ? holdX : holdX + slot * SLOT_GAP;
  path.push({ x: slotX, z: -13, y: 0                              }); // west along the merge lane
  path.push({ x: slotX, z: -10, y: 0, speed: 0,    tag: 'holding' }); // step up into the queue
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

  // Not yet on the departure taxiway? Route down via the connector — using the
  // SAME departure-side lane as buildDeparturePath (cx-1.6). Re-slotting must
  // never rewrite the route back through geometry the aircraft already passed:
  // if it is already west of the connector, it simply turns south where it is,
  // otherwise it would double back into oncoming traffic.
  if (fromZ > -9) {
    const cxD = connX(fromX) - 1.6;
    const turnX = fromX <= cxD ? fromX : cxD;
    if (turnX !== fromX) path.push({ x: turnX, z: fromZ, y: 0 });
    path.push({ x: turnX, z: -13, y: 0 });     // down to the merge lane first
  } else if (fromZ > -12) {
    path.push({ x: fromX, z: -13, y: 0 });     // already near the queue: sidestep south
  }
  // Hold-short on the taxiway (never on the runway); waiting slots stack east.
  const slotX = slot === 0 ? holdX : holdX + slot * SLOT_GAP;
  path.push({ x: slotX, z: -13, y: 0                              });
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
    // Realised handling now emerges per-node inside TurnaroundPlan (drawn as
    // each service starts) — nothing is decided at aircraft creation anymore.
    this.actualTurnaround = turnaroundTime;

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
    // Speed-compliance factor: crews do not fly a metered speed exactly. Drawn
    // once per flight (±4%), it makes every ETA/STA carry real execution error.
    this._spdComply = 0.96 + Math.random() * 0.08;
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
      // Lightning ramp stop: outdoor ground handling pauses — turnaround
      // progress freezes and no pushback is initiated until the all-clear.
      if (this.turnaround && !this._rampHold) this.turnaround.update(dt, this._svcStretch ?? 1);
      // Depart once turnaround completes AND the DMAN gate hold (departure
      // metering — awaiting TSAT start-up approval) has been released.
      if ((!this.turnaround || this.turnaround.complete) && !this.gateHold && !this._rampHold) this._startDeparture();
      return;
    }

    // HOLDING: wait for RunwayController.clearForTakeoff() — no self-clearing timer.
    if (this.state === FS.HOLDING) { this.currentSpeed = 0; return; }

    // Winter de-icing hold: frozen at the apron until treatment completes (DCR).
    // Only ever set on a departing flight while TAXIING_OUT (DeiceManager).
    if (this._deiceHold) { this.currentSpeed = 0; return; }

    // Ground anti-overlap: traffic close ahead in this lane — hold position
    // (set per tick by AirportAPI; never set during TAKEOFF).
    if (this._blockAhead) { this.currentSpeed = 0; return; }

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
      spd = Math.max(MIN_APPROACH, Math.min(FAST, this._amanSpeed * this._spdComply));
    }

    // Remember the path cursor so a rejected move can be rolled back exactly.
    const wi0 = this._wi, wp0 = this._wp;
    this.currentSpeed = spd;
    this._wp += (spd * dt) / seg;
    if (this._wp >= 1) { this._wp = 0; this._advance(); }

    const p = this.getPosition();
    // Move-time separation guard (installed by AirportAPI): committed against
    // LIVE positions, so no aircraft can ever be driven through another —
    // a snapshot taken at the top of the tick would leave a gap where two
    // fast movers jump past each other between frames.
    if (this._sepGuard && !this._sepGuard(this, p.x, p.z, p.y)) {
      this._wi = wi0; this._wp = wp0;      // roll back: hold position this tick
      this.currentSpeed = 0;
      return;
    }
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
