/**
 * Simulation entry point — wires together the three layers.
 *
 * Three-layer architecture:
 *   UI 层 (simulation/)      → 3D twin rendering + panels; consumes the data
 *                              layer's standard JSON snapshot via the API.
 *   模拟输入数据层 (control/) → simulates aircraft positions/speeds/altitudes and
 *                              the ground-handling process; exposes everything
 *                              through AirportAPI + getSnapshot() (JSON contract).
 *   数据算法层 (optimization/) → AnalyticsEngine ingests the snapshot stream,
 *                              derives metrics and continuously optimizes
 *                              parameters; RunLogger records all running data.
 */

import { createScene }    from './scene.js';
import { Airport3D }      from './airport3d.js';
import { Aircraft3D }     from './aircraft3d.js';
import { UIOverlay }      from './ui-overlay.js';
import { JetBridgeManager } from './jetbridge3d.js';
import { GateInteraction }  from './gate-interaction.js';
import { ServiceVehicles }  from './service-vehicles.js';
import { AirportAPI }     from '../control/airport-api.js';
import { FS }             from '../control/flight-manager.js';
import { buildGateLayout, setGates, getGateConfig } from '../control/gate-layout.js';
import { Scheduler }      from '../optimization/scheduler.js';
import { AnalyticsEngine } from '../optimization/analytics.js';
import { RunLogger }      from '../optimization/run-logger.js';
import { RunwaySafetyNet } from '../optimization/safety-nets.js';
import { DCBForecaster }   from '../optimization/dcb-forecaster.js';
import { APOC }            from '../optimization/apoc.js';
import { TaxiGuidance }    from './guidance-lights.js';
import { LiveSource }      from './live-source.js';
import { t, tf, onLangChange, toggleLang, getLang } from './i18n.js';

// ── Init scene ─────────────────────────────────────────────────────────────────
const container = document.getElementById('canvas-container');
const { scene, camera, renderer, labelRenderer, controls } = createScene(container);

// ── Airport geometry ────────────────────────────────────────────────────────────
const airport = new Airport3D(scene);
const guidance = new TaxiGuidance(scene);   // A-SMGCS Follow-the-Greens taxi lights

// ── Control layer ───────────────────────────────────────────────────────────────
const api = new AirportAPI({ runways: 2 });

// ── Data algorithm layer (数据算法层) ──────────────────────────────────────────────
const scheduler = new Scheduler(api, { arrivalInterval: 25 });
const analytics = new AnalyticsEngine(api, scheduler, { targetUtil: 0.6 });
const runLog    = new RunLogger(api, { snapshotEverySec: 5 });
const safetyNet = new RunwaySafetyNet(api);   // A-SMGCS RIMCAS runway monitor
const dcb       = new DCBForecaster(api, scheduler);  // rolling demand-capacity forecast
const apoc      = new APOC();                          // Total Airport Management 运行指挥中心
const liveSource = new LiveSource();                  // 对接真实机场（WS 数据源）
let simPaused   = false;                              // 暂停/启动模拟
let liveSnapshot = null;                              // 最近一帧外部数据源快照
const SAVE_KEY  = 'airporttwin_savestate';

// ── 3D aircraft + jet bridges ─────────────────────────────────────────────────────
const aircraft3dMap = new Map(); // flightId → Aircraft3D
const bridges = new JetBridgeManager(scene);

// ── Gate focus mode ───────────────────────────────────────────────────────────────
let focusedGateId  = null;
let serviceVehicles = null;

function onFocusGate(id) {
  focusedGateId = id;
  serviceVehicles?.dispose();
  serviceVehicles = new ServiceVehicles(scene, airport.getGateDef(id));
  window.__sv = serviceVehicles;   // debug
  ui.enterGateDetail(id);
  ui.log(tf('log.gateEnter', { gate: id }), 'info');
}

function onExitGate() {
  focusedGateId = null;
  serviceVehicles?.dispose();
  serviceVehicles = null;
  ui.exitGateDetail();
}

// What-if: freeze a KPI baseline when the first disruption is armed, clear it
// once all disruptions are lifted, so the panel shows scenario-vs-baseline deltas.
function syncScenarioBaseline() {
  if (api.hasDisruption()) { if (!analytics.hasBaseline) analytics.freezeBaseline(); }
  else analytics.clearBaseline();
}

