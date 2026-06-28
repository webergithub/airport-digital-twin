/**
 * Scheduler — auto-generates arrival flights on a configurable interval.
 * Mirrors elevator-app's passenger spawner / trainer pattern.
 */

const AIRLINES = [
  { name: '国航',  abbr: 'CA', color: 0x1a2a8a },
  { name: '东航',  abbr: 'MU', color: 0x1a6bb5 },
  { name: '南航',  abbr: 'CZ', color: 0x0e6b3e },
  { name: '海航',  abbr: 'HU', color: 0xcc3300 },
  { name: '厦航',  abbr: 'MF', color: 0xcc7700 },
  { name: '川航',  abbr: '3U', color: 0x7700cc },
  { name: '深航',  abbr: 'ZH', color: 0x003399 },
  { name: '首都',  abbr: 'JD', color: 0x0066aa },
];

const AC_TYPES = ['SMALL', 'MEDIUM', 'MEDIUM', 'MEDIUM', 'LARGE'];

export class Scheduler {
  constructor(api, config = {}) {
    this._api      = api;
    this._interval = config.arrivalInterval ?? 25;
    this._timer    = Math.random() * this._interval * 0.5; // stagger first spawn
    this._flightNo = 1000 + Math.floor(Math.random() * 500);
    this._paused   = false;
  }

  setInterval(seconds) {
    this._interval = Math.max(5, seconds);
  }

  pause()  { this._paused = true;  }
  resume() { this._paused = false; }

  update(dt) {
    if (this._paused) return;
    this._timer += dt;
    if (this._timer >= this._interval) {
      this._timer = 0;
      this._spawn();
    }
  }

  spawnNow() { this._spawn(); }

  _spawn() {
    const airline = AIRLINES[Math.floor(Math.random() * AIRLINES.length)];
    const type    = AC_TYPES[Math.floor(Math.random() * AC_TYPES.length)];
    const runway  = Math.random() < 0.55 ? 'RWY1' : 'RWY2';
    const num     = String(this._flightNo++);

    this._api.spawnArrival({
      callsign: `${airline.abbr}${num}`,
      airline:  airline.name,
      type,
      runway,
      color: airline.color,
    });
  }

  getStats() {
    return {
      nextIn:   Math.max(0, Math.round(this._interval - this._timer)),
      interval: this._interval,
    };
  }
}
