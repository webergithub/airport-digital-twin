/**
 * GateEnergyMonitor — apron energy & APU emissions (FEGP vs APU).
 *
 * A parked aircraft needs electrical power (and conditioned air). Without a
 * ground supply it runs its APU — a small jet engine burning ~130 kg/h with
 * CO₂/NOx and noise on the apron. Airports therefore install Fixed Electrical
 * Ground Power (FEGP) + pre-conditioned air at contact stands, ban unnecessary
 * APU use, and report the avoided emissions under ACI's Airport Carbon
 * Accreditation. Industry surveys put FEGP/PCA at >55% of contact stands but
 * <20% of remote positions — exactly the contact-vs-remote split this twin
 * already models (hasBridge on each stand).
 *
 * Pure snapshot consumer: every tick, each occupied stand's aircraft is either
 * on FEGP (contact stand — bridge implies the fixed supply) or on APU (remote
 * stand). It accrues APU fuel/CO₂, FEGP energy, the CO₂ avoided by FEGP, the
 * FEGP share of total gate time, and a per-airline APU league. Advisory only.
 */

const APU_KG_PER_S = 0.036;   // APU burn ≈130 kg/h of jet-A
const CO2_PER_KG   = 3.16;    // jet-A → CO₂ factor (same as analytics)
const FEGP_KW      = 90;      // typical 400 Hz FEGP draw while on stand

export class GateEnergyMonitor {
  constructor() {
    this._lastSim = null;
    this._apuSec = 0;
    this._fegpSec = 0;
    this._byAirline = new Map();   // airline → APU seconds
    this._live = [];
  }

  update(snapshot) {
    const now = snapshot.simTimeSec;
    const dt = this._lastSim == null ? 0 : Math.max(0, now - this._lastSim);
    this._lastSim = now;

    const flightsById = new Map(snapshot.flights.map(f => [f.id, f]));
    this._live = [];
    for (const g of snapshot.gates || []) {
      if (!g.flightId) continue;
      const f = flightsById.get(g.flightId);
      if (!f || f.state !== 'AT_GATE') continue;
      const fegp = !!g.hasBridge;          // contact stand → fixed supply available
      if (dt > 0) {
        if (fegp) this._fegpSec += dt;
        else {
          this._apuSec += dt;
          this._byAirline.set(f.airline, (this._byAirline.get(f.airline) || 0) + dt);
        }
      }
      this._live.push({ gate: g.id, cs: f.callsign, airline: f.airline, mode: fegp ? 'fegp' : 'apu' });
    }
  }

  getStatus() {
    const total = this._apuSec + this._fegpSec;
    const apuFuelKg = this._apuSec * APU_KG_PER_S;
    return {
      apuSec: +this._apuSec.toFixed(1),
      fegpSec: +this._fegpSec.toFixed(1),
      fegpSharePct: total > 0 ? +(this._fegpSec / total * 100).toFixed(0) : null,
      apuFuelKg: +apuFuelKg.toFixed(1),
      apuCO2Kg: +(apuFuelKg * CO2_PER_KG).toFixed(1),
      co2AvoidedKg: +(this._fegpSec * APU_KG_PER_S * CO2_PER_KG).toFixed(1),
      fegpKwh: +(this._fegpSec * FEGP_KW / 3600).toFixed(1),
      live: [...this._live],
      byAirline: [...this._byAirline.entries()]
        .sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([airline, sec]) => ({ airline, co2Kg: +(sec * APU_KG_PER_S * CO2_PER_KG).toFixed(1) })),
    };
  }
}
