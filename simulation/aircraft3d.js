/**
 * Aircraft3D — procedural Boeing/Airbus-style jet + CSS2D callsign label.
 *
 * Model built in local space: nose at −Z, tail at +Z, wings span ±X, up +Y.
 * The group sits at world y=0.6; heading is set externally via
 *   group.rotation.y = atan2(-dir.x, -dir.z)
 *
 * Variants by Flight.type:
 *   SMALL  → A320-family narrow-body, sharklets
 *   MEDIUM → 737-family narrow-body, blended winglets
 *   LARGE  → 777-family wide-body, raked wingtips
 */

import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { t } from './i18n.js';

// ── Parametric profiles (world units, 1u ≈ 8m) ──────────────────────────────────
const PROFILES = {
  SMALL: {
    family: 'airbus',
    fusLen: 4.0, fusR: 0.30, noseLen: 0.55, tailUpsweep: 0.18,
    wingSpan: 5.0, wingRootChord: 0.66, wingTipChord: 0.22, wingSweep: 0.55, wingDihedral: 0.10,
    wingZ: 0.05, wingY: -0.12, tipStyle: 'sharklet',
    engR: 0.20, engLen: 0.95, engY: -0.32, engSpanFrac: 0.30, engZ: 0.10,
    vstabH: 1.05, vstabRootChord: 0.85, vstabTipChord: 0.40, vstabSweep: 0.45, vstabZ: 1.55,
    hstabSpan: 1.45, hstabRootChord: 0.55, hstabTipChord: 0.22, hstabSweep: 0.35, hstabZ: 1.62,
  },
  MEDIUM: {
    family: 'boeing',
    fusLen: 4.6, fusR: 0.32, noseLen: 0.52, tailUpsweep: 0.20,
    wingSpan: 5.4, wingRootChord: 0.72, wingTipChord: 0.24, wingSweep: 0.62, wingDihedral: 0.11,
    wingZ: 0.10, wingY: -0.13, tipStyle: 'winglet',
    engR: 0.22, engLen: 1.05, engY: -0.34, engSpanFrac: 0.30, engZ: 0.12,
    vstabH: 1.15, vstabRootChord: 0.95, vstabTipChord: 0.42, vstabSweep: 0.5, vstabZ: 1.85,
    hstabSpan: 1.6, hstabRootChord: 0.6, hstabTipChord: 0.24, hstabSweep: 0.4, hstabZ: 1.92,
  },
  LARGE: {
    family: 'boeing',
    fusLen: 7.0, fusR: 0.46, noseLen: 0.8, tailUpsweep: 0.28,
    wingSpan: 7.8, wingRootChord: 1.15, wingTipChord: 0.34, wingSweep: 0.95, wingDihedral: 0.12,
    wingZ: 0.25, wingY: -0.18, tipStyle: 'raked',
    engR: 0.32, engLen: 1.45, engY: -0.48, engSpanFrac: 0.28, engZ: 0.18,
    vstabH: 1.7, vstabRootChord: 1.5, vstabTipChord: 0.6, vstabSweep: 0.65, vstabZ: 2.85,
    hstabSpan: 2.5, hstabRootChord: 0.95, hstabTipChord: 0.34, hstabSweep: 0.55, hstabZ: 2.95,
  },
};

// Fuselage radius profile [radiusFrac, axialFrac] (nose at frac 0 → tail at 1).
// Rounded radome (radius rises fast near the tip) + slim tapered tailcone.
const FUSE_PROFILE = [
  [0.00, 0.00], [0.45, 0.010], [0.72, 0.035], [0.88, 0.075], [0.96, 0.13], [1.00, 0.21],
  [1.00, 0.64],
  [0.97, 0.72], [0.84, 0.82], [0.55, 0.91], [0.28, 0.97], [0.07, 1.00],
];

function makeMaterials(baseColor) {
  const P = (color, specular, shininess) =>
    new THREE.MeshPhongMaterial({ color, specular, shininess, side: THREE.DoubleSide });
  return {
    fuselage:   P(0xf2f4f7, 0x9fa8b5, 70),
    tail:       P(baseColor, 0x555566, 55),
    cheat:      P(baseColor, 0x444455, 50),
    wing:       P(0xdfe3e8, 0x888899, 45),
    engineCowl: P(0xeceff3, 0x888899, 50),
    engineCore: P(0x2b2f38, 0x222233, 30),
    window:  new THREE.MeshPhongMaterial({ color: 0x101418, specular: 0x223040, shininess: 120 }),
    navRed:  new THREE.MeshBasicMaterial({ color: 0xff2200 }),
    navGreen:new THREE.MeshBasicMaterial({ color: 0x00ff66 }),
    strobe:  new THREE.MeshBasicMaterial({ color: 0xffffff }),
    landing: new THREE.MeshBasicMaterial({ color: 0xfff4d0 }),
  };
}

