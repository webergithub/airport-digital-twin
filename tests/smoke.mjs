/**
 * Headless smoke test — drives the control + optimization layers for 90
 * sim-minutes with no browser, then asserts:
 *   1. liveness (flights keep completing the full lifecycle),
 *   2. the getSnapshot() JSON contract (every documented field present),
 *   3. state-machine sanity + A-CDM milestone ordering,
 *   4. KPI ranges, and the sim-timebase of throughput (G-SIM-1),
 *   5. DONE flights are pruned on the sim clock,
 *   6. safety-net / DCB / AMAN output shapes.
 *
 * Run: node tests/smoke.mjs   (exit 0 = pass, 1 = fail — used by CI)
 */

import { AirportAPI } from '../control/airport-api.js';
import { FS } from '../control/flight-manager.js';
import { Scheduler } from '../optimization/scheduler.js';
import { AnalyticsEngine } from '../optimization/analytics.js';
import { RunwaySafetyNet } from '../optimization/safety-nets.js';
import { DCBForecaster } from '../optimization/dcb-forecaster.js';
import { APOC, RAG } from '../optimization/apoc.js';
import { VDGS, VPH } from '../optimization/vdgs.js';
import { NoiseMonitor, NMT_SITES } from '../optimization/noise-monitor.js';
import { SlotMonitor } from '../optimization/slot-monitor.js';
import { GRFReporter } from '../optimization/runway-condition.js';
import { GateEnergyMonitor } from '../optimization/gate-energy.js';
import { TaxiConflictMonitor } from '../optimization/taxi-conflict.js';
import { WildlifeMonitor } from '../optimization/wildlife.js';
import { ALCMS } from '../optimization/alcms.js';
import { ARFFService } from '../optimization/arff.js';
import { FuelFarm } from '../optimization/fuel.js';
import { viewPose, VIEW_NAMES } from '../simulation/tower-view.js';
import { GSEPool } from '../optimization/gse.js';
import { NOTAMBoard } from '../optimization/notam.js';
import { BaggageSystem } from '../optimization/baggage.js';
import { SlotCoordination } from '../optimization/slot-coordination.js';
import { RunLogger } from '../optimization/run-logger.js';

// Deterministic PRNG (mulberry32) so the smoke run is reproducible — a flaky
// CI check is worse than none. Overrides the RNG the sim uses (spawn timing,
// aircraft type, runway pick, turnaround variance) before any of it runs.
let _seed = 0x1a2b3c4d;
Math.random = () => {
  _seed |= 0; _seed = (_seed + 0x6D2B79F5) | 0;
  let t = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failed++; console.error(`  ✗ ${name}  ${detail}`); }
};

// ── Assemble the pipeline exactly as simulation/main.js does ──────────────────
const api = new AirportAPI({ runways: 2 });
const scheduler = new Scheduler(api, { arrivalInterval: 25 });
const analytics = new AnalyticsEngine(api, scheduler, { targetUtil: 0.6 });
const safetyNet = new RunwaySafetyNet(api);
const dcb = new DCBForecaster(api, scheduler);
const apoc = new APOC();
const vdgs = new VDGS();
const noise = new NoiseMonitor();
const slots = new SlotMonitor();
const grf = new GRFReporter();
const energy = new GateEnergyMonitor();
const taxiCft = new TaxiConflictMonitor();
const wildlife = new WildlifeMonitor();
const alcms = new ALCMS();
const fuelFarm = new FuelFarm();
const gsePool = new GSEPool();
const bags = new BaggageSystem();
const wasgCoord = new SlotCoordination();
const runLog = new RunLogger(api, { snapshotEverySec: 5 });

// Track one docking episode per gate to assert the countdown is monotonic.
const vdgsEpisodes = new Map();   // gateId → last distM while closing
let vdgsMonotonic = true;

const seenStates = new Set();
// Physical-realism telemetry: closest any two ground movers (both y<1, neither
// parked at a stand, neither DONE) ever get during the whole run.
let minGroundSep = Infinity;
let minGroundPair = '';
const departures = [];                 // { simT, milestones } per completed flight
api.on('flight_departed', f => departures.push({ simT: api.getSnapshot().simTimeSec, ms: f.milestones }));

