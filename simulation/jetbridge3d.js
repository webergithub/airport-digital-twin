/**
 * JetBridge3D — animated jet bridge that docks to a parked aircraft's forward
 * door, simulates deboarding, then retracts before pushback.
 *
 * One bridge per gate where gate.hasBridge. Built once (and rebuilt on gate
 * reconfigure). Driven each animation frame by reading the parked flight's
 * state (read-only) — animation lives entirely in the simulation layer.
 *
 *   IDLE → EXTENDING → DOCKED → RETRACTING → IDLE
 *
 * Scaled for the compressed airport (1u ≈ 8m): the bridge is an apron-pedestal
 * unit beside the gate (+X), swinging a short telescopic tunnel to the door.
 * Dock angle + reach are computed from the live aircraft door position.
 */

import * as THREE from 'three';
import { getGates } from '../control/gate-layout.js';

const matBridge    = new THREE.MeshPhongMaterial({ color: 0x9aa6b8, specular: 0x556677, shininess: 50 });
const matBridge2   = new THREE.MeshPhongMaterial({ color: 0xb4bdcb, specular: 0x556677, shininess: 50 });
const matBellows   = new THREE.MeshLambertMaterial({ color: 0x15171c });
const matBridgeLeg = new THREE.MeshPhongMaterial({ color: 0x3a4658, shininess: 20 });
const matPax       = new THREE.MeshBasicMaterial({ color: 0xffe0a0 });

const EXTEND_DUR = 3.0, RETRACT_DUR = 2.5;
const L0 = 0.9, L1 = 1.0, CAB_HD = 0.4, BELLOWS_D = 0.18;
const PIVOT_Y = 1.35;                         // tunnel height ≈ cabin door height
const ANCHOR_DX = 1.8, ANCHOR_Z = 16;         // pedestal on the terminal side, +X of gate
const smooth = p => p * p * (3 - 2 * p);
const clamp  = (v, a, b) => Math.max(a, Math.min(b, v));
const _tmp   = new THREE.Vector3();