function buildFuselage(p, M) {
  const pts = FUSE_PROFILE.map(([rf, af]) => new THREE.Vector2(rf * p.fusR, af * p.fusLen));
  const geo = new THREE.LatheGeometry(pts, 28);
  geo.translate(0, -p.fusLen / 2, 0);
  geo.rotateX(Math.PI / 2);              // lathe axis +Y → +Z; nose (frac 0) ends at −Z
  // Tail upsweep — raise rear vertices (tail is at +Z after rotation)
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    const t = Math.max(0, z / (p.fusLen * 0.5));
    if (t > 0) pos.setY(i, pos.getY(i) + p.tailUpsweep * t * t);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, M.fuselage);
  m.castShadow = true;
  return m;
}

// Horizontal thin lifting surface, built directly on the requested side (no
// mirror-scaling, which would invert normals AND flip dihedral). span along
// sign·X (sign +1 = starboard, −1 = port); chord along +Z (leading edge toward
// −Z/nose, tip swept AFT toward +Z); thickness centered on Y.
function buildLiftingSurface(span, rc, tc, sweep, depth = 0.06, sign = 1) {
  const s = new THREE.Shape();
  if (sign >= 0) {
    s.moveTo(0, 0); s.lineTo(0, rc); s.lineTo(span, sweep + tc); s.lineTo(span, sweep);
  } else {
    s.moveTo(0, 0); s.lineTo(-span, sweep); s.lineTo(-span, sweep + tc); s.lineTo(0, rc);
  }
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false });
  geo.rotateX(Math.PI / 2);        // chord (shape-Y) → +Z aft;  thickness → −Y
  geo.translate(0, depth / 2, 0);  // recenter thickness on y=0
  return geo;
}

function buildWingPair(p, M) {
  const half = p.wingSpan / 2;
  const mk = (sign) => {
    const g = buildLiftingSurface(half, p.wingRootChord, p.wingTipChord, p.wingSweep, 0.06, sign);
    g.translate(0, 0, p.wingZ - p.wingRootChord * 0.5);
    const m = new THREE.Mesh(g, M.wing);
    m.position.y = p.wingY;
    m.rotation.z = sign * p.wingDihedral;   // both tips up (dihedral)
    m.castShadow = true;
    return m;
  };
  return [mk(-1), mk(+1)];
}

// Flat swept wingtip extension. Stays in the wing plane (the wing's dihedral is
// carried over so the tip is flush) — no vertical winglet/sharklet that would
// read as the wing "folding upward". Raked tips reach a bit further out.
function buildTipDevice(p, M, sign) {
  const half  = p.wingSpan / 2;
  const baseX = sign * half;
  const baseY = p.wingY + half * Math.sin(p.wingDihedral);
  const baseZ = p.wingZ + p.wingSweep * 0.4;
  const tipLen = (p.tipStyle === 'raked' ? 0.45 : 0.22) * half;
  const g = buildLiftingSurface(tipLen, p.wingTipChord, p.wingTipChord * 0.45, p.wingSweep * 0.9, 0.05, sign);
  g.translate(0, 0, -p.wingTipChord * 0.5);
  const m = new THREE.Mesh(g, M.wing);
  m.position.set(baseX, baseY, baseZ);
  m.rotation.z = sign * p.wingDihedral;   // flush with the wing, no upward fold
  m.castShadow = true;
  return m;
}

function buildEngine(p, M) {
  const e = new THREE.Group();
  const cowl = new THREE.Mesh(new THREE.CylinderGeometry(p.engR, p.engR * 0.92, p.engLen, 18), M.engineCowl);
  cowl.rotation.x = Math.PI / 2; cowl.castShadow = true; e.add(cowl);
  const intake = new THREE.Mesh(new THREE.CylinderGeometry(p.engR * 0.78, p.engR * 0.78, 0.06, 18), M.engineCore);
  intake.rotation.x = Math.PI / 2; intake.position.z = -p.engLen * 0.5; e.add(intake);
  const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(p.engR * 0.5, p.engR * 0.35, 0.18, 16), M.engineCore);
  exhaust.rotation.x = Math.PI / 2; exhaust.position.z = p.engLen * 0.5; e.add(exhaust);
  const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.06, Math.abs(p.wingY - p.engY) + 0.12, p.engLen * 0.5), M.wing);
  pylon.position.set(0, (p.wingY - p.engY) * 0.5 + 0.04, -p.engLen * 0.05);
  e.add(pylon);
  return e;
}