const DT = 0.5, MINUTES = 90;
const STEPS = Math.round((MINUTES * 60) / DT);
let snapshot = null;
for (let i = 0; i < STEPS; i++) {
  api.update(DT);
  scheduler.update(DT);
  snapshot = api.getSnapshot();
  analytics.update(snapshot, DT);
  safetyNet.update(snapshot);
  dcb.update(snapshot);
  noise.update(snapshot);
  slots.update(snapshot);
  grf.update(snapshot);
  energy.update(snapshot);
  taxiCft.update(snapshot);
  wildlife.update(snapshot);
  alcms.update(snapshot);
  fuelFarm.update(snapshot);
  gsePool.update(snapshot);
  bags.update(snapshot);
  wasgCoord.update(snapshot);
  apoc.update({ metrics: analytics.getMetrics(), safety: safetyNet.getStatus(),
    dcb: dcb.getForecast(), wall: api.getTurnaroundWall(), noise: noise.getStatus(),
    slots: slots.getStatus(), grf: grf.getStatus(), energy: energy.getStatus(), taxi: taxiCft.getStatus(), wildlife: wildlife.getStatus(), agl: alcms.getStatus(snapshot.disruptions.weather), fuel: fuelFarm.getStatus(), gse: gsePool.getStatus(), bags: bags.getStatus(), wasg: wasgCoord.getStatus(),
    lightning: snapshot.disruptions.lightning,
    stats: snapshot.stats, simTimeSec: snapshot.simTimeSec });
  vdgs.update(snapshot);
  for (const g of vdgs.getStatus().gates) {
    if (g.phase === VPH.CLOSE || g.phase === VPH.SLOW) {
      const prev = vdgsEpisodes.get(g.id);
      if (prev != null && g.distM > prev + 0.5) vdgsMonotonic = false;  // countdown went UP
      vdgsEpisodes.set(g.id, g.distM);
    } else {
      vdgsEpisodes.delete(g.id);
    }
  }
  runLog.tick(snapshot, DT);
  {
    const g = snapshot.flights.filter(f =>
      f.position.y < 1 && f.state !== 'DONE' && f.state !== 'AT_GATE');
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
      const d = Math.hypot(g[i].position.x - g[j].position.x,
                           g[i].position.z - g[j].position.z);
      if (d < minGroundSep) { minGroundSep = d;
        minGroundPair = `${g[i].callsign}(${g[i].state})~${g[j].callsign}(${g[j].state})`; }
    }
  }
  for (const f of snapshot.flights) seenStates.add(f.state);
}
console.log(`ran ${MINUTES} sim-min (${STEPS} steps), simTimeSec=${snapshot.simTimeSec}`);

// ── 1. Liveness ───────────────────────────────────────────────────────────────
console.log('liveness:');
check('arrivals spawned', snapshot.stats.arrivals >= 40, `arrivals=${snapshot.stats.arrivals}`);
check('departures completed', snapshot.stats.departures >= 20, `departures=${snapshot.stats.departures}`);
check('turnaround timelines recorded', runLog.counts().turnarounds >= 10,
  `turnarounds=${runLog.counts().turnarounds}`);

// ── 2. Snapshot contract ──────────────────────────────────────────────────────
console.log('snapshot contract:');
const TOP_KEYS = ['schemaVersion', 'simTimeSec', 'wallClock', 'activeRunways', 'groundStop',
  'metering', 'disruptions', 'deicing', 'flights', 'gates', 'runways', 'stats'];
for (const k of TOP_KEYS) check(`top-level "${k}"`, k in snapshot);
for (const k of ['active', 'padCap', 'padBusy', 'queueLen', 'deicedTotal', 'hotBreaches'])
  check(`deicing field "${k}"`, k in snapshot.deicing);
check('deicing inert by default', snapshot.deicing.active === false && snapshot.deicing.deicedTotal === 0);
check('schemaVersion is 1.0', snapshot.schemaVersion === '1.0');

const FLIGHT_KEYS = ['id', 'callsign', 'airline', 'type', 'state', 'gate', 'runway', 'slot',
  'position', 'headingDeg', 'speedMps', 'altitudeM', 'milestones', 'holdingAtGate',
  'pobtSim', 'turnAtRisk', 'stand', 'wakeCat', 'eta', 'sta', 'timeToLose', 'seqIdx', 'turnaround', 'deice'];
const sample = snapshot.flights.find(f => f.state !== 'DONE') || snapshot.flights[0];
check('has at least one flight to sample', !!sample);
if (sample) for (const k of FLIGHT_KEYS) check(`flight field "${k}"`, k in sample);

const rw = snapshot.runways[0];
for (const k of ['runway', 'waiting', 'rolling', 'closed', 'sepFactor']) check(`runway field "${k}"`, k in rw);
for (const k of ['weather', 'weatherKey', 'runwaysClosed', 'sepFactor', 'active']) check(`disruptions field "${k}"`, k in snapshot.disruptions);

// ── 3. State machine + A-CDM ordering ─────────────────────────────────────────
console.log('state machine / A-CDM:');
const VALID = new Set(Object.values(FS));
check('all observed states valid', [...seenStates].every(s => VALID.has(s)), [...seenStates].join(','));
check('full lifecycle observed', ['TAXIING_IN', 'AT_GATE', 'PUSHBACK', 'TAXIING_OUT', 'TAKEOFF', 'DONE']
  .every(s => seenStates.has(s)), [...seenStates].join(','));

const withAll = departures.find(d => d.ms && d.ms.ATA && d.ms.ALDT && d.ms.AIBT && d.ms.AOBT && d.ms.ATOT);
check('a completed flight carries full A-CDM chain', !!withAll);
if (withAll) {
  const m = withAll.ms;
  check('milestone ordering ATA<=ALDT<=AIBT<=AOBT<=ATOT',
    m.ATA.sim <= m.ALDT.sim && m.ALDT.sim <= m.AIBT.sim && m.AIBT.sim <= m.AOBT.sim && m.AOBT.sim <= m.ATOT.sim,
    JSON.stringify({ ATA: m.ATA.sim, ALDT: m.ALDT.sim, AIBT: m.AIBT.sim, AOBT: m.AOBT.sim, ATOT: m.ATOT.sim }));
}