// ── UI ──────────────────────────────────────────────────────────────────────────
const ui = new UIOverlay(document.getElementById('ui-root'), (action, payload) => {
  switch (action) {
    case 'reconfigure': {
      scheduler.setInterval(payload.arrivalInterval);
      api.setRunways(payload.runways);

      const layout = buildGateLayout(payload.gateCount, payload.bridgeCount);
      const newIds = new Set(layout.map(g => g.id));
      const blocked = api.getGateOccupancy().gates
        .filter(g => g.flightId && !newIds.has(g.id))
        .map(g => g.id);

      if (blocked.length) {
        ui.log(tf('log.blocked', { ids: blocked.join('、') }), 'warn');
        ui.setGateConfig(getGateConfig());           // revert sliders
      } else {
        setGates(layout);
        api.reconfigureGates();
        airport.rebuildGates();
        bridges.rebuild();
        ui.setGateConfig(getGateConfig());
        if (focusedGateId && !newIds.has(focusedGateId)) gi.exitFocus();
        ui.log(tf('log.reconfig', { g: payload.gateCount, b: payload.bridgeCount, i: payload.arrivalInterval, r: payload.runways }), 'info');
      }
      break;
    }
    case 'spawnNow':
      scheduler.spawnNow();
      break;
    case 'groundStop':
      scheduler.pause();
      api.groundStop();
      ui.log(t('log.groundStopCmd'), 'warn');
      break;
    case 'resume':
      scheduler.resume();
      api.resume();
      ui.log(t('log.resume'), 'info');
      break;
    case 'exitGate':
      gi.exitFocus();
      break;
    case 'focusGate':
      gi.focusGate(payload.gateId);   // Turnaround wall card → focus that gate
      break;
    case 'toggleAutoOpt':
      analytics.setAutoOptimize(payload.on);
      ui.log(t(payload.on ? 'log.autoOptOn' : 'log.autoOptOff'), 'info');
      break;
    case 'toggleMetering':
      api.setMetering(payload.on);
      ui.log(t(payload.on ? 'log.meterOn' : 'log.meterOff'), 'info');
      break;
    case 'toggleSET':
      analytics.setSingleEngineTaxi(payload.on);
      ui.log(t(payload.on ? 'log.setOn' : 'log.setOff'), 'info');
      break;
    case 'toggleGuidance':
      guidance.setEnabled(payload.on);
      ui.log(t(payload.on ? 'log.aglOn' : 'log.aglOff'), 'info');
      break;
    case 'setWeather': {
      const w = api.setWeather(payload.level);
      scheduler.setFloor(w.aar);
      if (scene.fog) scene.fog.density = w.fog;
      ui.log(tf('log.weather', { w: w.key }), w.key === 'VMC' ? 'info' : 'warn');
      syncScenarioBaseline();
      break;
    }
    case 'toggleRunway': {
      if (payload.closed) api.closeRunway(payload.runway); else api.openRunway(payload.runway);
      ui.log(tf(payload.closed ? 'log.rwyClosed' : 'log.rwyOpened', { r: payload.runway }), payload.closed ? 'warn' : 'info');
      syncScenarioBaseline();
      break;
    }
    case 'toggleDeicing': {
      api.setDeicing(payload.on);
      ui.log(t(payload.on ? 'log.deiceOn' : 'log.deiceOff'), payload.on ? 'warn' : 'info');
      syncScenarioBaseline();
      break;
    }
    case 'exportLog':
      runLog.download();
      ui.log(tf('log.export', { e: runLog.counts().events, s: runLog.counts().snapshots }), 'info');
      break;
    case 'toggleLang':
      toggleLang();
      break;

    // ── 底部运行控制 ──
    case 'togglePause':
      simPaused = !simPaused;
      ui.setPauseLabel(simPaused);
      ui.log(t(simPaused ? 'log.simPaused' : 'log.simResumed'), simPaused ? 'warn' : 'info');
      break;
    case 'saveState':
      saveRunState();
      break;
    case 'liveConnect':
      connectLive(payload.url);
      break;
    case 'liveDisconnect':
      liveSource.disconnect();
      break;
    case 'restoreYes':
      restoreRunState();
      break;
    case 'restoreNo':
      try { localStorage.removeItem(SAVE_KEY); } catch (e) {}
      break;
  }
}, runLog);   // 3rd arg → RECALL replay panel reads recorded snapshots

