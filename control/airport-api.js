/**
 * AirportAPI — public façade for the airport simulation.
 *
 * Mirrors elevator-app's ElevatorAPI pattern:
 *   api.spawnArrival({...})
 *   api.on('flight_landed', handler)
 *   api.update(dt)
 *   api.getAllFlights()
 */

import { Flight, FS } from './flight-manager.js';
import { GateManager } from './gate-manager.js';
import { RunwayController } from './runway-controller.js';

export class AirportAPI {
  constructor(config = {}) {
    this._gates    = new GateManager();
    this._flights  = new Map();      // id → Flight
    this._handlers = {};
    this._groundStop   = false;
    this._activeRunways = config.runways ?? 2;

    // Per-runway departure sequencing
    this._runways = { RWY1: new RunwayController('RWY1'), RWY2: new RunwayController('RWY2') };
    this._clock   = 0;               // monotonic sim-seconds

    // Cumulative stats
    this._stats = { arrivals: 0, departures: 0 };
    this._throughputLog = [];        // timestamps of completed movements
  }

  // ── Config ─────────────────────────────────────────────────────────────────
  setRunways(n) { this._activeRunways = Math.max(1, Math.min(2, n)); }
  groundStop()  { this._groundStop = true;  this.emit('ground_stop', {}); }
  resume()      { this._groundStop = false; this.emit('resume', {}); }

  /** Apply a new gate layout (already set via setGates) — prune stale occupancy. */
  reconfigureGates() { this._gates.reconfigure(); }

  // ── A-CDM milestones (Airport Collaborative Decision Making) ────────────────
  // Record a standard milestone timestamp on a flight (sim-sec + wall-clock).
  _milestone(flight, key, simSec = this._clock) {
    (flight.milestones ??= {})[key] = { sim: +simSec.toFixed(1), wall: Date.now() };
  }

  // ── Flight spawning ────────────────────────────────────────────────────────
  spawnArrival({ callsign, airline, type, runway, color }) {
    const gate = this._gates.assignGate();
    if (!gate) {
      this.emit('no_gate', { callsign });
      return null;
    }

    // Override runway if only one active
    const rwy = this._activeRunways === 1 ? 'RWY1' : (runway ?? 'RWY1');

    const flight = new Flight({ callsign, airline, type, runway: rwy, gateId: gate.id, color });
    this._flights.set(flight.id, flight);
    this._gates.occupy(gate.id, flight.id);
    this._stats.arrivals++;
    this._milestone(flight, 'ATA');           // Actual Time of Arrival (on final)
    this.emit('flight_spawned', flight.getStatus());
    return flight;
  }

  // ── Update ─────────────────────────────────────────────────────────────────
  update(dt) {
    this._clock += dt;

    for (const [id, flight] of this._flights) {
      const prevState = flight.state;
      flight.update(dt);

      // State transition events
      if (flight.state !== prevState) {
        switch (flight.state) {
          case FS.AT_GATE:
            this._milestone(flight, 'AIBT');    // Actual In-Block Time
            // Target Off-Block Time = in-block + planned turnaround (predicted).
            flight.milestones.TOBT = {
              sim: +(this._clock + flight.turnaroundTime).toFixed(1),
              wall: Date.now() + flight.turnaroundTime * 1000,
            };
            this.emit('flight_arrived', flight.getStatus());
            break;
          case FS.PUSHBACK:
            this._milestone(flight, 'AOBT');    // Actual Off-Block Time (pushback)
            break;
          case FS.TAXIING_OUT:
            // Left the gate apron → join its runway's departure queue (once).
            this._runways[flight.runway].enqueue(flight);
            break;
          case FS.HOLDING:
            this.emit('atc_hold', flight.getStatus());
            break;
          case FS.TAKEOFF:
            this._milestone(flight, 'ATOT');    // Actual Take-Off Time
            this.emit('flight_takeoff', flight.getStatus());
            break;
          case FS.DONE:
            this._gates.vacate(flight.gateId);
            this._runways[flight.runway].onAirborneDone(flight.id);
            this._stats.departures++;
            this._throughputLog.push(Date.now());
            this.emit('flight_departed', flight.getStatus());
            // Clean up after a short delay (keep in list briefly for FIDS)
            setTimeout(() => this._flights.delete(id), 3000);
            break;
        }
      }
    }

    // Sequence each runway's departure queue after all flights have advanced.
    this._runways.RWY1.service(this._flights, this._clock);
    this._runways.RWY2.service(this._flights, this._clock);

    // Prune old throughput entries (keep last 60 minutes)
    const cutoff = Date.now() - 3600000;
    this._throughputLog = this._throughputLog.filter(t => t > cutoff);
  }