function buildMesh(type, baseColor) {
  const p = PROFILES[type] ?? PROFILES.MEDIUM;
  const M = makeMaterials(baseColor);
  const grp = new THREE.Group();

  grp.add(buildFuselage(p, M));

  // Windscreen
  const ws = new THREE.Mesh(new THREE.BoxGeometry(p.fusR * 1.05, p.fusR * 0.34, p.fusR * 0.5), M.window);
  ws.position.set(0, p.fusR * 0.30, -p.fusLen * 0.5 + p.noseLen * 1.15); ws.rotation.x = -0.35;
  grp.add(ws);

  // Cabin window strips + cheatline
  const strip = new THREE.BoxGeometry(0.02, p.fusR * 0.14, p.fusLen * 0.62);
  const sL = new THREE.Mesh(strip, M.window); sL.position.set(-p.fusR * 0.97, p.fusR * 0.18, 0);
  const sR = sL.clone(); sR.position.x = p.fusR * 0.97;
  const cheat = new THREE.BoxGeometry(0.02, p.fusR * 0.10, p.fusLen * 0.72);
  const cL = new THREE.Mesh(cheat, M.cheat); cL.position.set(-p.fusR * 0.985, p.fusR * 0.02, 0);
  const cR = cL.clone(); cR.position.x = p.fusR * 0.985;
  grp.add(sL, sR, cL, cR);

  // Wings — clean swept tips (no upward winglet/sharklet that reads as a "fold")
  const [wL, wR] = buildWingPair(p, M); grp.add(wL, wR);

  // Engines
  const ex = (p.wingSpan / 2) * p.engSpanFrac;
  const eR = buildEngine(p, M); eR.position.set( ex, p.engY, p.wingZ + p.engZ);
  const eL = buildEngine(p, M); eL.position.set(-ex, p.engY, p.wingZ + p.engZ);
  grp.add(eR, eL);

  // Vertical fin (airline livery) — a lifting surface stood upright.
  const finGeo = buildLiftingSurface(p.vstabH, p.vstabRootChord, p.vstabTipChord, p.vstabSweep, 0.05);
  finGeo.rotateZ(Math.PI / 2);     // span → +Y (vertical), chord stays +Z (swept aft)
  finGeo.translate(0, 0, p.vstabZ - p.vstabRootChord * 0.5);
  const fin = new THREE.Mesh(finGeo, M.tail); fin.position.y = p.fusR * 0.55; fin.castShadow = true;
  grp.add(fin);

  // Horizontal stabilizers (built per side, no mirror-scaling)
  const mkHs = (sign) => {
    const g = buildLiftingSurface(p.hstabSpan / 2, p.hstabRootChord, p.hstabTipChord, p.hstabSweep, 0.04, sign);
    g.translate(0, 0, p.hstabZ - p.hstabRootChord * 0.5);
    const m = new THREE.Mesh(g, M.wing); m.position.y = p.fusR * 0.18; m.castShadow = true;
    return m;
  };
  grp.add(mkHs(-1), mkHs(+1));

  // Nav lights / strobe / landing light
  const tipY = p.wingY + (p.wingSpan / 2) * Math.sin(p.wingDihedral);
  const green = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 6), M.navGreen);
  green.position.set(p.wingSpan / 2, tipY, p.wingZ + p.wingSweep);
  const red = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 6), M.navRed);
  red.position.set(-p.wingSpan / 2, tipY, p.wingZ + p.wingSweep);
  const strobeMesh = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 6), M.strobe);
  strobeMesh.position.set(0, p.fusR * 0.7 + p.vstabH * 0.9, p.vstabZ + p.vstabSweep * 0.5);
  const land = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 6), M.landing);
  land.position.set(0, p.wingY, -p.fusLen * 0.5 + p.noseLen * 1.4);
  grp.add(green, red, strobeMesh, land);

  grp.userData.strobe = strobeMesh;
  grp.userData.profile = p;
  return grp;
}

// Small pushback tug, parked at the aircraft nose; shown only during PUSHBACK.
function buildPushbackTug(p) {
  const g = new THREE.Group();
  const matBody = new THREE.MeshPhongMaterial({ color: 0xf1c40f, shininess: 40 });
  const matDark = new THREE.MeshPhongMaterial({ color: 0x222831, shininess: 20 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.4, 1.5), matBody);
  body.position.y = 0.3; body.castShadow = true; g.add(body);
  const cab = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.42, 0.6), matDark);
  cab.position.set(0, 0.68, -0.2); g.add(cab);
  for (const sx of [-0.42, 0.42]) for (const sz of [-0.5, 0.5]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.14, 10), matDark);
    w.rotation.z = Math.PI / 2; w.position.set(sx, 0.17, sz); g.add(w);
  }
  // Tow bar toward the nose gear (local +Z, toward the fuselage)
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.9), matDark);
  bar.position.set(0, 0.22, 0.85); g.add(bar);
  // Place ahead of the nose, on the ground (group sits at y=0.6)
  g.position.set(0, -0.6, -(p.fusLen * 0.5 + 0.85));
  g.visible = false;
  return g;
}

