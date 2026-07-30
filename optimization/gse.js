/**
 * GSEPool — ground support equipment pooling (GroundStar-style RMS).
 *
 * Handlers run their GSE — pushback tugs, baggage belt-loaders, catering
 * trucks, fuel bowsers, water/lavatory/waste units — as POOLED fleets managed
 * by a resource-management system (INFORM GroundStar, Amadeus): turnarounds
 * raise time-windowed equipment demand, the RMS allocates units, and the KPIs
 * that matter are fleet UTILISATION and SHORTAGE time (a turnaround waiting on
 * equipment burns its POBT margin).
 *
 * Advisory model: demand is read straight from each parked flight's live
 * turnaround plan — every ACTIVE service node claims one unit of its mapped
 * fleet (fuel only at remote stands; contact stands fuel via the hydrant).
 * Demand above a fleet's capacity is counted as shortage-seconds. Utilisation
 * is a rolling busy/capacity ratio per fleet. Nothing is steered.
 */

// Node.vehicle → fleet. water/lavatory/garbage share one sanitation pool.
const FLEET_OF = {
  tug: 'tug', baggage: 'baggage', catering: 'catering', fuel: 'bowser',
  water: 'sanitation', lavatory: 'sanitation', garbage: 'sanitation',
};

const FLEETS = [
  { id: 'tug',        key: 'gse.f.tug',        cap: 2 },
  { id: 'baggage',    key: 'gse.f.baggage',    cap: 3 },
  { id: 'catering',   key: 'gse.f.catering',   cap: 2 },
  { id: 'bowser',     key: 'gse.f.bowser',     cap: 2 },   // remote stands only
  { id: 'sanitation', key: 'gse.f.sanitation', cap: 3 },
];

const UTIL_WINDOW = 300;   // rolling utilisation window (sim-s)

export class GSEPool {
  constructor() {
    this._lastSim = null;
    this._short = Object.fromEntries(FLEETS.map(f => [f.id, 0]));   // shortage-seconds
    this._busyLog = [];    // { sim, busy: {fleet: n} } samples for the rolling window
    this._live = null;
  }

  update(snapshot) {
    const now = snapshot.simTimeSec;
    const dt = this._lastSim == null ? 0 : Math.max(0, now - this._lastSim);
    this._lastSim = now;

    const bridgeByGate = new Map((snapshot.gates || []).map(g => [g.id, !!g.hasBridge]));
    const demand = Object.fromEntries(FLEETS.map(f => [f.id, 0]));

    for (const f of snapshot.flights) {
      if (f.state !== 'AT_GATE' || !f.turnaround || !f.turnaround.nodes) continue;
      const contact = bridgeByGate.get(f.gate) === true;
      for (const n of f.turnaround.nodes) {
        if (!n.active) continue;
        // Node ids carry the vehicle implicitly via NODE_DEFS; the snapshot has
        // no vehicle field, so map from the node id prefix.
        const fleet = this._fleetForNode(n.id);
        if (!fleet) continue;
        if (fleet === 'bowser' && contact) continue;   // hydrant serves the bridge stands
        demand[fleet]++;
      }
    }

    const busy = {};
    for (const fl of FLEETS) {
      busy[fl.id] = Math.min(demand[fl.id], fl.cap);
      const short = Math.max(0, demand[fl.id] - fl.cap);
      if (dt > 0 && short > 0) this._short[fl.id] += short * dt;
    }
    if (dt > 0) {
      this._busyLog.push({ sim: now, busy });
      const cutoff = now - UTIL_WINDOW;
      while (this._busyLog.length && this._busyLog[0].sim < cutoff) this._busyLog.shift();
    }
    this._live = { demand, busy };
  }

  _fleetForNode(id) {
    if (id === 'PUSHBACK_TUG') return 'tug';
    if (id === 'UNLOAD_BAG' || id === 'LOAD_BAG') return 'baggage';
    if (id === 'CATERING') return 'catering';
    if (id === 'REFUEL') return 'bowser';
    if (id === 'WATER' || id === 'LAV' || id === 'GARBAGE') return 'sanitation';
    return null;                       // chocks/bridge/pax nodes need no pooled unit
  }

  getStatus() {
    const live = this._live || { demand: {}, busy: {} };
    const n = Math.max(1, this._busyLog.length);
    const fleets = FLEETS.map(f => {
      const avgBusy = this._busyLog.reduce((s, b) => s + (b.busy[f.id] || 0), 0) / n;
      const dem = live.demand[f.id] || 0;
      return {
        id: f.id, key: f.key, cap: f.cap,
        busy: live.busy[f.id] || 0,
        demand: dem,
        shortNow: Math.max(0, dem - f.cap),
        shortSec: +this._short[f.id].toFixed(1),
        utilPct: Math.round(avgBusy / f.cap * 100),
      };
    });
    const shortNowTotal = fleets.reduce((s, f) => s + f.shortNow, 0);
    return {
      fleets,
      shortNowTotal,
      shortSecTotal: +fleets.reduce((s, f) => s + f.shortSec, 0).toFixed(1),
      maxUtilPct: Math.max(...fleets.map(f => f.utilPct)),
    };
  }
}