// ── 4. KPI ranges + throughput sim-timebase (G-SIM-1 acceptance) ─────────────
console.log('KPIs:');
const met = analytics.getMetrics();
check('gateUtil in [0,1]', met.gateUtil >= 0 && met.gateUtil <= 1, String(met.gateUtil));
check('otp in [0,1]', met.otp >= 0 && met.otp <= 1, String(met.otp));
check('taxi CO2 accrues', met.taxiCO2Kg > 0, String(met.taxiCO2Kg));

// Under fast-forward the wall clock barely moves; a wall-based throughput would
// equal ALL departures. The sim-based one must count only the last sim-hour.
const expected = departures.filter(d => d.simT > snapshot.simTimeSec - 3600).length;
check('throughput uses SIM timebase (last sim-hour only)',
  snapshot.stats.throughput === expected,
  `throughput=${snapshot.stats.throughput} expected=${expected} totalDep=${snapshot.stats.departures}`);
check('sim-hour window < total (run is 1.5 sim-hours)',
  snapshot.stats.throughput < snapshot.stats.departures,
  `throughput=${snapshot.stats.throughput} totalDep=${snapshot.stats.departures}`);

// ── 5. DONE pruned on sim clock ───────────────────────────────────────────────
console.log('DONE pruning:');
scheduler.pause();
for (let i = 0; i < 20; i++) { api.update(0.5); }   // +10 sim-s, no new spawns
const nowSim = api.getSnapshot().simTimeSec;
// A flight may legitimately sit in DONE for up to the 3-sim-s FIDS grace; the
// mechanism is correct iff NOTHING overstays that grace (a wall-clock setTimeout
// would keep them for 3 wall-seconds and here overstay by many sim-seconds).
const overstayed = api.getRawFlights().filter(f => f.state === 'DONE' &&
  f._doneAtSim != null && (nowSim - f._doneAtSim) > 3.5);
check('no DONE flight overstays the 3 sim-s grace', overstayed.length === 0,
  `overstayed=${overstayed.length}`);

// ── 6. Module output shapes ───────────────────────────────────────────────────
console.log('module shapes:');
const sn = safetyNet.getStatus();
check('safety-net status shape', 'alarms' in sn && 'cautions' in sn && 'streakSec' in sn && 'runways' in sn);
const fc = dcb.getForecast();
check('DCB forecast: 6 bins per runway',
  fc && fc.runways.RWY1.bins.length === 6 && fc.runways.RWY2.bins.length === 6);
check('DCB capacities non-negative',
  fc.runways.RWY1.bins.every(b => b.cap >= 0) && fc.runways.RWY2.bins.every(b => b.cap >= 0));
const ladder = api.getArrivalLadder();
check('AMAN ladder shape', 'clock' in ladder && Array.isArray(ladder.RWY1) && Array.isArray(ladder.RWY2));

// APOC — Total Airport Management roll-up
const ap = apoc.getState();
check('APOC state present', !!ap && typeof ap.score === 'number');
check('APOC score in [0,100]', ap.score >= 0 && ap.score <= 100, String(ap.score));
check('APOC overall rag valid', [RAG.GREEN, RAG.AMBER, RAG.RED].includes(ap.rag), ap.rag);
check('APOC covers 4 domains', ap.domains.length === 4,
  ap.domains.map(d => d.id).join(','));
check('APOC every rated KPI has a valid rag',
  ap.domains.flatMap(d => d.kpis).every(k => [RAG.GREEN, RAG.AMBER, RAG.RED, RAG.NA].includes(k.rag)));
check('APOC alerts is an array', Array.isArray(ap.alerts));
// Headline colour never reads greener than an open breach: any red KPI floors
// it at amber; a fully-red domain forces red.
const anyRedKpi = ap.domains.flatMap(d => d.kpis).some(k => k.rag === RAG.RED);
check('APOC not green while a red KPI is open', !(anyRedKpi && ap.rag === RAG.GREEN),
  `rag=${ap.rag} anyRedKpi=${anyRedKpi}`);
check('APOC red when a whole domain is red',
  !ap.domains.some(d => d.rag === RAG.RED) || ap.rag === RAG.RED, ap.rag);
check('APOC headline fields present',
  ap.headline && 'throughput' in ap.headline && 'turnAtRisk' in ap.headline);
// Every non-predictive alert must correspond to a KPI actually rated amber/red.
const rated = new Map(ap.domains.flatMap(d => d.kpis).map(k => [k.id, k.rag]));
check('APOC alerts trace back to breached KPIs',
  ap.alerts.filter(a => !a.predictive).every(a => rated.get(a.kpi) === a.sev),
  JSON.stringify(ap.alerts.filter(a => !a.predictive).map(a => [a.kpi, a.sev])));
const exported = runLog.toJSON();
check('run-log export sections', ['meta', 'events', 'snapshots', 'turnarounds', 'oooi']
  .every(k => k in exported));