  // ── Status ─────────────────────────────────────────────────────────────────
  getAllFlights() {
    return Array.from(this._flights.values())
      .filter(f => f.state !== FS.DONE)
      .map(f => f.getStatus());
  }

  getActiveFlight(id) { return this._flights.get(id) ?? null; }

  _flightObjects() {
    return Array.from(this._flights.values());
  }

  getStats() {
    const occ    = this._gates.getOccupancy();
    const active = Array.from(this._flights.values()).filter(f => f.state !== FS.DONE);
    // Simple hourly throughput from log
    const recent = this._throughputLog.filter(t => t > Date.now() - 3600000).length;
    return {
      arrivals:   this._stats.arrivals,
      departures: this._stats.departures,
      onGround:   active.length,
      gateUtil:   occ.utilization,
      throughput: recent,
    };
  }

  getGateOccupancy() { return this._gates.getOccupancy(); }

  // Expose raw flight objects for 3D layer
  getRawFlights() { return this._flightObjects(); }

  // ── Standard JSON data interface (data contract for UI / analytics / log) ────
  // A complete, serializable snapshot of all running data: aircraft positions,
  // speeds, altitudes, headings, gate/runway state, and per-flight turnaround.
  getSnapshot() {
    const UNIT_M = 8;                       // 1 world unit ≈ 8 m
    const R2D = 180 / Math.PI;
    const flights = this._flightObjects().map(f => {
      const dir = f.getDirection();
      return {
        id: f.id, callsign: f.callsign, airline: f.airline, type: f.type,
        state: f.state, gate: f.gateId, runway: f.runway, slot: f.slot,
        position:   { x: +f.x.toFixed(2), y: +(f.y || 0).toFixed(2), z: +f.z.toFixed(2) },
        headingDeg: +(Math.atan2(dir.x, dir.z) * R2D).toFixed(1),
        speedMps:   +((f.currentSpeed || 0) * UNIT_M).toFixed(1),
        altitudeM:  +((f.y || 0) * UNIT_M).toFixed(1),
        milestones: f.milestones ?? {},        // A-CDM: ATA/AIBT/TOBT/AOBT/ATOT
        turnaround: f.turnaround ? f.turnaround.snapshot() : null,
      };
    });
    return {
      schemaVersion: '1.0',
      simTimeSec: +this._clock.toFixed(2),
      wallClock: Date.now(),
      activeRunways: this._activeRunways,
      groundStop: this._groundStop,
      flights,
      gates: this._gates.getOccupancy().gates,
      runways: [this._runways.RWY1.getStatus(), this._runways.RWY2.getStatus()],
      stats: this.getStats(),
    };
  }

  /** Completed-flight turnaround timelines (node start/end timestamps). */
  getTurnaroundTimeline(id) {
    const f = this._flights.get(id);
    return f && f.turnaround ? f.turnaround.timeline() : null;
  }

  // ── Events ──────────────────────────────────────────────────────────────────
  on(event, fn) {
    (this._handlers[event] ??= []).push(fn);
    return this;
  }

  emit(event, data) {
    (this._handlers[event] ?? []).forEach(fn => fn(data));
    (this._handlers['*']   ?? []).forEach(fn => fn({ type: event, ...data }));
  }
}
