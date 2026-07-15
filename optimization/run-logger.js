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
      weather_set:     d => tf('log.weather',  { w: d.key }),
      runway_closed:   d => tf('log.rwyClosed',{ r: d.runway }),
      runway_opened:   d => tf('log.rwyOpened',{ r: d.runway }),
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
          rwy: f.runway, hdg: f.headingDeg, type: f.type,   // for the replay radar
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

  // ── Surface replay (RECALL) ──────────────────────────────────────────────────
  /** Recorded sim-time span [min, max] of the snapshot buffer (null if empty). */
  span() {
    const s = this._snapshots;
    return s.length ? { min: s[0].simT, max: s[s.length - 1].simT } : null;
  }

  /** Notable events for the replay scrubber's incident rail (sim-time + runway). */
  getIncidents() {
    const KIND = { rimcas_alert: 'conflict', runway_closed: 'closed', ground_stop: 'stop', atc_hold: 'hold' };
    // rimcas/closed/stop are logged as events; derive their runway from the text if present.
    return this._events
      .filter(e => KIND[e.type])
      .map(e => ({ simT: e.simT, kind: KIND[e.type], type: e.type, text: e.text }));
  }

  /** Map a compact recorded snapshot to the standard radar/snapshot shape. */
  _toFrame(s) {
    return {
      simTimeSec: s.simT,
      flights: s.flights.map(f => ({
        id: f.id, callsign: f.cs, state: f.state, gate: f.gate, runway: f.rwy,
        type: f.type || 'MEDIUM', headingDeg: f.hdg || 0,
        position: f.pos, speedMps: f.spd, altitudeM: f.alt,
        holdingAtGate: !!f.held,
      })),
      gates: [],
    };
  }

  /**
   * Reconstruct a radar-shaped frame at an arbitrary sim-time by interpolating
   * between the two bracketing 5-second snapshots (positions lerped by id).
   */
  frameAt(simT) {
    const s = this._snapshots;
    if (!s.length) return null;
    if (simT <= s[0].simT) return this._toFrame(s[0]);
    if (simT >= s[s.length - 1].simT) return this._toFrame(s[s.length - 1]);
    let i = 0;
    while (i < s.length - 1 && s[i + 1].simT <= simT) i++;
    const a = s[i], b = s[i + 1];
    const u = (simT - a.simT) / ((b.simT - a.simT) || 1);
    const bById = new Map(b.flights.map(f => [f.id, f]));
    const frame = this._toFrame(b);           // states/headings from the later snapshot
    // Lerp positions for flights present in both bracketing snapshots.
    const aById = new Map(a.flights.map(f => [f.id, f]));
    for (const ff of frame.flights) {
      const fa = aById.get(ff.id), fb = bById.get(ff.id);
      if (fa && fb) {
        ff.position = {
          x: fa.pos.x + (fb.pos.x - fa.pos.x) * u,
          y: (fa.pos.y || 0) + ((fb.pos.y || 0) - (fa.pos.y || 0)) * u,
          z: fa.pos.z + (fb.pos.z - fa.pos.z) * u,
        };
      }
    }
    frame.simTimeSec = +simT.toFixed(1);
    return frame;
  }

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