// ── Gate click → camera focus ─────────────────────────────────────────────────────
const gi = new GateInteraction({
  camera, controls, renderer,
  getGateMarkers: () => airport.gateMarkers,
  gateDefs: () => airport.gates,
  onFocus: onFocusGate,
  onExit:  onExitGate,
});

// ── Jet bridge events → log ───────────────────────────────────────────────────────
bridges.setOnEvent((name, id) => {
  const f = api.getActiveFlight(id);
  if (!f) return;
  if (name === 'door_connected')        ui.log(tf('log.bridgeConnect', { cs: f.callsign }), 'gate');
  else if (name === 'deboarding_complete') ui.log(tf('log.bridgeRetract', { cs: f.callsign }), 'info');
});

// ── API events → UI log (localized) ─────────────────────────────────────────────
const al = a => t('airline.' + a, a);
api.on('flight_spawned', f => ui.log(tf('log.spawned',  { cs: f.callsign, al: al(f.airline), rwy: f.runway, gate: f.gateId }), 'land'));
api.on('flight_arrived', f => ui.log(tf('log.arrived',  { cs: f.callsign, gate: f.gateId }), 'gate'));
api.on('atc_hold',       f => ui.log(tf('log.atcHold',  { cs: f.callsign, rwy: f.runway }), 'atc'));
api.on('tsat_release',   f => ui.log(tf('log.tsat',     { cs: f.callsign, s: f.heldSec }), 'atc'));
api.on('rimcas_alert',   d => ui.log(tf('log.rimcas',   { rwy: d.runway, kind: t(d.stage === 2 ? 'sn.alarm' : 'sn.caution') }), 'warn'));
api.on('flight_takeoff', f => ui.log(tf('log.takeoff',  { cs: f.callsign }), 'depart'));
api.on('flight_departed',f => ui.log(tf('log.departed', { cs: f.callsign }), 'info'));
api.on('no_gate', ({ callsign }) => ui.log(tf('log.noGate', { cs: callsign }), 'warn'));
api.on('ground_stop', () => ui.log(t('log.groundStopOn'), 'warn'));

// ── Sync 3D aircraft with control layer ─────────────────────────────────────────
function syncAircraft() {
  for (const flight of api.getRawFlights()) {
    if (!aircraft3dMap.has(flight.id)) {
      aircraft3dMap.set(flight.id, new Aircraft3D(scene, flight));
    }
  }
  for (const [id, ac3d] of aircraft3dMap) {
    const flight = api.getActiveFlight(id);
    if (!flight || flight.state === FS.DONE) {
      ac3d.remove();
      aircraft3dMap.delete(id);
    }
  }
}

// ── Logic tick — 20 fps via setInterval, works in background tabs ────────────────
let lastLogicTime = performance.now();