export class JetBridge3D {
  constructor(scene, gate) {
    this.scene = scene; this.gate = gate;
    this.state = 'IDLE'; this._t = 0; this._reach = 0;
    this._reachMax = 0; this._dockAngle = 0; this._flightId = null; this._notified = false;
    this.onEvent = null;

    this.group = new THREE.Group();
    const ax = gate.x + ANCHOR_DX, az = ANCHOR_Z;
    this.group.position.set(ax, 0, az);

    // Rotunda pedestal
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.4, 1.5, 12), matBridgeLeg);
    col.position.y = 0.75; this.group.add(col);
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.7, 16), matBridge);
    drum.position.y = PIVOT_Y; this.group.add(drum);

    // Pivot — rotates about Y, telescopes along local +Z
    this.pivot = new THREE.Group();
    this.pivot.position.set(0, PIVOT_Y, 0);
    this.group.add(this.pivot);

    this.seg0 = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.85, L0), matBridge);
    this.seg0.position.z = L0 * 0.5; this.pivot.add(this.seg0);

    this.seg1 = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.75, L1), matBridge2);
    this.pivot.add(this.seg1);

    // Cab (mates to aircraft door)
    this.cab = new THREE.Group();
    this.cab.add(new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.0, 0.7), matBridge));
    const collar = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.05, BELLOWS_D), matBellows);
    collar.position.z = 0.42; this.cab.add(collar);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 1.2, 8), matBridgeLeg);
    leg.position.set(0, -0.72, 0); this.cab.add(leg);
    this.pivot.add(this.cab);

    // Pre-aim toward the gate centerline door (refined per dock).
    this._dockAngle = Math.atan2((gate.x + 0.4) - ax, 13.4 - az);
    this.pivot.rotation.y = this._dockAngle;

    this._buildPax();
    this._applyPose();
    scene.add(this.group);
  }

  _buildPax() {
    this.pax = new THREE.Group(); this.pax.visible = false;
    const g = new THREE.SphereGeometry(0.09, 6, 6);
    this._paxDots = [];
    for (let i = 0; i < 5; i++) {
      const d = new THREE.Mesh(g, matPax);
      d.userData.phase = i / 5;
      this.pax.add(d); this._paxDots.push(d);
    }
    this.pivot.add(this.pax);
  }

  _applyPose() {
    this.seg1.position.z = (L0 - L0 * 0.4) + this._reach + L1 * 0.5;
    this.cab.position.z  = L0 + this._reach + CAB_HD;
  }

  _animatePax() {
    const t = performance.now() / 1000;
    const startZ = L0 + this._reach;   // cab end
    const endZ   = 0.3;                // rotunda
    for (const d of this._paxDots) {
      const u = (t * 0.83 + d.userData.phase) % 1;
      d.position.set(0, -0.2, startZ + (endZ - startZ) * u);
    }
  }

  _computeDock(aircraft3d) {
    if (!aircraft3d || !aircraft3d.getDoorWorldPos) { this._reachMax = 0.6; return; }
    const door = aircraft3d.getDoorWorldPos(_tmp);
    const ax = this.group.position.x, az = this.group.position.z;
    const dx = door.x - ax, dz = door.z - az;
    this._dockAngle = Math.atan2(dx, dz);
    this.pivot.rotation.y = this._dockAngle;
    this._reachMax = clamp(Math.hypot(dx, dz) - (L0 + CAB_HD + BELLOWS_D), 0.3, 2.5);
  }

  update(dt, occupant, aircraft3d) {
    switch (this.state) {
      case 'IDLE':
        if (occupant && occupant.stateTimer > 0.3) {
          this._flightId = occupant.id;
          this._computeDock(aircraft3d);
          this.state = 'EXTENDING'; this._t = 0; this._notified = false;
        }
        break;
      case 'EXTENDING': {
        this._t += dt;
        const p = clamp(this._t / EXTEND_DUR, 0, 1);
        this._reach = this._reachMax * smooth(p); this._applyPose();
        if (p >= 1) {
          this.state = 'DOCKED'; this.pax.visible = true;
          if (!this._notified) { this.onEvent?.('door_connected', this._flightId); this._notified = true; }
        }
        break;
      }
      case 'DOCKED': {
        this._animatePax();
        const tl = occupant?.turnaroundLive;
        const remaining = tl ? (tl.totalSec - tl.t)
                             : (occupant ? occupant.turnaroundTime - occupant.stateTimer : -1);
        const leaving = !occupant || remaining <= (RETRACT_DUR + 0.5);
        if (leaving) {
          this.state = 'RETRACTING'; this._t = 0; this.pax.visible = false;
          this.onEvent?.('deboarding_complete', this._flightId);
        }
        break;
      }
      case 'RETRACTING': {
        this._t += dt;
        const p = clamp(this._t / RETRACT_DUR, 0, 1);
        this._reach = this._reachMax * smooth(1 - p); this._applyPose();
        if (p >= 1) { this._reach = 0; this._applyPose(); this.state = 'IDLE'; this._flightId = null; }
        break;
      }
    }
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse(o => { if (o.geometry) o.geometry.dispose(); });
  }
}

export class JetBridgeManager {
  constructor(scene) {
    this.scene = scene;
    this.bridges = new Map();   // gateId → JetBridge3D
    this._onEvent = null;
    this.rebuild();
  }

  /** (Re)build bridges from the current gate layout (only hasBridge gates). */
  rebuild() {
    for (const b of this.bridges.values()) b.dispose();
    this.bridges.clear();
    for (const g of getGates()) {
      if (g.hasBridge) {
        const b = new JetBridge3D(this.scene, g);
        b.onEvent = this._onEvent;
        this.bridges.set(g.id, b);
      }
    }
  }

  setOnEvent(cb) {
    this._onEvent = cb;
    for (const b of this.bridges.values()) b.onEvent = cb;
  }

  update(dt, api, aircraft3dMap) {
    for (const [gateId, br] of this.bridges) {
      let occ = null, ac3d = null;
      for (const f of api.getRawFlights()) {
        if (f.gateId === gateId && f.state === 'AT_GATE') { occ = f; break; }
      }
      if (occ) ac3d = aircraft3dMap.get(occ.id) ?? null;
      br.update(dt, occ, ac3d);
    }
  }
}
