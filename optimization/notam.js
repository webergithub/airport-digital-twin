/**
 * NOTAMBoard — the aerodrome's notice publication layer (ICAO Annex 15).
 *
 * Every operationally significant state an airport enters is PUBLISHED: a
 * NOTAM with a five-letter Q-code and a serial (A0007/26), exchanged between
 * NOTAM offices in the Annex 15 / Doc 8126 machine format; winter runway
 * state goes out as a SNOWTAM — the special-series NOTAM that carries the GRF
 * Runway Condition Report; a condition that ends is cancelled with a NOTAMC.
 *
 * This module is the twin's capstone glue: it watches the statuses the other
 * modules already publish and keeps the board in sync —
 *   runway closed            → QMRLC   LVP in force          → QFALV
 *   freezing precip/de-icing → QFAFP   lightning ramp stop   → QFALS
 *   AGL below CAT minima     → QLRAS   wildlife HIGH         → QFAHX
 *   fuel stock low           → QFUAU
 * plus a SNOWTAM block whenever the published RWYCC drops below 6.
 * Pure consumer: it never changes what it reports on.
 */

const RULES = [
  { id: 'rwy1', q: 'QMRLC', key: 'ntm.rwyClosed', p: () => ({ rwy: 'RWY1' }),
    when: (d) => d.snapshot.disruptions.runwaysClosed.RWY1 },
  { id: 'rwy2', q: 'QMRLC', key: 'ntm.rwyClosed', p: () => ({ rwy: 'RWY2' }),
    when: (d) => d.snapshot.disruptions.runwaysClosed.RWY2 },
  { id: 'lvp', q: 'QFALV', key: 'ntm.lvp', p: () => ({}),
    when: (d) => d.snapshot.disruptions.weather >= 3 },
  { id: 'winter', q: 'QFAFP', key: 'ntm.winter', p: () => ({}),
    when: (d) => d.snapshot.deicing && d.snapshot.deicing.active },
  { id: 'ramp', q: 'QFALS', key: 'ntm.rampStop', p: () => ({}),
    when: (d) => d.snapshot.disruptions.lightning &&
                 d.snapshot.disruptions.lightning.phase !== 'normal' },
  { id: 'agl', q: 'QLRAS', key: 'ntm.aglBelow', p: (d) => ({
      c: d.agl.circuits.filter(c => c.critical && c.status === 'below').map(c => c.id).join('/') || '—' }),
    when: (d) => d.agl && d.agl.anyCritBelow },
  { id: 'wild', q: 'QFAHX', key: 'ntm.wildlife', p: (d) => ({
      rwy: Object.entries(d.wildlife.risk).filter(([, v]) => v === 'high').map(([k]) => k).join('/') || '—' }),
    when: (d) => d.wildlife && d.wildlife.worst === 'high' },
  { id: 'fuel', q: 'QFUAU', key: 'ntm.fuelLow', p: () => ({}),
    when: (d) => d.fuel && d.fuel.low },
];

export class NOTAMBoard {
  constructor() {
    this._serial = 0;
    this._active = new Map();   // rule id → bulletin
    this._cancelled = [];       // recent NOTAMC, newest first
  }

  update(d) {
    const now = d.snapshot.simTimeSec;
    for (const r of RULES) {
      const on = !!r.when(d);
      const cur = this._active.get(r.id);
      if (on && !cur) {
        this._serial++;
        this._active.set(r.id, {
          serial: `A${String(this._serial).padStart(4, '0')}/26`,
          q: r.q, key: r.key, params: r.p(d), sinceSim: +now.toFixed(1),
        });
      } else if (on && cur && r.p) {
        cur.params = r.p(d);               // live params (e.g. which circuits)
      } else if (!on && cur) {
        this._active.delete(r.id);
        this._cancelled.unshift({ ...cur, cancelledSim: +now.toFixed(1) });
        if (this._cancelled.length > 6) this._cancelled.pop();
      }
    }

    // SNOWTAM: the GRF RCR goes out whenever any published code is below 6.
    this._snowtam = null;
    if (d.grf && d.grf.minCode < 6) {
      this._snowtam = {
        runways: d.grf.runways.map(r => ({
          rwy: r.rwy, codes: r.codes.join('/'), contamKey: r.contamKey,
        })),
        updatedSim: +now.toFixed(1),
      };
    }
  }

  getStatus() {
    return {
      active: [...this._active.values()].sort((a, b) => a.serial.localeCompare(b.serial)),
      cancelled: this._cancelled.slice(0, 4),
      snowtam: this._snowtam,
      issued: this._serial,
    };
  }
}
