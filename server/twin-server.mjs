#!/usr/bin/env node
/**
 * AirportTwin server — the twin's authoritative back end.
 *
 * Industry twins run a three-tier stack (UI / business logic / persistence)
 * with a real-time pub-sub layer over the operational database. This server is
 * that back end for AirportTwin, and it is authoritative rather than a mock:
 * it imports the SAME control + optimization modules the browser runs (they are
 * pure JS with no DOM), so the simulation on the server IS the twin.
 *
 *   business logic  → the control layer advancing on a fixed tick
 *   pub-sub         → WebSocket /feed broadcasting standard snapshots
 *                     (schemaVersion 1.0 — the browser's existing live-data
 *                     client speaks this already, no client change needed)
 *   persistence     → bounded JSONL history + a query API for replay
 *
 * Zero dependencies: a minimal RFC 6455 server frame encoder is included, so
 * the project keeps its no-build-step, no-package.json posture.
 *
 * Run: node server/twin-server.mjs [port]
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AirportAPI } from '../control/airport-api.js';
import { Scheduler } from '../optimization/scheduler.js';
import { AnalyticsEngine } from '../optimization/analytics.js';
import { RunwaySafetyNet } from '../optimization/safety-nets.js';
import { DCBForecaster } from '../optimization/dcb-forecaster.js';

const PORT = Number(process.argv[2] || process.env.PORT || 3600);
const DIR = path.dirname(fileURLToPath(import.meta.url));
const HIST_FILE = path.join(DIR, 'history.jsonl');
const TICK_MS = 500;            // 2 Hz authoritative tick
const HIST_EVERY = 4;           // persist every Nth tick (~2 s)
const HIST_MAX = 4000;          // bounded summary history (~2.2 h)
const FRAME_EVERY = 4;          // full-fidelity replay frames, same cadence
const FRAME_MAX = 900;          // ~30 min of replay frames held in memory

// ── Business-logic tier: the authoritative simulation ────────────────────────
const api = new AirportAPI({ runways: 2 });
const scheduler = new Scheduler(api, { arrivalInterval: 25 });
const analytics = new AnalyticsEngine(api, scheduler, { targetUtil: 0.6 });
const safetyNet = new RunwaySafetyNet(api);
const dcb = new DCBForecaster(api, scheduler);

let snapshot = api.getSnapshot();
let ticks = 0;
const history = [];             // in-memory mirror of the persisted summary tail
const frames = [];              // full replay frames (positions) — memory only
const events = [];              // recent control-plane events

for (const ev of ['flight_spawned', 'flight_departed', 'rimcas_alert', 'lightning_stop',
                  'lightning_clear', 'deicing_on', 'deicing_off', 'runway_closed', 'runway_opened']) {
  api.on(ev, (d) => {
    events.unshift({ ev, sim: +api.getSnapshot().simTimeSec.toFixed(1), wall: Date.now(),
                     cs: d && d.callsign, runway: d && d.runway });
    if (events.length > 200) events.pop();
  });
}

function tick() {
  const dt = TICK_MS / 1000;
  api.update(dt);
  scheduler.update(dt);
  snapshot = api.getSnapshot();
  analytics.update(snapshot, dt);
  safetyNet.update(snapshot);
  dcb.update(snapshot);
  broadcast(snapshot);
  if (++ticks % HIST_EVERY === 0) persist(snapshot);
  if (ticks % FRAME_EVERY === 0) keepFrame(snapshot);
}

// ── Persistence tier ─────────────────────────────────────────────────────────
function persist(s) {
  const row = { sim: s.simTimeSec, wall: s.wallClock, stats: s.stats,
                flights: s.flights.length, disruptions: s.disruptions };
  history.push(row);
  if (history.length > HIST_MAX) history.shift();
  try { fs.appendFileSync(HIST_FILE, JSON.stringify(row) + '\n'); } catch (e) {}
  // Rewrite the file when it outgrows the window, so it stays bounded on disk.
  if (history.length === HIST_MAX && ticks % (HIST_EVERY * 500) === 0) {
    try { fs.writeFileSync(HIST_FILE, history.map(r => JSON.stringify(r)).join('\n') + '\n'); } catch (e) {}
  }
}

/**
 * Replay frames: the summary history above is deliberately light (and the only
 * thing written to disk), so it cannot drive a positional replay. These frames
 * keep just what a replay needs — id, callsign, state, position, runway, gate —
 * in memory, bounded to ~30 min.
 */
