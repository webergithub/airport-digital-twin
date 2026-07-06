/**
 * Gate Manager — assigns and tracks gate occupancy.
 * Gate layout comes from the single source of truth in gate-layout.js.
 *
 * Stand allocation follows the rule/score pattern of real resource-management
 * systems (Amadeus F-RMS, INFORM GroundStar, ADB Safegate AiPRON): a hard
 * aircraft-size/stand-class constraint, then a weighted score over the free
 * compatible stands (contact preference, wide-stand conservation, taxi
 * distance from the arrival runway exit).
 */

import { getGates } from './gate-layout.js';

// Runway east-end exit x (arrivals roll out to here, then taxi in).
const EXIT_X = { RWY1: 45, RWY2: 55 };
// Scoring weights (sum = 1). Wide-stand conservation is enforced as a HARD
// pre-filter (see assignGate), not a weight, so it can't be out-voted here.
const W = { contact: 0.6, taxi: 0.4 };

export class GateManager {
  constructor() {
    this._occupied = new Map(); // gateId → flightId
    this._lastAlloc = null;     // reasoning for the most recent assignGate()
  }

  /**
   * Choose the best free stand for an arriving aircraft. Returns the gate, or
   * null if none is compatible/free. Records the scoring rationale in
   * lastAllocation(). Falls back to any-free when called without a spec.
   */
  assignGate(spec = {}) {
    const type   = spec.type ?? 'MEDIUM';
    const runway = spec.runway ?? 'RWY1';
    const free   = getGates().filter(g => !this._occupied.has(g.id));
    if (!free.length) { this._lastAlloc = null; return null; }

    // Hard stand-class rules (lexicographic, so they can't be out-scored):
    //  • a LARGE (wide-body) aircraft needs a wide stand;
    //  • a non-LARGE is kept OFF scarce wide stands while any narrow stand is
    //    free (wide-stand conservation), spilling onto a wide stand only under
    //    congestion. This prevents narrow-bodies from blocking wide-body stands.
    let eligible;
    if (type === 'LARGE') {
      eligible = free.filter(g => g.wide);
    } else {
      const narrow = free.filter(g => !g.wide);
      eligible = narrow.length ? narrow : free;
    }
    if (!eligible.length) { this._lastAlloc = null; return null; }   // → overflow

    const exitX = EXIT_X[runway] ?? 45;
    const dists = eligible.map(g => Math.abs(g.x - exitX));
    const dMin = Math.min(...dists), dMax = Math.max(...dists);

    let best = null;
    eligible.forEach((g, i) => {
      // Within the class-eligible set: prefer a contact (bridge) stand and a
      // shorter taxi from the arrival runway exit.
      const contact = g.hasBridge ? 1 : 0;
      const taxi    = dMax > dMin ? (dMax - dists[i]) / (dMax - dMin) : 1;
      const score   = W.contact * contact + W.taxi * taxi;
      if (!best || score > best.score) best = { g, score, contact: !!g.hasBridge, wide: !!g.wide };
    });

    this._lastAlloc = {
      gateId: best.g.id, score: +best.score.toFixed(3),
      contact: best.contact, wide: best.wide, type,
      // classMatch: aircraft placed on a size-appropriate stand (LARGE→wide,
      // non-LARGE→not wasting a wide stand).
      classMatch: type === 'LARGE' ? best.wide : !best.wide,
    };
    return best.g;
  }

  /** Rationale for the most recent assignGate() (null if none/overflow). */
  lastAllocation() { return this._lastAlloc; }

  occupy(gateId, flightId) { this._occupied.set(gateId, flightId); }
  vacate(gateId)            { this._occupied.delete(gateId); }
  isOccupied(gateId)        { return this._occupied.has(gateId); }
  getGate(gateId)           { return getGates().find(g => g.id === gateId) ?? null; }

  /** Drop occupancy entries for gates no longer present after a reconfigure. */
  reconfigure() {
    const valid = new Set(getGates().map(g => g.id));
    for (const id of [...this._occupied.keys()]) {
      if (!valid.has(id)) this._occupied.delete(id);
    }
  }

  getOccupancy() {
    const gates = getGates();
    return {
      total:    gates.length,
      occupied: this._occupied.size,
      utilization: gates.length ? this._occupied.size / gates.length : 0,
      gates:    gates.map(g => ({
        id:       g.id,
        terminal: g.terminal,
        x:        g.x,
        z:        g.z,
        hasBridge: g.hasBridge,
        wide:     !!g.wide,
        flightId: this._occupied.get(g.id) ?? null,
      })),
    };
  }
}
