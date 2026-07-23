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
import { ArrivalManager } from './arrival-manager.js';

// ── DMAN departure metering (A-CDM TSAT / NASA ATD-2 surface metering) ────────
const METER_DEPTH = 3;  // hold at gate while runway demand (queue+rolling+pushback) ≥ this
const RELEASE_GAP = 8;  // min sim-seconds between successive TSAT start-up approvals

// ── Disruption / what-if (weather + closures) ────────────────────────────────
// Weather → capacity model (FAA AAR / ICAO LVP): each level widens runway
// separation (sep×), floors the arrival interval (aar = min seconds between
// arrivals, i.e. reduced Airport Acceptance Rate), and thickens scene fog.
const WEATHER = [
  { key: 'VMC',  sep: 1.0, aar: 0,  fog: 0.006 },   // 0 visual
  { key: 'MVMC', sep: 1.5, aar: 18, fog: 0.013 },   // 1 marginal
  { key: 'IMC',  sep: 2.2, aar: 30, fog: 0.021 },   // 2 instrument
  { key: 'LVP',  sep: 3.2, aar: 45, fog: 0.030 },   // 3 low-visibility procedures
];

export class AirportAPI {
  constructor(config = {}) {
    this._gates    = new GateManager();
    this._flights  = new Map();      // id → Flight
    this._handlers = {};
    this._groundStop   = false;
    this._activeRunways = config.runways ?? 2;

    // Per-runway departure sequencing + AMAN arrival sequencing
    this._runways = { RWY1: new RunwayController('RWY1'), RWY2: new RunwayController('RWY2') };
    this._arrivals = new ArrivalManager();
    this._clock   = 0;               // monotonic sim-seconds

    // DMAN departure metering: hold ready flights at the gate (engines off)
    // instead of in the runway queue when departures back up.
    this._metering = config.metering ?? true;
    this._meter    = { RWY1: { lastRelease: -Infinity }, RWY2: { lastRelease: -Infinity } };

    // Disruption / what-if state
    this._weather = 0;
    this._runwayClosed = { RWY1: false, RWY2: false };

    // Cumulative stats
    this._stats = { arrivals: 0, departures: 0 };
    this._throughputLog = [];        // timestamps of completed movements
  }

  // ── Disruption / what-if console ─────────────────────────────────────────────
  /** Set weather level 0–3; applies runway separation and returns the params
   *  { key, sep, aar, fog } so the caller can floor the scheduler + set fog. */
  setWeather(level) {
    this._weather = Math.max(0, Math.min(WEATHER.length - 1, level | 0));
    const w = WEATHER[this._weather];
    this._runways.RWY1.sepFactor = w.sep;
    this._runways.RWY2.sepFactor = w.sep;
    this.emit('weather_set', { level: this._weather, ...w });
    return w;
  }
  get weather() { return this._weather; }

  closeRunway(key) {
    if (!this._runways[key] || this._runwayClosed[key]) return;
    this._runwayClosed[key] = true;
    this._runways[key].closed = true;
    this.emit('runway_closed', { runway: key });
  }
  openRunway(key) {
    if (!this._runways[key] || !this._runwayClosed[key]) return;
    this._runwayClosed[key] = false;
    this._runways[key].closed = false;
    this.emit('runway_opened', { runway: key });
  }
  get runwaysClosed() { return { ...this._runwayClosed }; }
  hasDisruption() { return this._weather > 0 || this._runwayClosed.RWY1 || this._runwayClosed.RWY2; }
  weatherParams() { return WEATHER[this._weather]; }

  // ── Config ─────────────────────────────────────────────────────────────────
  setRunways(n) { this._activeRunways = Math.max(1, Math.min(2, n)); }
  groundStop()  { this._groundStop = true;  this.emit('ground_stop', {}); }
  resume()      { this._groundStop = false; this.emit('resume', {}); }

  /** Apply a new gate layout (already set via setGates) — prune stale occupancy. */
  reconfigureGates() { this._gates.reconfigure(); }

  /** DMAN departure metering on/off. With metering off, _serviceMetering issues
   *  every ready flight its start-up approval immediately (next tick). */
  setMetering(on) {
    this._metering = !!on;
    this.emit(this._metering ? 'metering_on' : 'metering_off', {});
  }
  get metering() { return this._metering; }