function keepFrame(s) {
  frames.push({
    sim: s.simTimeSec,
    flights: s.flights
      .filter(f => f.state !== 'DONE')
      .map(f => ({ id: f.id, cs: f.callsign, st: f.state, rwy: f.runway, gate: f.gate,
                   x: f.position.x, y: f.position.y, z: f.position.z })),
  });
  if (frames.length > FRAME_MAX) frames.shift();
}

// ── Minimal RFC 6455 (server → client text frames) ───────────────────────────
const GUID = '258EAFA5-E914-47DA-95CA-5AB0DC85B11A';
const clients = new Set();

function wsFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = 0x81;                                  // FIN + text opcode
  return Buffer.concat([head, payload]);
}

function broadcast(s) {
  if (!clients.size) return;
  const frame = wsFrame(JSON.stringify(s));
  for (const sock of clients) {
    if (sock.destroyed) { clients.delete(sock); continue; }
    try { sock.write(frame); } catch (e) { clients.delete(sock); }
  }
}

function onUpgrade(req, sock) {
  const key = req.headers['sec-websocket-key'];
  if (!key || !req.url.startsWith('/feed')) { sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n' +
             'Connection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);
  clients.add(sock);
  sock.write(wsFrame(JSON.stringify(snapshot)));   // prime the client immediately
  const drop = () => clients.delete(sock);
  sock.on('close', drop); sock.on('error', drop); sock.on('end', drop);
  // Client frames are masked; we only need to notice a close opcode (0x8).
  sock.on('data', (buf) => { if ((buf[0] & 0x0f) === 0x8) { drop(); sock.destroy(); } });
}

// ── HTTP tier: query + control API ───────────────────────────────────────────
const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8',
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Headers': 'Content-Type',
                        'Cache-Control': 'no-store' });
  res.end(s);
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') return json(res, 204, {});

  if (url.pathname === '/api/health')
    return json(res, 200, { ok: true, uptimeSec: +process.uptime().toFixed(1),
                            simTimeSec: snapshot.simTimeSec, clients: clients.size,
                            historyRows: history.length, replayFrames: frames.length,
                            schemaVersion: snapshot.schemaVersion });

  if (url.pathname === '/api/snapshot') return json(res, 200, snapshot);

  if (url.pathname === '/api/events')
    return json(res, 200, { events: events.slice(0, Number(url.searchParams.get('limit') || 50)) });

  if (url.pathname === '/api/replay') {
    if (!frames.length) return json(res, 200, { frames: [], span: null });
    const from = Number(url.searchParams.get('from') ?? frames[0].sim);
    const to = Number(url.searchParams.get('to') ?? frames[frames.length - 1].sim);
    const sel = frames.filter(f => f.sim >= from && f.sim <= to);
    return json(res, 200, {
      span: { min: frames[0].sim, max: frames[frames.length - 1].sim, held: frames.length },
      count: sel.length, frames: sel.slice(-600),
    });
  }

  if (url.pathname === '/api/history') {
    const from = Number(url.searchParams.get('from') || 0);
    const to = Number(url.searchParams.get('to') || Infinity);
    const rows = history.filter(r => r.sim >= from && r.sim <= to);
    return json(res, 200, { count: rows.length, from, to, rows: rows.slice(-1000) });
  }

  if (url.pathname === '/api/control' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      let cmd; try { cmd = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
      try {
        switch (cmd.action) {
          case 'weather':   api.setWeather(Number(cmd.level) || 0); break;
          case 'runway':    cmd.closed ? api.closeRunway(cmd.runway) : api.openRunway(cmd.runway); break;
          case 'deicing':   api.setDeicing(!!cmd.on); break;
          case 'lightning': api.setLightning(!!cmd.on); break;
          case 'metering':  api.setMetering(!!cmd.on); break;
          case 'interval':  scheduler.setInterval(Number(cmd.sec) || 25); break;
          case 'spawn':     scheduler.spawnNow(); break;
          default: return json(res, 400, { error: 'unknown action' });
        }
      } catch (e) { return json(res, 500, { error: String(e && e.message || e) }); }
      return json(res, 200, { ok: true, action: cmd.action, simTimeSec: snapshot.simTimeSec });
    });
    return;
  }

  json(res, 404, { error: 'not found' });
});

server.on('upgrade', onUpgrade);
server.listen(PORT, () => {
  console.log(`AirportTwin server on :${PORT} — ws://…/feed, GET /api/{health,snapshot,history,events}, POST /api/control`);
  setInterval(tick, TICK_MS);
});