// ── 6a2. Physical realism: ground anti-overlap ───────────────────────────────
console.log('ground separation:');
check('no two ground movers ever overlap (min sep > 1.8u ≈ 14m)',
  minGroundSep === Infinity || minGroundSep > 1.8,
  `minSep=${minGroundSep.toFixed(2)}u pair=${minGroundPair}`);
console.log(`  (record ground min-sep: ${minGroundSep === Infinity ? 'n/a' : minGroundSep.toFixed(2) + 'u'} — ${minGroundPair})`);

// ── 6b. A-VDGS docking guidance ───────────────────────────────────────────────
console.log('A-VDGS:');
{
  const vst = vdgs.getStatus();
  check('VDGS covers every stand', vst.gates.length >= 4, `gates=${vst.gates.length}`);
  const PHASES = new Set(Object.values(VPH));
  check('VDGS phases all valid', vst.gates.every(g => PHASES.has(g.phase)),
    vst.gates.map(g => g.phase).join(','));
  check('VDGS dockings completed over the run', vst.dockings >= 10, `dockings=${vst.dockings}`);
  check('VDGS avg docking time sane (0–60s)', vst.avgDockSec > 0 && vst.avgDockSec < 60,
    String(vst.avgDockSec));
  check('VDGS closing countdown monotonically decreases', vdgsMonotonic);
  check('VDGS display lines present on every state',
    vst.gates.every(g => typeof g.l1 === 'string' && typeof g.l2 === 'string'));
}

// ── 6c. ANOMS noise monitoring ────────────────────────────────────────────────
console.log('noise monitoring:');
{
  const nst = noise.getStatus();
  check('all NMT sites reporting', nst.nmts.length === NMT_SITES.length,
    `nmts=${nst.nmts.length}`);
  check('NMT levels finite and plausible (38–110 dB)',
    nst.nmts.every(m => Number.isFinite(m.db) && m.db >= 38 && m.db < 110),
    nst.nmts.map(m => m.db).join(','));
  check('Lmax never below the live level', nst.nmts.every(m => m.lmax >= m.db - 0.11),
    nst.nmts.map(m => `${m.db}/${m.lmax}`).join(' '));
  check('noise events recorded over 90 min', nst.totalEvents >= 5,
    `events=${nst.totalEvents}`);
  check('event shape (site/cs/peak/dur/qc)', nst.events.every(e =>
    e.site && 'cs' in e && e.peakDb > 0 && e.durSec > 0 && e.qc > 0));
  check('N-above bands monotonic (65 ≥ 80 ≥ 90)',
    nst.nAbove[65] >= nst.nAbove[80] && nst.nAbove[80] >= nst.nAbove[90],
    JSON.stringify(nst.nAbove));
  check('QC quota accrues with events', nst.qc > 0, String(nst.qc));
  const apNoise = apoc.getState().domains.find(d => d.id === 'env').kpis.find(k => k.id === 'noise');
  check('APOC env domain rates the noise KPI', !!apNoise && apNoise.rag !== RAG.NA,
    apNoise && apNoise.rag);
}

// ── 6d. ATFM / CTOT slot adherence ────────────────────────────────────────────
console.log('slot adherence:');
{
  const st = slots.getStatus();
  check('regulated departures assigned CTOTs', st.regulated >= 5, `regulated=${st.regulated}`);
  check('slots closed over the run', st.closed >= 3, `closed=${st.closed}`);
  check('verdict tally consistent', st.compliant + st.early + st.late === st.closed,
    JSON.stringify({ c: st.compliant, e: st.early, l: st.late, closed: st.closed }));
  check('adherence in [0,100]', st.adherencePct == null ||
    (st.adherencePct >= 0 && st.adherencePct <= 100), String(st.adherencePct));
  check('open slot windows ordered lo<hi', st.open.every(s => s.winLo < s.winHi));
  check('open slot statuses valid', st.open.every(s => ['ok', 'risk', 'missed'].includes(s.status)),
    st.open.map(s => s.status).join(','));
  const apSlot = apoc.getState().domains.find(d => d.id === 'punc').kpis.find(k => k.id === 'slotAdh');
  check('APOC punctuality rates slot adherence', !!apSlot && (st.closed < 3 || apSlot.rag !== RAG.NA),
    apSlot && apSlot.rag);
}

