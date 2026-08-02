/**
 * ARFFService — Rescue & Fire Fighting response drills (ICAO Annex 14 Ch. 9).
 *
 * Every aerodrome must field an RFFS sized by its fire CATEGORY (1–10, from
 * the largest aircraft served) and must be able to reach ANY point of an
 * operational runway and begin applying agent WITHIN 3 MINUTES of the alarm
 * (optimum conditions). Annual response-time drills are mandatory — airports
 * literally run the trucks against the clock.
 *
 * This module runs that drill in the twin: alarm → trucks en route → on-scene
 * agent application → stand-down, clocked against the 3-minute objective
 * (scaled to the sim timescale like every other process here). The drill
 * temporarily closes the exercised runway through the SAME public API the
 * What-If console uses, and reopens it on stand-down — unless the user had
 * already closed it manually, in which case that state is respected.
 */

const STANDARD_SEC = 18;   // scaled ICAO 3-minute objective (project timescale ≈ /10)
const ALARM_SEC    = 1.5;  // dispatch/turnout time (counts toward the response clock)
const ONSCENE_SEC  = 10;   // agent application + inspection before stand-down
export const FIRE_CATEGORY = 9;   // CAT 9 — largest type this twin serves (wide-body)

export class ARFFService {
  constructor() {
    this._phase = 'idle';    // idle | alarm | enroute | onscene | standdown
    this._rwy = null;
    this._t = 0;             // time in current phase
    this._enrouteDur = 0;
    this._responseSec = null;
    this._wasClosedByUs = false;
    this._history = [];      // { rwy, responseSec, pass, sim } newest first
  }

  get phase() { return this._phase; }
  get active() { return this._phase !== 'idle'; }

  /** Kick off a response-time drill on the given runway. */
  startDrill(api, runway) {
    if (this.active) return false;
    this._rwy = runway;
    this._phase = 'alarm';
    this._t = 0;
    // 10–22 sim-s run to the exercised point — most pass, some bust the clock.
    this._enrouteDur = 10 + Math.random() * 12;
    this._responseSec = null;
    // Close the runway for the exercise unless the user already closed it.
    this._wasClosedByUs = !api.runwaysClosed[runway];
    if (this._wasClosedByUs) api.closeRunway(runway);
    return true;
  }

  /** Advance the drill; call every tick with the sim dt and the api. */
  update(dt, api, nowSim) {
    if (!this.active || dt <= 0) return;
    this._t += dt;
    if (this._phase === 'alarm' && this._t >= ALARM_SEC) {
      this._phase = 'enroute'; this._t = 0;
    } else if (this._phase === 'enroute' && this._t >= this._enrouteDur) {
      this._responseSec = +(ALARM_SEC + this._enrouteDur).toFixed(1);
      this._phase = 'onscene'; this._t = 0;
    } else if (this._phase === 'onscene' && this._t >= ONSCENE_SEC) {
      this._phase = 'standdown'; this._t = 0;
      this._history.unshift({
        rwy: this._rwy,
        responseSec: this._responseSec,
        pass: this._responseSec <= STANDARD_SEC,
        sim: +(nowSim ?? 0).toFixed(1),
      });
      if (this._history.length > 8) this._history.pop();
      if (this._wasClosedByUs) api.openRunway(this._rwy);
    } else if (this._phase === 'standdown' && this._t >= 1.5) {
      this._phase = 'idle'; this._rwy = null;
    }
  }

  getStatus() {
    const last = this._history[0] ?? null;
    const passes = this._history.filter(h => h.pass).length;
    return {
      category: FIRE_CATEGORY,
      standardSec: STANDARD_SEC,
      phase: this._phase,
      rwy: this._rwy,
      phaseSec: +this._t.toFixed(1),
      // The run time is not knowable while the trucks are still rolling — it is
      // published only once they arrive (phase onscene/standdown).
      enrouteDur: (this._phase === 'onscene' || this._phase === 'standdown')
        ? +this._enrouteDur.toFixed(1) : null,
      responseSec: this._responseSec,
      last,
      drills: this._history.length,
      passRate: this._history.length ? Math.round(passes / this._history.length * 100) : null,
      history: this._history.slice(0, 5),
    };
  }
}
