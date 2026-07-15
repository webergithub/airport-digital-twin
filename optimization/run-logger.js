/**
 * RunLogger — records ALL running data for the digital twin.
 *
 *   • events     — every operational event (spawn/arrive/hold/takeoff/depart/…)
 *                  with sim-time + wall-clock.
 *   • snapshots  — periodic full JSON state snapshots (downsampled).
 *   • turnarounds — per-flight ground-handling timelines with each node's
 *                  start/end timestamps (captured on departure).
 *
 * The whole log is exportable as a single JSON document.
 */
import { t, tf } from '../simulation/i18n.js';

export class RunLogger {
  constructor(api, opts = {}) {
    this._api = api;
    this._events = [];
    this._snapshots = [];
    this._turnarounds = [];
    this._oooi = [];                             // raw ACARS-style OOOI stream
    this._simT = 0;
    this._snapEvery = opts.snapshotEverySec ?? 5;
    this._snapTimer = this._snapEvery;          // capture one immediately
    this._maxEvents = opts.maxEvents ?? 3000;
    this._maxSnaps  = opts.maxSnaps  ?? 1000;
    this._startedWall = Date.now();
    this._wire();
  }

  _wire() {
    const al = a => t('airline.' + a, a);
    const EV = {
      flight_spawned:  f => tf('log.spawned',  { cs: f.callsign, al: al(f.airline), rwy: f.runway, gate: f.gate ?? f.gateId }),
      flight_arrived:  f => tf('log.arrived',  { cs: f.callsign, gate: f.gateId }),
      atc_hold:        f => tf('log.atcHold',  { cs: f.callsign, rwy: f.runway }),
      tsat_release:    f => tf('log.tsat',     { cs: f.callsign, s: f.heldSec }),
      rimcas_alert:    d => tf('log.rimcas',   { rwy: d.runway, kind: d.stage === 2 ? t('sn.alarm') : t('sn.caution') }),
      flight_takeoff:  f => tf('log.takeoff',  { cs: f.callsign }),
      flight_departed: f => tf('log.departed', { cs: f.callsign }),
      no_gate:         f => tf('log.noGate',   { cs: f.callsign }),
      ground_stop:     () => t('log.groundStopCmd'),
      resume:          () => t('log.resume'),
      metering_on:     () => t('log.meterOn'),
      metering_off:    () => t('log.meterOff'),
    };
    for (const [type, fmt] of Object.entries(EV)) {
      this._api.on(type, (d) => {
        this.event(type, fmt(d || {}));
        if (type === 'flight_departed' && d && d.id) {
          const tl = this._api.getTurnaroundTimeline(d.id);
          if (tl) this._turnarounds.push({ flight: d.callsign, gate: d.gateId, simT: Math.round(this._simT), nodes: tl });
          if (this._turnarounds.length > 400) this._turnarounds.shift();
        }
      });
    }

    // Raw ACARS-style OOOI stream (Gate OUT / wheels OFF / wheels ON / gate IN).
    this._api.on('oooi', (e) => {
      this._oooi.push({ code: e.code, cs: e.callsign, gate: e.gate, rwy: e.runway, sim: e.sim, wall: e.wall });
      if (this._oooi.length > 2000) this._oooi.shift();
    });
  }

  event(type, text) {
    this._events.push({ wall: Date.now(), simT: +this._simT.toFixed(1), type, text });
    if (this._events.length > this._maxEvents) this._events.shift();
  }

  /** Called each logic tick with the standard snapshot. */
  tick(snapshot, dt) {
    this._simT = snapshot.simTimeSec;
    this._snapTimer += dt;
    if (this._snapTimer >= this._snapEvery) {
      this._snapTimer = 0;
      this._snapshots.push({
        simT: snapshot.simTimeSec, wall: snapshot.wallClock,
        gateUtil: +snapshot.stats.gateUtil.toFixed(3),
        onGround: snapshot.stats.onGround,
        arrivals: snapshot.stats.arrivals, departures: snapshot.stats.departures,
        metering: snapshot.metering,
        turnAtRisk: snapshot.flights.filter(f => f.turnAtRisk).length,
        flights: snapshot.flights.map(f => ({
          id: f.id, cs: f.callsign, state: f.state, gate: f.gate,
          pos: f.position, spd: f.speedMps, alt: f.altitudeM,
          held: f.holdingAtGate || undefined,     // omitted from JSON when false
          pobt: f.pobtSim ?? undefined,           // predicted off-block (at gate)
        })),
      });
      if (this._snapshots.length > this._maxSnaps) this._snapshots.shift();
    }
  }

  counts() {
    return { events: this._events.length, snapshots: this._snapshots.length, turnarounds: this._turnarounds.length };
  }

  recentOOOI(n = 24) { return this._oooi.slice(-n).reverse(); }

  recentEvents(n = 20) { return this._events.slice(-n).reverse(); }
  recentTurnarounds(n = 5) { return this._turnarounds.slice(-n).reverse(); }

  toJSON() {
    return {
      meta: { app: 'airport-twin', schemaVersion: '1.0', startedWall: this._startedWall, exportedWall: Date.now() },
      events: this._events,
      snapshots: this._snapshots,
      turnarounds: this._turnarounds,
      oooi: this._oooi,
    };
  }

  /** Trigger a browser download of the full run log as JSON. */
  download() {
    const blob = new Blob([JSON.stringify(this.toJSON(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url; a.download = `airport-twin-log-${ts}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