function logicTick() {
  const now = performance.now();
  const dt  = Math.min((now - lastLogicTime) / 1000, 1.0);
  lastLogicTime = now;

  // ── Data layer: advance the local sim (unless paused or driven by live data),
  //    then publish the standard snapshot ──
  let snapshot;
  if (liveSource.connected && liveSnapshot) {
    snapshot = liveSnapshot;                 // external feed drives the views
  } else {
    if (!simPaused) { api.update(dt); scheduler.update(dt); }
    snapshot = api.getSnapshot();
  }
  syncAircraft();
  window.__snapshot = snapshot;              // exposed for external/API consumers

  // ── Algorithm layer: ingest snapshot → metrics + auto-optimization + logging ─
  // Analytics is event-driven off the LOCAL api, so it is skipped under a live
  // feed; the pure snapshot consumers (safety net, DCB, logger) run regardless.
  if (!liveSource.connected) analytics.update(snapshot, dt);
  safetyNet.update(snapshot);        // A-SMGCS runway conflict monitor
  dcb.update(snapshot);              // rolling demand-capacity hotspot forecast
  runLog.tick(snapshot, dt);

  // ── UI layer: render panels from the snapshot ──────────────────────────────
  ui.updateFlightBoard(snapshot.flights.filter(f => f.state !== FS.DONE));
  ui.updateStats(snapshot.stats);
  ui.updateATC({
    nextIn: scheduler.getStats().nextIn,
    count:  aircraft3dMap.size,
  });
  // Compute the module outputs once; both the individual panels and the APOC
  // roll-up read the same values so the operations picture stays consistent.
  const metrics  = analytics.getMetrics();
  const safety   = safetyNet.getStatus();
  const forecast = dcb.getForecast();
  const wall     = api.getTurnaroundWall();

  ui.updateAnalytics({
    metrics,
    decisions: analytics.getDecisions(),
    logCounts: runLog.counts(),
  });
  ui.updateTurnWall(wall);
  ui.updateStandPlan(api.getStandPlan());
  ui.updateOOOI(runLog.recentOOOI(24), analytics.getAspm());
  ui.updateSafetyNets(safety);
  ui.updateSurfaceRadar(snapshot, { RWY1: safetyNet.stage('RWY1'), RWY2: safetyNet.stage('RWY2') });
  ui.updateDisruption(snapshot.disruptions, analytics.getScenarioDelta());
  ui.updateDeice(api.getDeicing());          // includes the per-flight in-process list
  ui.updateAman(api.getArrivalLadder());
  ui.updateDCB(forecast);

  // APOC — Total Airport Management: score every domain's KPIs vs target.
  apoc.update({ metrics, safety, dcb: forecast, wall, stats: snapshot.stats,
                deicing: snapshot.deicing, simTimeSec: snapshot.simTimeSec });
  ui.updateAPOC(apoc.getState());

  if (focusedGateId) {
    const occ    = api.getGateOccupancy().gates.find(g => g.id === focusedGateId);
    const flight = occ && occ.flightId ? api.getActiveFlight(occ.flightId) : null;
    const atGate = flight && flight.state === FS.AT_GATE;
    ui.updateGateDetail({
      gateId: focusedGateId,
      flight: atGate ? flight.getStatus() : null,
      plan:   atGate && flight.turnaroundLive ? flight.turnaroundLive.snapshot() : null,
    });
  }
}

// ── Render loop — rAF; smooth 3D motion + camera + vehicles ───────────────────────
let lastFrame = performance.now();

function renderFrame(frameDt) {
  for (const [id, ac3d] of aircraft3dMap) {
    const flight = api.getActiveFlight(id);
    if (flight) ac3d.update();
  }

  bridges.update(frameDt, api, aircraft3dMap);
  gi.update(frameDt);

  // Pulse the runway conflict overlays smoothly at frame rate.
  airport.setRunwayAlert('RWY1', safetyNet.stage('RWY1'));
  airport.setRunwayAlert('RWY2', safetyNet.stage('RWY2'));

  // Follow-the-Greens taxi guidance lights (reads live flight ground routes).
  guidance.update(api);

  // RECALL surface replay (independent clock; only draws when its panel is open).
  ui.updateReplay(frameDt);

  if (focusedGateId && serviceVehicles) {
    const occ    = api.getGateOccupancy().gates.find(g => g.id === focusedGateId);
    const flight = occ && occ.flightId ? api.getActiveFlight(occ.flightId) : null;
    const live   = (flight && flight.state === FS.AT_GATE && flight.turnaroundLive)
      ? flight.turnaroundLive.nodes : null;
    serviceVehicles.update(live, frameDt);
  }

  controls.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}

function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const frameDt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;
  renderFrame(frameDt);
}

// ── 保存 / 恢复运行状态 + 对接真实机场 ──────────────────────────────────────────────
function saveRunState() {
  try {
    const state = { v: 1, savedWall: Date.now(),
      gate: getGateConfig(), api: api.exportState(), scheduler: scheduler.getState() };
    localStorage.setItem(SAVE_KEY, JSON.stringify(state));
    ui.log(tf('save.saved', { n: state.api.flights.length, t: Math.round(state.api.clock) }), 'info');
  } catch (e) { ui.log('save failed: ' + e.message, 'warn'); }
}

