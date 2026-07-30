/**
 * GRFReporter — ICAO Global Reporting Format runway condition reporting.
 *
 * Since November 2021 every ICAO airport assesses runway surface state with
 * the Runway Condition Assessment Matrix (RCAM): each runway THIRD gets a
 * Runway Condition Code (RWYCC 6 dry … 0 wet ice), plus a contaminant
 * description, and the result is published as a Runway Condition Report (RCR)
 * to ATS/AIS. Pilots close the loop with braking-action AIREPs (GOOD …
 * LESS THAN POOR), which can trigger a downgrade.
 *
 * This module is a pure snapshot consumer: it derives each runway's RWYCC from
 * the twin's live weather level and winter (freezing/de-icing) state — the
 * same inputs that already drive separations and the What-If console — so the
 * published RCR always matches what the operation is experiencing. Landing
 * flights under degraded codes generate braking-action reports per the RCAM
 * equivalence. Code transitions are logged as downgrade/upgrade events.
 */

// RCAM-style mapping from the twin's weather level (0 VMC / 1 MVMC / 2 IMC /
// 3 LVP) to code + contaminant; winter freezing precip overrides downward.
const WX_CODE = [
  { code: 6, contam: 'grf.c.dry' },        // VMC  — dry
  { code: 5, contam: 'grf.c.wet' },        // MVMC — wet
  { code: 4, contam: 'grf.c.wetHeavy' },   // IMC  — wet (heavy rain)
  { code: 3, contam: 'grf.c.standing' },   // LVP  — standing water
];
const WINTER_CODE     = { code: 2, contam: 'grf.c.slush' }; // freezing precip
const WINTER_LVP_CODE = { code: 1, contam: 'grf.c.ice' };   // freezing + LVP

// RCAM equivalence: RWYCC → expected pilot braking action report.
export const BRAKING = {
  6: null,                 // dry — no report expected
  5: 'grf.b.good',
  4: 'grf.b.goodMedium',
  3: 'grf.b.medium',
  2: 'grf.b.mediumPoor',
  1: 'grf.b.poor',
  0: 'grf.b.lessPoor',
};

const AIREP_WINDOW = 3;    // ALDT within this many sim-s counts as "just landed"

export class GRFReporter {
  constructor() {
    this._rcr = {};          // rwy → { codes:[c,c,c], contamKey, updatedSim }
    this._aireps = [];       // recent braking reports, newest first
    this._changes = [];      // code transitions, newest first
    this._seenAirep = new Set();
  }

  update(snapshot) {
    const now = snapshot.simTimeSec;
    const wx = Math.max(0, Math.min(3, snapshot.disruptions ? snapshot.disruptions.weather : 0));
    const winter = !!(snapshot.deicing && snapshot.deicing.active);

    let eff = WX_CODE[wx];
    if (winter) eff = wx >= 3 ? WINTER_LVP_CODE : WINTER_CODE;

    for (const rw of snapshot.runways || []) {
      const key = rw.runway;
      const prev = this._rcr[key];
      if (!prev || prev.codes[0] !== eff.code) {
        if (prev) {
          this._changes.unshift({ rwy: key, from: prev.codes[0], to: eff.code,
                                  sim: +now.toFixed(1) });
          if (this._changes.length > 12) this._changes.pop();
        }
        // Uniform across the three thirds (TDZ/MID/ROLLOUT) — the twin has no
        // per-third contamination model yet; the RCR format still carries all
        // three as published.
        this._rcr[key] = { codes: [eff.code, eff.code, eff.code],
                           contamKey: eff.contam, updatedSim: +now.toFixed(1) };
      }
    }

    // Braking-action AIREPs: arrivals that just touched down under a degraded
    // code report per the RCAM equivalence (dry runways generate no reports).
    if (eff.code <= 5) {
      for (const f of snapshot.flights) {
        const aldt = f.milestones && f.milestones.ALDT;
        if (!aldt || now - aldt.sim > AIREP_WINDOW) continue;
        if (this._seenAirep.has(f.id)) continue;
        this._seenAirep.add(f.id);
        this._aireps.unshift({ cs: f.callsign, rwy: f.runway, code: eff.code,
                               actionKey: BRAKING[eff.code], sim: +now.toFixed(1) });
        if (this._aireps.length > 10) this._aireps.pop();
      }
    }
    if (this._seenAirep.size > 400) this._seenAirep.clear();   // bounded memory
  }

  getStatus() {
    const codes = Object.values(this._rcr).flatMap(r => r.codes);
    return {
      runways: Object.entries(this._rcr).map(([rwy, r]) => ({
        rwy, codes: [...r.codes], contamKey: r.contamKey, updatedSim: r.updatedSim,
      })),
      minCode: codes.length ? Math.min(...codes) : 6,
      aireps: this._aireps.slice(0, 6),
      changes: this._changes.slice(0, 6),
    };
  }
}
