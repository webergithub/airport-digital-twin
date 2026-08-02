/**
 * NoiseMonitor — an ANOMS-style airport Noise & Operations Monitoring System.
 *
 * Real airports (EMS Brüel & Kjær ANOMS, Casper NoiseLab, Toronto Pearson's
 * NMT network) run fixed Noise Monitoring Terminals around the field and in
 * surrounding communities. Each terminal continuously measures LAmax; when the
 * level stays above the site threshold long enough it becomes a NOISE EVENT
 * that is correlated to the causing aircraft operation. Airports publish
 * N-above counts (events over 65/80/90 dB), per-airline league tables, and —
 * in the UK — charge night movements against a Quota Count (QC) budget where
 * noisier types burn more quota.
 *
 * This module is a pure snapshot consumer (zero control-layer impact): per NMT
 * it sums the acoustic energy of every aircraft (phase base level, wake-class
 * offset, spherical spreading with ground absorption), detects events with a
 * threshold + minimum-duration rule (real systems use ~5 s; scaled to the
 * twin's compressed timescale), and keeps the published statistics.
 */

// NMT sites (world units; 1 u ≈ 8 m). Thresholds follow practice: field
// boundary sites tolerate more than community sites (day threshold ~65 dBA).
export const NMT_SITES = [
  { id: 'NMT1', key: 'noise.s.west',  x: -140, z: -30, thrDb: 75 },  // west approach corridor
  { id: 'NMT2', key: 'noise.s.east',  x:  120, z: -33, thrDb: 75 },  // east departure corridor
  { id: 'NMT3', key: 'noise.s.north', x:    0, z:  60, thrDb: 65 },  // northern community
  { id: 'NMT4', key: 'noise.s.south', x:  -20, z: -90, thrDb: 75 },  // southern field boundary
];

const UNIT_M   = 8;      // world unit → metres (project-wide convention)
const REF_M    = 100;    // base levels are LAmax at 100 m slant distance
const MIN_M    = 40;     // clamp slant distance (avoid singularity overhead)
const DECAY    = 22;     // dB per decade — spherical spreading + ground absorption
const FLOOR_DB = 38;     // ambient floor shown when it's quiet
const EVENT_MIN_SIM = 2; // event must persist this many sim-s (real rule: ~5 s)

// LAmax base level at 100 m by flight phase (typical published figures).
function baseDb(f) {
  if (f.state === 'TAKEOFF') return 95;                      // departure roll / initial climb
  if (f.state === 'TAXIING_IN' && f.altitudeM > 4) return 88; // on approach / landing
  if (f.state === 'TAXIING_IN' || f.state === 'TAXIING_OUT' ||
      f.state === 'PUSHBACK'   || f.state === 'HOLDING') return 68;  // ground ops
  return 0;                                                  // at gate / done → negligible
}
const CAT_DB = { H: 4, M: 0, S: -5 };                        // wake class loudness offset
const QC     = { H: 2, M: 1, S: 0.5 };  // illustrative QC-style points by wake class
                                        // (real QC is per certificated type, not wake)

export class NoiseMonitor {
  constructor() {
    this._st = NMT_SITES.map(s => ({
      site: s, db: FLOOR_DB, lmax: FLOOR_DB,
      over: null,              // live episode: { startSim, peakDb, cs }
      alerting: false,
    }));
    this._events = [];         // recent closed events, newest first
    this._nAbove = { 65: 0, 80: 0, 90: 0 };
    this._qc = 0;
    this._byAirline = new Map();  // airline → event count
  }

  /** Recompute every terminal from one standard snapshot. */
  update(snapshot) {
    const now = snapshot.simTimeSec;
    for (const m of this._st) {
      // Energy-sum every aircraft's contribution at this terminal.
      let sum = Math.pow(10, FLOOR_DB / 10);
      let loudest = null, loudestDb = -1;
      for (const f of snapshot.flights) {
        const base = baseDb(f);
        if (!base) continue;
        const dx = (f.position.x - m.site.x), dz = (f.position.z - m.site.z);
        const slantM = Math.max(MIN_M,
          Math.hypot(dx * UNIT_M, dz * UNIT_M, f.altitudeM || 0));
        const db = base + (CAT_DB[f.wakeCat] ?? 0) - DECAY * Math.log10(slantM / REF_M);
        if (db > loudestDb) { loudestDb = db; loudest = f; }
        sum += Math.pow(10, db / 10);
      }
      m.db = +(10 * Math.log10(sum)).toFixed(1);
      if (m.db > m.lmax) m.lmax = m.db;

      // Threshold + minimum-duration event rule, correlated to the loudest op.
      if (m.db >= m.site.thrDb) {
        if (!m.over) m.over = { startSim: now, peakDb: m.db, cs: null, airline: null };
        if (m.db >= m.over.peakDb || m.over.cs == null) {
          m.over.peakDb = Math.max(m.over.peakDb, m.db);
          if (loudest) { m.over.cs = loudest.callsign; m.over.airline = loudest.airline; }
        }
        m.alerting = (now - m.over.startSim) >= EVENT_MIN_SIM;
      } else if (m.over) {
        const dur = now - m.over.startSim;
        if (dur >= EVENT_MIN_SIM) this._closeEvent(m, dur, now);
        m.over = null; m.alerting = false;
      }
    }
  }

  _closeEvent(m, durSec, now) {
    const cat = m.over.cs ? (m.over.cs && this._catOf(m.over)) : 'M';
    const ev = {
      site: m.site.id, cs: m.over.cs ?? '—', airline: m.over.airline ?? null,
      peakDb: +m.over.peakDb.toFixed(1), durSec: +durSec.toFixed(1),
      sim: +now.toFixed(1), qc: QC[cat] ?? 1,
    };
    this._events.unshift(ev);
    if (this._events.length > 40) this._events.pop();
    for (const band of [65, 80, 90]) if (ev.peakDb >= band) this._nAbove[band]++;
    this._qc += ev.qc;
    if (ev.airline) this._byAirline.set(ev.airline, (this._byAirline.get(ev.airline) || 0) + 1);
  }

  // Wake class of the event's aircraft is not carried on the episode — infer a
  // QC-relevant class from the peak level instead (louder peak → noisier type).
  _catOf(over) { return over.peakDb >= 88 ? 'H' : over.peakDb >= 78 ? 'M' : 'S'; }

  getStatus() {
    const total = Object.values(this._nAbove)[0] != null ? this._nAbove[65] : 0;
    return {
      nmts: this._st.map(m => ({
        id: m.site.id, key: m.site.key, thrDb: m.site.thrDb,
        db: m.db, lmax: +m.lmax.toFixed(1), alerting: m.alerting,
      })),
      events: this._events.slice(0, 8),
      nAbove: { ...this._nAbove },
      totalEvents: total,
      qc: +this._qc.toFixed(1),
      maxDb: Math.max(...this._st.map(m => m.db)),
      byAirline: [...this._byAirline.entries()]
        .sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([airline, n]) => ({ airline, n })),
    };
  }
}
