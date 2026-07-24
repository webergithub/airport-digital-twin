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
const runLog = new RunLogger(api, { snapshotEverySec: 5 });

const seenStates = new Set();
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
  apoc.update({ metrics: analytics.getMetrics(), safety: safetyNet.getStatus(),
    dcb: dcb.getForecast(), wall: api.getTurnaroundWall(),
    stats: snapshot.stats, simTimeSec: snapshot.simTimeSec });
  runLog.tick(snapshot, DT);
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