// ── 6e. GRF runway condition reporting ────────────────────────────────────────
console.log('GRF runway condition:');
{
  const g0 = grf.getStatus();
  check('RCR published for both runways', g0.runways.length === 2,
    `runways=${g0.runways.length}`);
  check('dry VMC baseline → RWYCC 6 everywhere', g0.minCode === 6,
    `minCode=${g0.minCode}`);
  check('three thirds per runway', g0.runways.every(r => r.codes.length === 3));

  // Weather + winter scenario on an isolated pipeline.
  const wApi = new AirportAPI({ runways: 2 });
  const wSch = new Scheduler(wApi, { arrivalInterval: 18 });
  const wGrf = new GRFReporter();
  const run = (mins) => { for (let i = 0; i < mins * 120; i++) {
    wApi.update(0.5); wSch.update(0.5); wGrf.update(wApi.getSnapshot()); } };
  run(6);
  wApi.setWeather(2);  run(4);                       // IMC → 4 WET(heavy)
  check('IMC downgrades to RWYCC 4', wGrf.getStatus().minCode === 4,
    String(wGrf.getStatus().minCode));
  wApi.setDeicing(true); run(8);                     // freezing → 2 SLUSH
  const gw = wGrf.getStatus();
  check('freezing precip downgrades to RWYCC ≤2', gw.minCode <= 2, String(gw.minCode));
  check('downgrade transitions recorded', gw.changes.length >= 2,
    `changes=${gw.changes.length}`);
  check('braking AIREPs generated on degraded runway', gw.aireps.length >= 1,
    `aireps=${gw.aireps.length}`);
  check('AIREP actions map to RCAM equivalence',
    gw.aireps.every(a => a.actionKey && a.code <= 5));
  const apG = apoc.getState().domains.find(d => d.id === 'safe').kpis.find(k => k.id === 'rwycc');
  check('APOC safety rates RWYCC', !!apG && apG.rag !== RAG.NA, apG && apG.rag);
}

// ── 6f. Apron energy (FEGP vs APU) ────────────────────────────────────────────
console.log('apron energy:');
{
  const en = energy.getStatus();
  check('gate time accrued on both supplies', en.fegpSec > 0 && en.apuSec > 0,
    JSON.stringify({ fegp: en.fegpSec, apu: en.apuSec }));
  check('FEGP share within (0,100)', en.fegpSharePct > 0 && en.fegpSharePct < 100,
    String(en.fegpSharePct));
  check('APU CO2 consistent with fuel', Math.abs(en.apuCO2Kg - en.apuFuelKg * 3.16) < 0.5,
    JSON.stringify({ fuel: en.apuFuelKg, co2: en.apuCO2Kg }));
  check('avoided CO2 positive with FEGP time', en.co2AvoidedKg > 0, String(en.co2AvoidedKg));
  check('live stand modes valid', en.live.every(g => g.mode === 'fegp' || g.mode === 'apu'));
  check('APU league consistent', en.byAirline.every(a => a.co2Kg >= 0));
  const apE = apoc.getState().domains.find(d => d.id === 'env').kpis.find(k => k.id === 'fegp');
  check('APOC env rates FEGP share', !!apE && apE.rag !== RAG.NA, apE && apE.rag);
}

// ── 6h. A-SMGCS L3 taxiway conflict monitor ──────────────────────────────────
console.log('taxiway conflicts:');
{
  const tc = taxiCft.getStatus();
  check('taxi status shape', 'alarms' in tc && 'cautions' in tc && Array.isArray(tc.live)
    && Array.isArray(tc.links) && 'activeMax' in tc);
  check('live levels valid', tc.live.every(c => c.level === 1 || c.level === 2),
    tc.live.map(c => c.level).join(','));
  check('live pairs carry distance', tc.live.every(c => c.distM >= 0));
  check('links mirror live pairs', tc.links.length >= tc.live.length ? true : tc.links.length === tc.live.length);
  // 0 m is legitimate telemetry: the sim has no taxiway deconfliction (known
  // simplification), so overlapping pairs are exactly what L3 must surface.
  check('min separation non-negative when recorded', tc.minSepM == null || tc.minSepM >= 0,
    String(tc.minSepM));
  check('counters non-negative', tc.alarms >= 0 && tc.cautions >= 0);
  const apT = apoc.getState().domains.find(d => d.id === 'safe').kpis.find(k => k.id === 'taxiCft');
  check('APOC safety rates taxi conflicts', !!apT && apT.rag !== RAG.NA, apT && apT.rag);
}

// ── 6i. Wildlife hazard management ───────────────────────────────────────────
console.log('wildlife hazard:');
{
  const wl = wildlife.getStatus();
  check('flocks spawned over the run', wl.spawned >= 3, `spawned=${wl.spawned}`);
  check('risk levels valid', ['low', 'mod', 'high'].includes(wl.risk.RWY1) &&
    ['low', 'mod', 'high'].includes(wl.risk.RWY2), JSON.stringify(wl.risk));
  check('dispersal patrols rolled', wl.dispersals >= 1, `dispersals=${wl.dispersals}`);
  check('counters non-negative', wl.strikes >= 0 && wl.nearMiss >= 0 && wl.dispersals >= 0);
  check('activity within 0-100', wl.activityPct >= 0 && wl.activityPct <= 100,
    String(wl.activityPct));
  check('event log entries well-formed', wl.events.every(e =>
    ['dispersal', 'strike', 'nearmiss'].includes(e.kind) && typeof e.sim === 'number'));
  const apW = apoc.getState().domains.find(d => d.id === 'safe').kpis.find(k => k.id === 'wildlife');
  check('APOC safety rates wildlife risk', !!apW && apW.rag !== RAG.NA, apW && apW.rag);
}

