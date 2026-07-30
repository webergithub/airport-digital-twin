/**
 * VDGS — Advanced Visual Docking Guidance System (A-VDGS).
 *
 * Every modern contact stand carries a Safedock-style display (ADB SAFEGATE
 * Safedock, TK Elevator A-VDGS): it verifies the inbound aircraft, then guides
 * the pilot down the lead-in line with a closing-distance countdown, a SLOW
 * band, and a STOP command at the exact parking position. The same units act as
 * apron sensors for A-CDM ("Digital Apron" / CORTEX): docking timestamps feed
 * turnaround intelligence.
 *
 * This engine is a pure snapshot consumer (like the RIMCAS safety net): it
 * derives each stand's display state from aircraft positions and never alters
 * control logic. The 3D layer mirrors the state onto a per-gate display board;
 * the panel lists all stands plus docking statistics.
 *
 * Geometry (world units, 1 u ≈ 8 m): the lead-in line runs (gate.x, z 0→12);
 * the stop position is z = 12, so capture range ≈ 96 m — matching the ~100 m
 * range of the real systems.
 */

import { getGates } from '../control/gate-layout.js';

const UNIT_M   = 8;      // 1 world unit ≈ 8 m (same as snapshot speed/altitude)
const STOP_Z   = 12;     // parking position (at_gate waypoint z)
const SLOW_M   = 16;     // SLOW band: closing distance below this many metres
const LANE_X   = 1.2;    // half-width of the lead-in corridor (world units)

export const VPH = {
  IDLE:   'idle',        // no traffic for this stand
  WAIT:   'wait',        // inbound assigned, not yet on the lead-in line
  CLOSE:  'closing',     // on the lead-in — countdown running
  SLOW:   'slow',        // final metres — slow command
  PARKED: 'parked',      // on blocks — display OK during the turnaround
};

export class VDGS {
  constructor() {
    this._ep = new Map();        // gateId → { captureSim } live docking episode
    this._dockings = 0;
    this._dockSum = 0;           // Σ capture→stop seconds (for the average)
    this._justDocked = [];       // completed this tick: { cs, gate, durSec }
    this._st = [];               // last computed per-gate states
  }

  /** Recompute every stand's display from one standard snapshot. */
  update(snapshot) {
    const now = snapshot.simTimeSec;
    this._justDocked = [];

    this._st = getGates().map(g => {
      // The stand's relevant aircraft: an arrival assigned here that is either
      // taxiing in or already on blocks. Departures (PUSHBACK…) blank the board.
      const f = snapshot.flights.find(x => x.gate === g.id &&
        (x.state === 'TAXIING_IN' || x.state === 'AT_GATE'));

      if (!f) { this._ep.delete(g.id); return this._mk(g.id, VPH.IDLE, null, null); }

      if (f.state === 'AT_GATE') {
        // Docking just completed → close the episode and record its duration.
        const ep = this._ep.get(g.id);
        if (ep) {
          const durSec = Math.max(0, +(now - ep.captureSim).toFixed(1));
          this._dockings++; this._dockSum += durSec;
          this._justDocked.push({ cs: f.callsign, gate: g.id, durSec });
          this._ep.delete(g.id);
        }
        return this._mk(g.id, VPH.PARKED, f.callsign, 0);
      }

      // TAXIING_IN: on the lead-in line yet? (on ground, in the lane, south of stop)
      const p = f.position;
      const onLane = p.y < 1 && Math.abs(p.x - g.x) < LANE_X && p.z > -0.5 && p.z < STOP_Z;
      if (!onLane) { this._ep.delete(g.id); return this._mk(g.id, VPH.WAIT, f.callsign, null); }

      if (!this._ep.has(g.id)) this._ep.set(g.id, { captureSim: now });
      const distM = Math.max(0, +((STOP_Z - p.z) * UNIT_M).toFixed(0));
      return this._mk(g.id, distM <= SLOW_M ? VPH.SLOW : VPH.CLOSE, f.callsign, distM);
    });
    return this._st;
  }

  /** Build one gate's state incl. the language-neutral LED display lines. */
  _mk(id, phase, cs, distM) {
    let l1 = '– –', l2 = '·', cls = '';
    if (phase === VPH.WAIT)   { l1 = cs; l2 = 'WAIT';            cls = 'vdgs-wait'; }
    if (phase === VPH.CLOSE)  { l1 = cs; l2 = `▼ ${distM}m`;     cls = 'vdgs-close'; }
    if (phase === VPH.SLOW)   { l1 = cs; l2 = `SLOW ${distM}m`;  cls = 'vdgs-slow'; }
    if (phase === VPH.PARKED) { l1 = cs; l2 = 'OK';              cls = 'vdgs-ok'; }
    return { id, phase, callsign: cs, distM, l1, l2, cls };
  }

  /** Dockings completed during the last update() call. */
  justDocked() { return this._justDocked; }

  getStatus() {
    return {
      gates: this._st,
      active: this._st.filter(s => s.phase === VPH.CLOSE || s.phase === VPH.SLOW).length,
      dockings: this._dockings,
      avgDockSec: this._dockings ? +(this._dockSum / this._dockings).toFixed(1) : 0,
    };
  }
}
