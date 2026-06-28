/**
 * Airport 3D geometry — runways, taxiways, apron, terminal, gates, tower.
 *
 * World layout (units ≈ 8 m each):
 *   Terminal:  Z [ 18, 30 ]   Gates: Z = 12   Apron: Z [ 0, 16 ]
 *   Taxiway A: Z = -10        Runway 1: Z = -25   Runway 2: Z = -42
 *
 * Gate positions come from the single source of truth in control/gate-layout.js.
 * Per-gate furniture lives in `gateGroup` so it can be rebuilt on reconfigure.
 */

import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { getGates, getGateDef } from '../control/gate-layout.js';
import { t, onLangChange } from './i18n.js';

// ── Shared materials ──────────────────────────────────────────────────────────
const matAsphalt  = new THREE.MeshLambertMaterial({ color: 0x1a1e24 });
const matConcrete = new THREE.MeshLambertMaterial({ color: 0x252c36 });
const matTerminal = new THREE.MeshPhongMaterial({ color: 0x2a3850, specular: 0x4488cc, shininess: 40 });
const matGlass    = new THREE.MeshPhongMaterial({
  color: 0x1a5090, transparent: true, opacity: 0.55,
  side: THREE.FrontSide, depthWrite: false, specular: 0x88ccff, shininess: 80,
});
const matStripe   = new THREE.MeshLambertMaterial({ color: 0xffffff });
const matYellow   = new THREE.MeshLambertMaterial({ color: 0xddaa00 });
const matTower    = new THREE.MeshPhongMaterial({ color: 0x3a5070, specular: 0x6688aa, shininess: 30 });
const matRemote   = new THREE.MeshLambertMaterial({ color: 0x3a4658 });

// ── Helpers ───────────────────────────────────────────────────────────────────
function mkBox(w, h, d, mat, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow   = true;
  m.receiveShadow = true;
  return m;
}