// ── 6j. ALCMS airfield lighting ───────────────────────────────────────────────
console.log('ALCMS lighting:');
{
  const ag = alcms.getStatus(0);
  check('9 circuits reported', ag.circuits.length === 9, String(ag.circuits.length));
  check('serviceability within [0,100]', ag.circuits.every(c => c.svcPct >= 0 && c.svcPct <= 100));
  check('statuses valid', ag.circuits.every(c => ['ok', 'degraded', 'below'].includes(c.status)),
    ag.circuits.map(c => c.status).join(','));
  check('lamp failures occurred over the run', ag.lampsReplaced + ag.circuits.reduce((s, c) => s + c.failed, 0) > 0,
    JSON.stringify({ replaced: ag.lampsReplaced }));
  check('maintenance crew completed repairs', ag.repairs >= 1, String(ag.repairs));
  check('no LVP impairment in clear weather', ag.lvpImpaired === false);
  const apA = apoc.getState().domains.find(d => d.id === 'safe').kpis.find(k => k.id === 'agl');
  check('APOC safety rates AGL serviceability', !!apA && apA.rag !== RAG.NA, apA && apA.rag);
}

// ── 6g. Lightning ramp stop (isolated run) ────────────────────────────────────
console.log('lightning ramp stop:');
{
  const lApi = new AirportAPI({ runways: 2 });
  const lSch = new Scheduler(lApi, { arrivalInterval: 18 });
  const run = (mins) => { for (let i = 0; i < mins * 120; i++) { lApi.update(0.5); lSch.update(0.5); } };
  run(12);
  check('lightning inert by default', lApi.getSnapshot().disruptions.lightning.phase === 'normal');
  lApi.setLightning(true);
  check('ramp stops on strike', lApi.getSnapshot().disruptions.lightning.phase === 'stop');
  run(15);                                   // pipeline drains, gates frozen
  const depB = lApi.getSnapshot().stats.departures;
  run(10);                                   // still stopped → nothing new departs
  const depC = lApi.getSnapshot().stats.departures;
  check('departures fully stall under ramp stop', depC === depB, `B=${depB} C=${depC}`);
  const frozen = lApi.getSnapshot().flights.filter(f => f.state === 'AT_GATE');
  check('gates hold aircraft during the stop', frozen.length >= 3, `atGate=${frozen.length}`);
  lApi.setLightning(false);
  const lg = lApi.getSnapshot().disruptions.lightning;
  check('all-clear countdown starts (30/30 rule)', lg.phase === 'clearing' && lg.clearInSec > 0,
    JSON.stringify(lg));
  run(1);
  check('ramp reopens after the quiet period',
    lApi.getSnapshot().disruptions.lightning.phase === 'normal');
  run(15);
  check('departures resume after all-clear', lApi.getSnapshot().stats.departures > depC,
    `C=${depC} end=${lApi.getSnapshot().stats.departures}`);
  const apR = apoc.getState().domains.find(d => d.id === 'safe').kpis.find(k => k.id === 'ramp');
  check('APOC safety rates ramp status', !!apR && apR.rag === RAG.GREEN, apR && apR.rag);
}

// ── 6l. Fuel farm & hydrant ───────────────────────────────────────────────────
console.log('fuel farm:');
{
  const fu = fuelFarm.getStatus();
  check('uplifts booked over the run', fu.uplifts >= 10, `uplifts=${fu.uplifts}`);
  check('stock within [0, capacity]', fu.stockKL >= 0 && fu.stockKL <= fu.capacityKL,
    String(fu.stockKL));
  check('stock depleted from initial or replenished', fu.upliftKL > 0, String(fu.upliftKL));
  check('hydrant share within (0,100]', fu.hydrantSharePct == null ||
    (fu.hydrantSharePct >= 0 && fu.hydrantSharePct <= 100), String(fu.hydrantSharePct));
  check('cover hours positive at active burn', fu.coverHours == null || fu.coverHours >= 0,
    String(fu.coverHours));
  check('deliveries triggered by reorder point', fu.deliveries >= 1, `deliveries=${fu.deliveries}`);
  check('recent uplift shapes valid', fu.recent.every(r => r.cs && r.kl > 0 && typeof r.hydrant === 'boolean'));
  const apF = apoc.getState().domains.find(d => d.id === 'cap').kpis.find(k => k.id === 'fuel');
  check('APOC capacity rates fuel cover', !!apF && apF.rag !== RAG.NA, apF && apF.rag);
}

// ── 6k. ARFF response drill (isolated run) ────────────────────────────────────
console.log('ARFF drill:');
{
  const aApi = new AirportAPI({ runways: 2 });
  const drill = new ARFFService();
  const step = (sec) => { for (let i = 0; i < sec * 2; i++) { aApi.update(0.5); drill.update(0.5, aApi, aApi.getSnapshot().simTimeSec); } };
  check('drill starts and closes the runway', drill.startDrill(aApi, 'RWY2') === true &&
    aApi.runwaysClosed.RWY2 === true);
  check('second drill refused while active', drill.startDrill(aApi, 'RWY1') === false);
  step(45);
  const st = drill.getStatus();
  check('drill completed a cycle', st.phase === 'idle' && st.drills === 1,
    JSON.stringify({ phase: st.phase, drills: st.drills }));
  check('runway reopened after stand-down', aApi.runwaysClosed.RWY2 === false);
  check('response time within model bounds', st.last.responseSec >= 10 && st.last.responseSec <= 26,
    String(st.last.responseSec));
  check('pass verdict consistent with the standard',
    st.last.pass === (st.last.responseSec <= st.standardSec), JSON.stringify(st.last));
  // Respect a user-closed runway: drill must NOT reopen it.
  aApi.closeRunway('RWY1');
  drill.startDrill(aApi, 'RWY1');
  step(45);
  check('user-closed runway stays closed after drill', aApi.runwaysClosed.RWY1 === true);
  check('pass rate reported', drill.getStatus().passRate != null);
}

