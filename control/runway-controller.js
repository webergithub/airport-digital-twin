/**
 * RunwayController — one per runway. Manages an ordered departure queue so that
 * departing aircraft line up WITHOUT overlapping (one on the runway threshold,
 * the rest stacked back along the taxiway) and only one rolls at a time.
 *
 * Slot 0 = runway threshold (holdX, rz). Slots ≥1 wait on Taxiway Alpha (Z=-10)
 * stacked west of the hold point. The front flight is cleared for takeoff only
 * when the previous departure has cleared the runway (x > CLEAR_X) and a minimum
 * separation has elapsed. See flight-manager.js buildDepartureTail for geometry.
 */

import { FS } from './flight-manager.js';

const MAX_QUEUE   = 4;   // bounded visible line-up (deepest slot stays on taxiway)
const MIN_SEP_SEC = 6;   // minimum time between successive takeoff clearances
const CLEAR_X     = 55;  // previous departure must roll past this (near the east end,
                         // ≈ airborne) before the next may enter the runway — keeps
                         // at most one aircraft on the runway at a time.

export class RunwayController {
  constructor(runway) {
    this.runway = runway;          // 'RWY1' | 'RWY2'
    this.queue = [];               // ordered flight ids, index === slot
    this.rolling = null;           // flight id currently rolling, or null
    this.lastReleaseT = -Infinity; // sim-clock seconds of last clearance
    this.sepFactor = 1;            // weather: multiplies the min separation gap
    this.closed = false;           // disruption: runway closed → no releases
  }

  enqueue(flight) {
    if (flight._queued) return;
    flight._queued = true;
    this.queue.push(flight.id);
    flight.slot = this.queue.length - 1;
    if (flight.slot > 0) flight.retargetSlot(flight.slot);
  }

  onAirborneDone(id) { if (this.rolling === id) this.rolling = null; }

  service(flights, clock, arrivalBusy = false) {
    // 1. Prune flights that have left the queue (rolling / done / gone).
    this.queue = this.queue.filter(id => {
      const f = flights.get(id);
      return f && !f.done && f.state !== FS.TAKEOFF && f.state !== FS.DONE;
    });

    // 2. Free the runway once the rolling departure has cleared.
    if (this.rolling) {
      const rf = flights.get(this.rolling);
      if (!rf || rf.done || rf.x > CLEAR_X) this.rolling = null;
    }

    // 3. Renumber slots in queue order; shuffle flights forward as gaps open.
    this.queue.forEach((id, i) => {
      const f = flights.get(id);
      if (f && f.slot !== i) f.retargetSlot(i);
    });

    // 4. Release the front flight if runway is open, clear of arrivals (AMAN
    //    coupling on the shared runway), and separation (widened by weather)
    //    has elapsed. A closed runway holds its queue.
    if (!this.closed && !arrivalBusy && this.queue.length && !this.rolling) {
      const front = flights.get(this.queue[0]);
      if (front && front.state === FS.HOLDING && front.slot === 0 &&
          (clock - this.lastReleaseT) >= MIN_SEP_SEC * this.sepFactor) {
        front.clearForTakeoff();
        this.rolling = front.id;
        this.lastReleaseT = clock;
        this.queue.shift();
      }
    }
  }

  /** Diagnostics for UI. */
  getStatus() {
    return { runway: this.runway, waiting: this.queue.length, rolling: this.rolling,
             closed: this.closed, sepFactor: this.sepFactor };
  }
}

export const RUNWAY_LIMITS = { MAX_QUEUE, MIN_SEP_SEC, CLEAR_X };