// ── Aircraft3D class ────────────────────────────────────────────────────────────
export class Aircraft3D {
  constructor(scene, flight) {
    this.scene  = scene;
    this.flight = flight;
    this.group  = buildMesh(flight.type, flight.color);
    this.group.rotation.order = 'YXZ';   // yaw (heading) then pitch in local frame
    this.group.position.set(flight.x, 0.6 + (flight.y || 0), flight.z);
    scene.add(this.group);

    // Door (forward-left) local offset, for jet-bridge docking. Y sits on the
    // upper side of the fuselage (cabin-door height), not floating above it.
    const p = PROFILES[flight.type] ?? PROFILES.MEDIUM;
    this._doorLocal = new THREE.Vector3(-(p.fusR + 0.05), p.fusR * 0.55, -p.fusLen * 0.30);

    // Pushback tug (child at the nose; visible only during pushback)
    this._tug = buildPushbackTug(p);
    this.group.add(this._tug);

    // CSS2D callsign label
    const wrap = document.createElement('div');
    wrap.className = 'aircraft-label';

    this._callDiv = document.createElement('div');
    this._callDiv.className   = 'alabel-call';
    this._callDiv.textContent = flight.callsign;

    this._stateDiv = document.createElement('div');
    this._stateDiv.className = 'alabel-state';

    wrap.appendChild(this._callDiv);
    wrap.appendChild(this._stateDiv);

    this._labelObj = new CSS2DObject(wrap);
    this._labelObj.position.set(0, p.fusR * 0.7 + p.vstabH + 0.9, 0);
    this.group.add(this._labelObj);

    // Initialize heading from the first segment so it doesn't swing on spawn.
    const d0 = flight.getDirection();
    this._yaw = Math.atan2(-d0.x, -d0.z);
    this.group.rotation.y = this._yaw;
    this._pitch = 0;
    this._prevWorld = null;
  }

  /** World position of the forward-left passenger door (writes into out). */
  getDoorWorldPos(out) {
    this.group.updateMatrixWorld();
    return out.copy(this._doorLocal).applyMatrix4(this.group.matrixWorld);
  }

  update() {
    const pos = this.flight.getPosition();
    const wy  = 0.6 + (pos.y || 0);
    this.group.position.set(pos.x, wy, pos.z);

    // Heading (smoothed). During PUSHBACK keep the nose pointing the way it was
    // parked (reverse of travel) so the tug pushes it back tail-first.
    let dir = this.flight.getDirection();
    if (this.flight.state === 'PUSHBACK') dir = { x: -dir.x, z: -dir.z };
    if (Math.hypot(dir.x, dir.z) > 0.05) {
      const target = Math.atan2(-dir.x, -dir.z);
      let d = target - this._yaw;
      while (d >  Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      this._yaw += d * 0.2;                 // smooth turns
      this.group.rotation.y = this._yaw;
    }

    // Pitch from climb/descent rate (nose up climbing, slightly down on descent)
    if (this._prevWorld) {
      const dy  = wy - this._prevWorld.y;
      const dxz = Math.hypot(pos.x - this._prevWorld.x, pos.z - this._prevWorld.z);
      let target = dxz > 0.002 ? Math.atan2(dy, dxz) : 0;
      target = Math.max(-0.12, Math.min(0.45, target));
      this._pitch += (target - this._pitch) * 0.1;
    }
    this._prevWorld = { x: pos.x, y: wy, z: pos.z };
    this.group.rotation.x = this._pitch;

    // Tug visible only while being pushed back
    if (this._tug) this._tug.visible = (this.flight.state === 'PUSHBACK');

    // Update label state text (localized; DONE shows nothing; DMAN gate hold
    // shows its own pseudo-state while awaiting TSAT start-up approval)
    this._stateDiv.textContent = this.flight.state === 'DONE' ? ''
      : t('state.' + (this.flight.isGateHeld ? 'GATE_HOLD' : this.flight.state), '');

    // Strobe blink (wall-clock based double-flash)
    const strobe = this.group.userData.strobe;
    if (strobe) {
      const phase = performance.now() % 1400;
      strobe.visible = (phase < 80) || (phase > 200 && phase < 280);
    }
  }

  remove() {
    this.scene.remove(this.group);
  }
}