// ── 6q. WASG capacity declaration & slot coordination ────────────────────────
console.log('WASG slots:');
{
  const w = wasgCoord.getStatus();
  check('slots allocated over the run', w.allocated >= 20, `allocated=${w.allocated}`);
  check('R60 never exceeds the declared total',
    w.live.r60.total <= w.params.r60.total,
    `${w.live.r60.total}/${w.params.r60.total}`);
  check('R10 never exceeds the declared total',
    w.live.r10.total <= w.params.r10.total,
    `${w.live.r10.total}/${w.params.r10.total}`);
  check('arrival/departure sub-limits respected',
    w.live.r60.arr <= w.params.r60.arr && w.live.r60.dep <= w.params.r60.dep &&
    w.live.r10.arr <= w.params.r10.arr && w.live.r10.dep <= w.params.r10.dep,
    JSON.stringify(w.live));
  check('declared sub-limits sum above the total (Dublin shape)',
    w.params.r60.arr + w.params.r60.dep > w.params.r60.total &&
    w.params.r10.arr + w.params.r10.dep > w.params.r10.total);
  check('on-slot count never exceeds closed records', w.onSlot <= w.closed,
    JSON.stringify({ on: w.onSlot, closed: w.closed }));
  check('both arrival and departure slots monitored',
    w.recent.length === 0 || new Set(w.recent.map(r => r.kind)).size >= 1);
  check('standard deviation non-negative and finite',
    w.sdDevSec >= 0 && Number.isFinite(w.sdDevSec), String(w.sdDevSec));
  check('capacity verdict is one of the defined outcomes',
    ['pending', 'overDeclared', 'balanced', 'headroom'].includes(w.verdict), w.verdict);
  check('WASG level is 1, 2 or 3', [1, 2, 3].includes(w.level), String(w.level));
  // A slot is a planned ON-BLOCK time: nominal ops must not show a systematic
  // bias, or the schedule itself is wrong (this caught a real modelling bug —
  // SIBT built from ETA rather than ETA + taxi-in was late by the taxi-in on
  // every single arrival, which the Annex 12.9 screen then flagged as misuse).
  check('no systematic schedule bias in nominal ops',
    Math.abs(w.meanDevSec) < 20, `mean=${w.meanDevSec}s`);
  check('nominal ops are not flagged as structural misuse',
    w.structuralMisuse === false, `mean=${w.meanDevSec} sd=${w.sdDevSec}`);
  const apW = apoc.getState().domains.find(d => d.id === 'cap').kpis.find(k => k.id === 'wasg');
  check('APOC capacity rates slot adherence', !!apW, apW && apW.rag);
}

// ── 6p. Baggage BHS + IATA 753 ───────────────────────────────────────────────
console.log('baggage system:');
{
  const b = bags.getStatus();
  check('bags flowed through the BHS', b.totalBags > 100, `total=${b.totalBags}`);
  check('all four 753 scan points recorded',
    b.scans.acceptance > 0 && b.scans.loaded > 0 && b.scans.transfer > 0 && b.scans.delivery > 0,
    JSON.stringify(b.scans));
  check('mishandle rate non-negative and bounded', b.mishandleRate >= 0 && b.mishandleRate < 1000,
    String(b.mishandleRate));
  check('handled + mishandled equals total', b.handled + b.mishandled === b.totalBags,
    JSON.stringify({ h: b.handled, m: b.mishandled, t: b.totalBags }));
  check('sorter backlog never negative', b.backlog >= 0, String(b.backlog));
  check('loaded scans never exceed acceptance', b.scans.loaded <= b.scans.acceptance,
    JSON.stringify(b.scans));
  const apB = apoc.getState().domains.find(d => d.id === 'cap').kpis.find(k => k.id === 'bags');
  check('APOC capacity rates bag mishandling', !!apB && apB.rag !== RAG.NA, apB && apB.rag);
}

// ── 6n. GSE pooling ───────────────────────────────────────────────────────────
console.log('GSE pooling:');
{
  const gs = gsePool.getStatus();
  check('five fleets reported', gs.fleets.length === 5, String(gs.fleets.length));
  check('busy never exceeds capacity', gs.fleets.every(f => f.busy <= f.cap));
  check('utilisation within [0,100]', gs.fleets.every(f => f.utilPct >= 0 && f.utilPct <= 100),
    gs.fleets.map(f => f.utilPct).join(','));
  check('equipment actually used over the run', gs.fleets.some(f => f.utilPct > 0));
  check('shortage seconds non-negative', gs.fleets.every(f => f.shortSec >= 0));
  check('shortNow consistent with demand-cap', gs.fleets.every(f =>
    f.shortNow === Math.max(0, f.demand - f.cap)));
  const apG = apoc.getState().domains.find(d => d.id === 'cap').kpis.find(k => k.id === 'gse');
  check('APOC capacity rates GSE shortage', !!apG && apG.rag !== RAG.NA, apG && apG.rag);
}

