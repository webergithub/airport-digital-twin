/**
 * DeiceManager — winter de-icing operations for departures.
 *
 * When freezing precipitation is active, a departing aircraft must be de-iced
 * before it may line up. Real airports run this as a capacity-limited process
 * (ICAO Doc 9640): a few de-icing positions, a queue when demand exceeds them,
 * a per-aircraft treatment time, and — critically — a HOLDOVER TIME (HOT): once
 * the anti-icing fluid is applied it only protects the surfaces for a limited
 * window, after which the aircraft must be treated again before it can depart.
 * A-CDM adds a "De-icing Company Ready" (DCR) status once treatment completes.
 *
 * This models APRON (on-stand exit) de-icing: on entering TAXIING_OUT the flight
 * is held at the apron, queued for a de-icing position, treated, then released to
 * its runway's departure queue with a HOT window started. HOT expiry while the
 * aircraft is still on the ground is counted as a breach (advisory — the twin
 * flags it rather than physically recycling the aircraft through the pad).
 *
 * Times are compressed to the sim timescale, consistent with the rest of the
 * twin (final approach ~4 s, wake separations ~8–14 s). The manager is INERT
 * unless activated: intercept() returns false when winter mode is off, so the
 * default (non-winter) departure path is completely unchanged.
 */

import { FS } from './flight-manager.js';

const PAD_CAP   = 2;    // de-icing positions working in parallel
const DEICE_SEC = 12;   // treatment time per aircraft (sim-seconds)
const HOT_SEC   = 75;   // holdover time — protection window after treatment (sim-seconds)

export class DeiceManager {
  constructor() {
    this._active = false;
    this._deicing = new Map();    // flightId → sim-time treatment completes
    this._queue = [];             // flightIds waiting for a position
    this._deicedTotal = 0;
    this._hotBreaches = 0;
    this._waitSum = 0;            // Σ (queue+treatment) wait, for the average
    this._maxQueue = 0;
  }

  setActive(on) { this._active = !!on; }
  get active() { return this._active; }

  /**
   * Called once when a flight enters TAXIING_OUT. If winter mode requires it,
   * hold the flight for de-icing and return true (caller must NOT enqueue it to
   * the runway yet). Returns false when no de-icing is needed — caller proceeds
   * exactly as before.
   */
  intercept(flight, clock) {
    if (!this._active || flight._deiceDone) return false;
    if (flight._deiceState && flight._deiceState !== 'none') return true;  // already handled
    flight._deiceState = 'queued';
    flight._deiceHold = true;                 // freeze at the apron (flight-manager honours this)
    flight._deiceQueuedSim = clock;
    this._queue.push(flight.id);
    return true;
  }

  /**
   * Advance de-icing each tick. Completes treatments, promotes the queue into
   * free positions, and accounts HOT breaches. Returns the flights that just
   * finished treatment (DCR) so the caller can release them to the runway queue.
   */
  service(flights, clock) {
    const ready = [];

    // Winter switched off mid-process → drain: release everything still held.
    if (!this._active) {
      if (this._deicing.size || this._queue.length) {
        for (const fid of [...this._deicing.keys(), ...this._queue]) {
          const f = flights.get(fid);
          if (f) { this._release(f, clock); ready.push(f); }
        }
        this._deicing.clear();
        this._queue.length = 0;
      }
      return ready;
    }

    // 1. Complete finished treatments.
    for (const [fid, endSim] of [...this._deicing]) {
      if (clock >= endSim) {
        this._deicing.delete(fid);
        const f = flights.get(fid);
        if (f) {
          this._release(f, clock);
          this._deicedTotal++;
          this._waitSum += Math.max(0, clock - (f._deiceQueuedSim ?? clock));
          ready.push(f);
        }
      }
    }

    // 2. Promote queued flights into any free position.
    while (this._deicing.size < PAD_CAP && this._queue.length) {
      const fid = this._queue.shift();
      const f = flights.get(fid);
      if (!f || f.state === FS.DONE) continue;
      f._deiceState = 'deicing';
      this._deicing.set(fid, clock + DEICE_SEC);
    }
    if (this._queue.length > this._maxQueue) this._maxQueue = this._queue.length;

    // 3. HOT breach accounting — a treated flight still on the ground past HOT.
    for (const [, f] of flights) {
      if (f._deiceState === 'holdover' && f._hotExpSim != null && clock > f._hotExpSim &&
          f.state !== FS.TAKEOFF && f.state !== FS.DONE && !f._hotBreached) {
        f._hotBreached = true;
        this._hotBreaches++;
      }
    }
    return ready;
  }

  /** Treatment complete (DCR): unfreeze, mark holdover, start the HOT window. */
  _release(f, clock) {
    f._deiceState = 'holdover';
    f._deiceDone = true;
    f._deiceHold = false;
    f._hotExpSim = clock + HOT_SEC;
  }

  /** Per-flight de-icing view for the snapshot (null when not in the process). */
  flightView(f, clock) {
    const st = f._deiceState;
    if (!st || st === 'none') return null;
    const hot = (st === 'holdover' && f._hotExpSim != null)
      ? Math.max(0, +(f._hotExpSim - clock).toFixed(1)) : null;
    return { state: st, hotRemainingSec: hot, hotBreached: !!f._hotBreached };
  }

  getStatus() {
    return {
      active:      this._active,
      padCap:      PAD_CAP,
      padBusy:     this._deicing.size,
      queueLen:    this._queue.length,
      deicedTotal: this._deicedTotal,
      hotBreaches: this._hotBreaches,
      avgWaitSec:  this._deicedTotal ? +(this._waitSum / this._deicedTotal).toFixed(1) : 0,
      maxQueue:    this._maxQueue,
      hotSec:      HOT_SEC,
    };
  }
}