export class Airport3D {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);

    this.gateGroup   = new THREE.Group();   // rebuildable per-gate furniture
    this.group.add(this.gateGroup);
    this.gateMarkers = [];                   // raycast targets (ground planes)
    this._gateLabels = [];                   // CSS2D label objects (for cleanup)

    this._build();
  }

  _add(mesh) { this.group.add(mesh); return mesh; }

  _build() {
    this._buildRunways();
    this._buildTaxiways();
    this._buildApron();
    this._buildTerminal();
    this._buildGates();
    this._buildControlTower();
    this._buildEdgeLights();
    this._buildLabels();
  }

  getGateDef(id) { return getGateDef(id); }
  get gates() { return getGates(); }

  // ── Runways ────────────────────────────────────────────────────────────────
  _buildRunways() {
    for (const rz of [-25, -42]) {
      this._add(mkBox(148, 0.08, 7, matAsphalt, 0, 0, rz));
      for (let x = -60; x <= 60; x += 8) {
        this._add(mkBox(4.5, 0.1, 0.18, matStripe, x, 0.05, rz));
      }
      for (const tx of [-69, 69]) {
        for (let i = -2; i <= 2; i++) {
          this._add(mkBox(0.3, 0.1, 4, matStripe, tx, 0.05, rz + i * 1.1));
        }
      }
      for (const side of [-1, 1]) {
        for (const off of [12, 20, 28]) {
          this._add(mkBox(2.5, 0.1, 0.5, matStripe, side * off, 0.05, rz));
        }
      }
    }
  }

  // ── Taxiways ───────────────────────────────────────────────────────────────
  _buildTaxiways() {
    this._add(mkBox(134, 0.06, 5, matAsphalt, 0, 0, -10));
    for (let x = -62; x <= 62; x += 6) {
      this._add(mkBox(3, 0.1, 0.12, matYellow, x, 0.04, -10));
    }
    for (const cx of [-25, 0, 25]) {
      this._add(mkBox(5, 0.06, 10.2, matAsphalt, cx, 0, -5));
      for (let z = -9; z <= -1; z += 4) {
        this._add(mkBox(0.12, 0.1, 2, matYellow, cx, 0.04, z));
      }
    }
    this._add(mkBox(5, 0.06, 15, matAsphalt, 45,  0, -17.5));
    this._add(mkBox(5, 0.06, 15, matAsphalt, -45, 0, -17.5));
    this._add(mkBox(5, 0.06, 32, matAsphalt, 55,  0, -26));
    this._add(mkBox(5, 0.06, 32, matAsphalt, -55, 0, -26));
    for (const [hx, hz] of [[-45, -23], [45, -23], [-55, -40], [55, -40]]) {
      this._add(mkBox(5.5, 0.12, 0.2,  matYellow, hx, 0.06, hz));
      this._add(mkBox(5.5, 0.12, 0.18, matYellow, hx, 0.06, hz + 0.55));
    }
  }

  // ── Apron (static concrete) ─────────────────────────────────────────────────
  _buildApron() {
    this._add(mkBox(72, 0.06, 20, matConcrete, 0, 0, 8));
  }

  // ── Gates (rebuildable furniture) ────────────────────────────────────────────
  _buildGates() {
    for (const g of getGates()) {
      // Lead-in yellow stripe
      for (let z = 2; z <= 11; z += 3.5) {
        this.gateGroup.add(mkBox(0.12, 0.1, 1.8, matYellow, g.x, 0.04, z));
      }
      // Stop bar
      this.gateGroup.add(mkBox(3.5, 0.1, 0.14, matStripe, g.x, 0.05, 12.6));

      if (g.hasBridge) {
        // Animated jet bridge (jetbridge3d.js) replaces any static stub here.
      } else {
        // Remote stand marker — short pylon, no bridge.
        this.gateGroup.add(mkBox(0.6, 1.0, 0.6, matRemote, g.x, 0.5, 14.0));
      }

      // Raycastable ground marker (covers the parking box).
      const marker = new THREE.Mesh(
        new THREE.PlaneGeometry(8, 9),
        new THREE.MeshBasicMaterial({ color: 0x123047, transparent: true, opacity: 0.12, depthWrite: false }));
      marker.rotation.x = -Math.PI / 2;
      marker.position.set(g.x, 0.02, 8);
      marker.name = 'gate-marker';
      marker.userData.gateId = g.id;
      this.gateGroup.add(marker);
      this.gateMarkers.push(marker);

      // Numbered badge (CSS2D)
      const div = document.createElement('div');
      div.className   = 'gate-badge';
      div.textContent = g.id;
      const lbl = new CSS2DObject(div);
      lbl.position.set(g.x, 0.5, 5);
      this.gateGroup.add(lbl);
      this._gateLabels.push(lbl);
    }
  }

  /** Rebuild all per-gate furniture from the current gate layout. */
  rebuildGates() {
    // Remove CSS2D labels (and their DOM)
    for (const lbl of this._gateLabels) {
      lbl.element?.remove();
      this.gateGroup.remove(lbl);
    }
    this._gateLabels = [];
    this.gateMarkers = [];

    // Dispose & remove all mesh children
    for (const child of [...this.gateGroup.children]) {
      this.gateGroup.remove(child);
      if (child.geometry) child.geometry.dispose();
    }

    this._buildGates();
  }

  // ── Terminal ───────────────────────────────────────────────────────────────
  // Pushed north so the building footprint clears the ramp zone: parked aircraft
  // reach z≈15.5 (wide-body nose), service vehicles z≈14.5, jet bridges z≈16.
  // Concourse front face now at z=18, main terminal front at z=24.
  _buildTerminal() {
    this._add(mkBox(80, 9, 12, matTerminal, 0, 4.5, 30));
    this._add(mkBox(80, 9, 0.3, matGlass, 0, 4.5, 24.1));
    this._add(mkBox(82, 0.4, 0.4, matTower, 0, 9.2, 24));
    this._add(mkBox(24, 6, 8, matTerminal, -26, 3, 22));
    this._add(mkBox(24, 6, 0.2, matGlass, -26, 3, 18.1));
    this._add(mkBox(24, 6, 8, matTerminal, 26, 3, 22));
    this._add(mkBox(24, 6, 0.2, matGlass, 26, 3, 18.1));
  }

  // ── Control Tower ─────────────────────────────────────────────────────────
  _buildControlTower() {
    this._add(mkBox(6, 1.5, 6, matTower, 58, 0.75, 28));
    this._add(mkBox(2.8, 18, 2.8, matTower, 58, 9.5, 28));
    this._add(mkBox(5.5, 3.2, 5.5, matGlass, 58, 19.5, 28));
    this._add(mkBox(6, 0.4, 6, matTower, 58, 21, 28));
    this._add(mkBox(0.18, 4, 0.18, matStripe, 58, 23, 28));

    const div = document.createElement('div');
    div.className   = 'gate-label';
    div.textContent = 'ATC';
    const lbl = new CSS2DObject(div);
    lbl.position.set(58, 23, 28);
    this.group.add(lbl);
  }

  // ── Edge & apron lights ────────────────────────────────────────────────────
  _buildEdgeLights() {
    const lightGeo  = new THREE.CylinderGeometry(0.12, 0.12, 0.28, 6);
    const matWhite  = new THREE.MeshBasicMaterial({ color: 0xfffcee });
    const matBlue   = new THREE.MeshBasicMaterial({ color: 0x3355ff });
    const matOrangeL = new THREE.MeshBasicMaterial({ color: 0xff9944 });

    for (const rz of [-25, -42]) {
      for (let x = -70; x <= 70; x += 5) {
        for (const side of [-3.7, 3.7]) {
          const l = new THREE.Mesh(lightGeo, matWhite);
          l.position.set(x, 0.15, rz + side);
          this.group.add(l);
        }
      }
    }
    for (let x = -65; x <= 65; x += 7) {
      for (const side of [-2.6, 2.6]) {
        const l = new THREE.Mesh(lightGeo, matBlue);
        l.position.set(x, 0.15, -10 + side);
        this.group.add(l);
      }
    }
    for (const px of [-36, -18, 0, 18, 36]) {
      this._add(mkBox(0.4, 6, 0.4, matTower, px, 3, 16.5));
      const head = new THREE.Mesh(new THREE.BoxGeometry(2, 0.5, 0.9), matOrangeL);
      head.position.set(px, 6.3, 16.5);
      this.group.add(head);
    }
  }

  // ── CSS2D runway & terminal labels ─────────────────────────────────────────
  _buildLabels() {
    // Terminal label is localized + updates on language switch.
    const termDiv = document.createElement('div');
    termDiv.className = 'rwy-label';
    termDiv.textContent = t('world.terminal');
    termDiv.style.fontSize = '12px';
    termDiv.style.color = 'rgba(180,210,255,0.65)';
    const termLbl = new CSS2DObject(termDiv);
    termLbl.position.set(0, 10, 30);
    this.group.add(termLbl);
    onLangChange(() => { termDiv.textContent = t('world.terminal'); });

    for (const [rz, l1, l2] of [[-25, 'RWY 27', 'RWY 09'], [-42, '27L', '09R']]) {
      for (const [tx, txt] of [[-68, l1], [68, l2]]) {
        const div = document.createElement('div');
        div.className   = 'rwy-label';
        div.textContent = txt;
        const lbl = new CSS2DObject(div);
        lbl.position.set(tx, 0.3, rz);
        this.group.add(lbl);
      }
    }
  }
}