function restoreRunState() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch (e) {}
  if (!s || !s.api) return;
  if (s.gate) {
    setGates(buildGateLayout(s.gate.gateCount, s.gate.bridgeCount));
    airport.rebuildGates(); bridges.rebuild(); ui.setGateConfig(getGateConfig());
  }
  api.importState(s.api);
  scheduler.setState(s.scheduler);
  scheduler.setFloor(api.weatherParams().aar);
  if (scene.fog) scene.fog.density = api.weatherParams().fog;
  for (const [, ac] of aircraft3dMap) ac.remove();     // rebuild 3D from restored flights
  aircraft3dMap.clear();
  simPaused = false; ui.setPauseLabel(false);
  ui.log(tf('log.restored', { n: (s.api.flights || []).length }), 'info');
}

function connectLive(url) {
  if (!url || !/^wss?:\/\//.test(url)) { ui.setLiveStatus('live.st.error'); return; }
  liveSource.connect(url, {
    onSnapshot: (snap) => { liveSnapshot = snap; },
    onStatus: (kind, detail) => {
      const map = { connecting: 'live.st.connecting', open: 'live.st.open', data: 'live.st.data',
        badframe: 'live.st.badframe', error: 'live.st.error', closed: 'live.st.closed' };
      ui.setLiveStatus(map[kind] || 'live.st.idle',
        kind === 'data' ? { n: detail } : (kind === 'badframe' ? { e: detail } : null));
      if (kind === 'open') { ui.setLiveState(true); ui.log(t('log.liveOn'), 'atc'); }
      if (kind === 'closed' || kind === 'error') { ui.setLiveState(false); liveSnapshot = null; ui.log(t('log.liveOff'), 'info'); }
    },
  });
}

// ── Language switch ───────────────────────────────────────────────────────────────
// Re-apply static translations; dynamic panels re-localize on their next tick.
onLangChange(() => {
  ui.applyLang();
  const lb = document.getElementById('lang-btn'); if (lb) lb.textContent = t('nav.langBtn');
  const nt = document.getElementById('nav-title'); if (nt) nt.textContent = t('nav.title');
  const nb = document.getElementById('nav-back'); if (nb) nb.textContent = t('nav.back');
  document.documentElement.lang = getLang() === 'zh' ? 'zh-CN' : 'en';
  document.title = t('page.title');
});
window.__toggleLang = toggleLang;

// ── Boot ────────────────────────────────────────────────────────────────────────
ui.applyLang();                  // ensure initial language is applied everywhere
document.title = t('page.title');
{ // initial nav-bar text for the stored language
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  set('lang-btn', t('nav.langBtn')); set('nav-title', t('nav.title')); set('nav-back', t('nav.back'));
  document.documentElement.lang = getLang() === 'zh' ? 'zh-CN' : 'en';
}
ui.log(t('boot.start'), 'info');
ui.log(t('boot.waiting'), 'atc');
ui.log(t('boot.hint'), 'info');

// 若检测到上次保存的运行状态，提示是否恢复继续。
{
  let s = null;
  try { s = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch (e) {}
  if (s && s.api && Array.isArray(s.api.flights) && s.api.flights.length) {
    ui.showRestorePrompt(tf('save.restoreQ', { n: s.api.flights.length, t: Math.round(s.api.clock) }));
  }
}

scheduler.spawnNow();
setTimeout(() => scheduler.spawnNow(), 1800);

setInterval(logicTick, 50);
requestAnimationFrame(animate);

// Expose for debugging
window.__api = api;
window.__ui = ui;
window.__guidance = guidance;
window.__scheduler = scheduler;
window.__gi = gi;
window.__bridges = bridges;
window.__pump = (n = 30, dt = 0.1) => { for (let i = 0; i < n; i++) renderFrame(dt); };
// Fast-forward the whole pipeline in lock-step (keeps all layer clocks in sync).
window.__analytics = analytics;
window.__safetynet = safetyNet;
window.__step = (n = 200, dt = 0.5) => {
  for (let i = 0; i < n; i++) {
    api.update(dt);
    scheduler.update(dt);
    const s = api.getSnapshot();
    analytics.update(s, dt);
    safetyNet.update(s);
    dcb.update(s);
    runLog.tick(s, dt);
  }
  return analytics.getMetrics();
};
window.__dcb = dcb;

// Health watchdog handshake (index.html inline script shows a diagnostic page
// if this is not set within 12 s — i.e. the CDN/module chain failed to load).
window.__appReady = true;
