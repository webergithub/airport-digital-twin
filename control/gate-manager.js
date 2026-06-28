/**
 * Gate Manager — assigns and tracks gate occupancy.
 * Gate layout comes from the single source of truth in gate-layout.js.
 */

import { getGates } from './gate-layout.js';

export class GateManager {
  constructor() {
    this._occupied = new Map(); // gateId → flightId
  }

  /** Returns a free gate (random). Null if all occupied. */
  assignGate() {
    const free = getGates().filter(g => !this._occupied.has(g.id));
    if (!free.length) return null;
    return free[Math.floor(Math.random() * free.length)];
  }

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
        flightId: this._occupied.get(g.id) ?? null,
      })),
    };
  }
}