  // ── A-CDM milestones (Airport Collaborative Decision Making) ────────────────
  // Record a standard milestone timestamp on a flight (sim-sec + wall-clock).
  _milestone(flight, key, simSec = this._clock) {
    (flight.milestones ??= {})[key] = { sim: +simSec.toFixed(1), wall: Date.now() };
  }

  // Emit an ACARS-style OOOI event (Gate OUT / wheels OFF / wheels ON / gate IN),
  // the universal airline wire format the A-CDM milestones map onto:
  //   ON = ALDT (touchdown), IN = AIBT (in-block), OUT = AOBT (off-block), OFF = ATOT.
  _oooi(flight, code) {
    this.emit('oooi', {
      code, callsign: flight.callsign, gate: flight.gateId,
      runway: flight.runway, sim: +this._clock.toFixed(1), wall: Date.now(),
    });
  }

  // ── Flight spawning ────────────────────────────────────────────────────────
  spawnArrival({ callsign, airline, type, runway, color }) {
    // Override runway if only one active — allocator scores taxi distance from it.
    let rwy = this._activeRunways === 1 ? 'RWY1' : (runway ?? 'RWY1');
    // Reroute arrivals off a closed runway to the open one (dual-runway ops).
    const other = rwy === 'RWY1' ? 'RWY2' : 'RWY1';
    if (this._activeRunways > 1 && this._runwayClosed[rwy] && !this._runwayClosed[other]) rwy = other;

    const gate = this._gates.assignGate({ type, runway: rwy });
    if (!gate) {
      this.emit('no_gate', { callsign });
      return null;
    }
    const alloc = this._gates.lastAllocation();

    const flight = new Flight({ callsign, airline, type, runway: rwy, gateId: gate.id, color });
    flight.stand = alloc                       // stand-allocation rationale (RMS)
      ? { contact: alloc.contact, wide: alloc.wide, classMatch: alloc.classMatch, score: alloc.score }
      : { contact: !!gate.hasBridge, wide: !!gate.wide, classMatch: true, score: 1 };
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

      // Wheels-on (touchdown): stamp ALDT (Actual Landing Time) and emit the
      // OOOI 'ON' event. Kept distinct from ATA (stamped on final) so ASPM
      // taxi-in is a true wheels-on → in-block measurement.
      if (flight.touchedDown && !(flight.milestones && flight.milestones.ALDT)) {
        this._milestone(flight, 'ALDT');
        this._oooi(flight, 'ON');
      }

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
            // Every flight awaits a TSAT start-up approval from _serviceMetering
            // (issued immediately when metering is off) — single release path.
            flight.gateHold = true;
            this._oooi(flight, 'IN');           // gate IN (on blocks)
            this.emit('flight_arrived', flight.getStatus());
            break;
          case FS.PUSHBACK:
            this._milestone(flight, 'AOBT');    // Actual Off-Block Time (pushback)
            this._oooi(flight, 'OUT');          // gate OUT (off blocks)
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
            this._oooi(flight, 'OFF');          // wheels OFF (takeoff)
            this.emit('flight_takeoff', flight.getStatus());
            break;
          case FS.DONE:
            this._gates.vacate(flight.gateId);
            this._runways[flight.runway].onAirborneDone(flight.id);
            this._stats.departures++;
            this._throughputLog.push(this._clock);   // sim timebase (uniform with all KPIs)
            this.emit('flight_departed', flight.getStatus());
            // Keep in list briefly for FIDS, then prune — on the SIM clock so
            // fast-forward (__step) and live runs behave identically.
            flight._doneAtSim = this._clock;
            break;
        }
      }
    }

    // Prune DONE flights after a short sim-time linger (FIDS display grace).
    for (const [id, f] of this._flights) {
      if (f.state === FS.DONE && f._doneAtSim != null && this._clock - f._doneAtSim > 3) {
        this._flights.delete(id);
      }
    }

    // AMAN: sequence inbound traffic and meter approach speeds first.
    this._arrivals.service(this._flights, this._clock);

    // DMAN: issue TSAT start-up approvals before sequencing the runway queues.
    this._serviceMetering();

    // Sequence each runway's departure queue after all flights have advanced.
    // Departures hold while an arrival occupies the shared runway (AMAN coupling).
    this._runways.RWY1.service(this._flights, this._clock, this._arrivals.runwayBusy('RWY1'));
    this._runways.RWY2.service(this._flights, this._clock, this._arrivals.runwayBusy('RWY2'));

    // Prune old throughput entries (keep the last sim-hour; when running live
    // 1 sim-hour == 1 wall-hour, and under __step fast-forward it stays honest)
    const cutoff = this._clock - 3600;
    this._throughputLog = this._throughputLog.filter(t => t > cutoff);
  }

  // ── DMAN departure metering service ─────────────────────────────────────────
  // Every ready (turnaround-complete) flight waits at the gate for its TSAT
  // start-up approval. Metering off → all ready flights approved immediately.
  // Metering on → while the runway's departure demand is high, approvals are
  // issued one at a time (FIFO by ready time, RELEASE_GAP pacing), holding the
  // rest engines-off at the gate. Mirrors NASA ATD-2 / A-CDM pre-departure
  // sequencing.
  _serviceMetering() {
    for (const key of Object.keys(this._runways)) {
      const rc = this._runways[key];
      // Demand = queued + rolling + already approved but still pushing back.
      let demand = rc.queue.length + (rc.rolling ? 1 : 0);
      const ready = [];
      for (const f of this._flights.values()) {
        if (f.runway !== key) continue;
        if (f.state === FS.PUSHBACK) demand++;
        else if (f.state === FS.AT_GATE && f.gateHold && f.turnaround && f.turnaround.complete) {
          if (!f.milestones.ARDT) this._milestone(f, 'ARDT');   // Actual Ready Time
          ready.push(f);
        }
      }
      if (!ready.length) continue;
      ready.sort((a, b) => a.milestones.ARDT.sim - b.milestones.ARDT.sim);
      const m = this._meter[key];
      if (!this._metering) {
        for (const f of ready) this._approveStartup(f, m);      // no metering → immediate
      } else if (demand < METER_DEPTH && this._clock - m.lastRelease >= RELEASE_GAP) {
        this._approveStartup(ready[0], m);
      }
    }
  }

  /** Issue the TSAT start-up approval that releases a gate-held ready flight. */
  _approveStartup(f, meterState) {
    f.gateHold = false;
    this._milestone(f, 'TSAT');
    meterState.lastRelease = this._clock;
    const held = +(f.milestones.TSAT.sim - f.milestones.ARDT.sim).toFixed(1);
    if (held > 3) this.emit('tsat_release', { ...f.getStatus(), heldSec: held });
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
    const recent = this._throughputLog.filter(t => t > this._clock - 3600).length;
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

  // ── Predicted Off-Block Time (Assaia/Schiphol turnaround prediction) ────────
  // POBT = predicted turnaround-completion (ready) time = AIBT + total handling.
  // It is FROZEN at gate-in (= AIBT + totalSec), so it does NOT drift once
  // handling finishes: a subsequent DMAN gate hold (waiting for TSAT) is a
  // deliberate metering delay, not a turnaround overrun, and must not inflate
  // riskSec. riskSec = how far predicted readiness slips past the target
  // off-block (TOBT) — the ground-handling overrun; at-risk beyond ~10% tol.
  // Returns null when the flight is not in an active turnaround.
  _pobt(f) {
    if (f.state !== FS.AT_GATE || !f.turnaround) return null;
    const tobtSim = f.milestones?.TOBT?.sim ?? null;
    const aibtSim = f.milestones?.AIBT?.sim ?? this._clock;
    const pobtSim = +(aibtSim + f.turnaround.totalSec).toFixed(1);
    const tol = Math.max(6, 0.1 * f.turnaroundTime);
    const riskSec = tobtSim == null ? 0 : +(pobtSim - tobtSim).toFixed(1);
    return { pobtSim, tobtSim, riskSec, tol, atRisk: riskSec > tol };
  }

  /** Turnaround Control wall — one compact card per occupied gate, sorted
   *  worst-first (highest predicted-off-block risk). Powers the ops-wall panel. */
  getTurnaroundWall() {
    const cards = [];
    for (const f of this._flightObjects()) {
      const p = this._pobt(f);
      if (!p) continue;
      const nodes = f.turnaround.snapshot().nodes
        .map(n => ({ s: n.done ? 2 : n.active ? 1 : 0, c: n.color }));
      cards.push({
        flightId: f.id, callsign: f.callsign, airline: f.airline, gate: f.gateId,
        overall: +f.turnaround.overall.toFixed(3), held: f.isGateHeld,
        pobtSim: p.pobtSim, tobtSim: p.tobtSim, riskSec: p.riskSec,
        tol: +p.tol.toFixed(1), atRisk: p.atRisk, nodes,
      });
    }
    cards.sort((a, b) => (b.riskSec - a.riskSec) || (b.overall - a.overall));
    return { clock: +this._clock.toFixed(1), atRisk: cards.filter(c => c.atRisk).length, cards };
  }

  /** Stand-plan Gantt — every stand with its class and a rolling in-block
   *  occupancy bar (AIBT → actual/predicted off-block). Amadeus F-RMS style. */
  getStandPlan() {
    const now = this._clock;
    const winStart = now - 30, winEnd = now + 210;        // 4-min rolling window
    const byGate = new Map();
    for (const f of this._flightObjects()) if (f.gateId) byGate.set(f.gateId, f);

    const gates = this._gates.getOccupancy().gates.map(g => {
      const f = byGate.get(g.id);
      let bar = null, inbound = null;
      if (f) {
        const aibt = f.milestones?.AIBT?.sim ?? null;
        if (aibt == null) {
          inbound = { cs: f.callsign };                   // reserved; aircraft still inbound
        } else {
          const aobt = f.milestones?.AOBT?.sim ?? null;
          const p = this._pobt(f);
          const endSim = aobt != null ? aobt : (p ? p.pobtSim : now);
          bar = {
            cs: f.callsign, state: f.state, held: f.isGateHeld,
            startSim: +aibt.toFixed(1), endSim: +endSim.toFixed(1),
            predicted: aobt == null,                      // end is POBT (predicted) vs AOBT (actual)
          };
        }
      }
      return { id: g.id, terminal: g.terminal, wide: g.wide, contact: g.hasBridge, bar, inbound };
    });
    return { now: +now.toFixed(1), winStart: +winStart.toFixed(1), winEnd: +winEnd.toFixed(1), gates };
  }

  // ── Standard JSON data interface (data contract for UI / analytics / log) ────
  // A complete, serializable snapshot of all running data: aircraft positions,
  // speeds, altitudes, headings, gate/runway state, and per-flight turnaround.
  getSnapshot() {
    const UNIT_M = 8;                       // 1 world unit ≈ 8 m
    const R2D = 180 / Math.PI;
    const flights = this._flightObjects().map(f => {
      const dir = f.getDirection();
      const p = this._pobt(f);
      return {
        id: f.id, callsign: f.callsign, airline: f.airline, type: f.type,
        state: f.state, gate: f.gateId, runway: f.runway, slot: f.slot,
        position:   { x: +f.x.toFixed(2), y: +(f.y || 0).toFixed(2), z: +f.z.toFixed(2) },
        headingDeg: +(Math.atan2(dir.x, dir.z) * R2D).toFixed(1),
        speedMps:   +((f.currentSpeed || 0) * UNIT_M).toFixed(1),
        altitudeM:  +((f.y || 0) * UNIT_M).toFixed(1),
        milestones: f.milestones ?? {},        // A-CDM: ATA/AIBT/TOBT/ARDT/TSAT/AOBT/ATOT
        holdingAtGate: f.isGateHeld,           // DMAN gate hold (awaiting TSAT)
        pobtSim:    p ? p.pobtSim : null,      // predicted off-block (turnaround)
        turnAtRisk: p ? p.atRisk : false,      // POBT slips past TOBT tolerance
        stand:      f.stand ?? null,           // stand-allocation rationale (RMS)
        wakeCat:    f.wakeCat,                 // AMAN wake category (H/M/S)
        eta: f.eta, sta: f.sta, timeToLose: f.timeToLose, seqIdx: f.seqIdx,
        turnaround: f.turnaround ? f.turnaround.snapshot() : null,
      };
    });
    return {
      schemaVersion: '1.0',
      simTimeSec: +this._clock.toFixed(2),
      wallClock: Date.now(),
      activeRunways: this._activeRunways,
      groundStop: this._groundStop,
      metering: this._metering,
      disruptions: {
        weather:       this._weather,
        weatherKey:    WEATHER[this._weather].key,
        runwaysClosed: { ...this._runwayClosed },
        sepFactor:     WEATHER[this._weather].sep,
        active:        this.hasDisruption(),
      },
      flights,
      gates: this._gates.getOccupancy().gates,
      runways: [this._runways.RWY1.getStatus(), this._runways.RWY2.getStatus()],
      stats: this.getStats(),
    };
  }

  /** AMAN arrival ladder — per-runway inbound landing sequence (soonest first). */
  getArrivalLadder() { return this._arrivals.getLadder(); }

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