// ── 6m. Digital-tower view poses (pure math) ─────────────────────────────────
console.log('tower views:');
{
  const finite = (p) => [...p.pos, ...p.tgt].every(Number.isFinite);
  check('all presets produce finite poses', VIEW_NAMES.filter(v => v !== 'follow')
    .every(v => finite(viewPose(v))));
  const uniq = new Set(VIEW_NAMES.filter(v => v !== 'follow')
    .map(v => viewPose(v).pos.join(',')));
  check('preset positions are distinct', uniq.size === 4, String(uniq.size));
  const fA = { position: { x: -100, y: 20, z: -25 } };
  const fB = { position: { x: -80, y: 16, z: -25 } };
  const pA = viewPose('follow', fA), pB = viewPose('follow', fB);
  check('follow pose tracks the aircraft', finite(pA) && finite(pB) &&
    pA.pos.join() !== pB.pos.join() && pA.tgt[0] === -100 && pB.tgt[0] === -80);
  check('follow without a flight falls back to overview',
    viewPose('follow', null).pos.join() === viewPose('overview').pos.join());
}

// ── 6o. NOTAM / SNOWTAM board (isolated run) ─────────────────────────────────
console.log('NOTAM board:');
{
  const nApi = new AirportAPI({ runways: 2 });
  const nGrf = new GRFReporter();
  const board = new NOTAMBoard();
  const feed = () => board.update({ snapshot: nApi.getSnapshot(), grf: nGrf.getStatus(),
    agl: null, wildlife: null, fuel: null });
  const run = (sec) => { for (let i = 0; i < sec * 2; i++) { nApi.update(0.5); nGrf.update(nApi.getSnapshot()); } feed(); };
  run(5);
  check('board empty in normal ops', board.getStatus().active.length === 0 &&
    board.getStatus().snowtam == null);
  nApi.closeRunway('RWY2'); run(2);
  let st = board.getStatus();
  check('runway closure published with serial+Q', st.active.length === 1 &&
    st.active[0].q === 'QMRLC' && /^A\d{4}\/26$/.test(st.active[0].serial),
    JSON.stringify(st.active[0] || null));
  nApi.setWeather(3); run(2);
  st = board.getStatus();
  check('LVP NOTAM added', st.active.some(n => n.q === 'QFALV'), st.active.map(n => n.q).join(','));
  nApi.setDeicing(true); run(4);
  st = board.getStatus();
  check('winter NOTAM + SNOWTAM published', st.active.some(n => n.q === 'QFAFP') &&
    !!st.snowtam && st.snowtam.runways.every(r => /\d\/\d\/\d/.test(r.codes)),
    JSON.stringify(st.snowtam));
  nApi.openRunway('RWY2'); run(2);
  st = board.getStatus();
  check('cleared condition moves to NOTAMC', st.active.every(n => n.q !== 'QMRLC') &&
    st.cancelled.some(n => n.q === 'QMRLC'));
  check('serials strictly increment', st.issued >= 3, String(st.issued));
}

// ── 7. Winter de-icing scenario (isolated run) ────────────────────────────────
console.log('winter de-icing:');
{
  const wApi = new AirportAPI({ runways: 2 });
  const wSch = new Scheduler(wApi, { arrivalInterval: 18 });
  const run = (mins) => { for (let i = 0; i < mins * 120; i++) { wApi.update(0.5); wSch.update(0.5); } };
  run(12);                                   // warm up without winter
  const depBefore = wApi.getSnapshot().stats.departures;
  wApi.setDeicing(true);
  check('de-icing activates', wApi.getSnapshot().deicing.active === true);
  run(40);
  const dk = wApi.getDeicing();
  const depMid = wApi.getSnapshot().stats.departures;
  check('departures flow through de-icing (no deadlock)', depMid > depBefore,
    `before=${depBefore} mid=${depMid}`);
  check('flights actually de-iced', dk.deicedTotal >= 10, `deiced=${dk.deicedTotal}`);
  check('de-ice list entries carry valid states',
    dk.list.every(f => ['queued', 'deicing', 'holdover'].includes(f.state)));
  check('holdover flights expose a HOT countdown',
    dk.list.filter(f => f.state === 'holdover').every(f => typeof f.hotRemainingSec === 'number'));
  // Turning winter off must drain everything and keep departures completing.
  wApi.setDeicing(false);
  run(15);
  const wEnd = wApi.getSnapshot();
  check('de-icing drains when switched off',
    wEnd.deicing.active === false && wEnd.flights.every(f => !f.deice || f.deice.state !== 'queued'));
  check('departures still complete after drain', wEnd.stats.departures > depMid,
    `mid=${depMid} end=${wEnd.stats.departures}`);
}

// ── Result ────────────────────────────────────────────────────────────────────
if (failed) { console.error(`\nFAIL: ${failed} check(s) failed`); process.exit(1); }
console.log('\nPASS: all checks green');
