/**
 * ServiceVehicles — procedural ground-handling vehicles for ONE focused gate.
 *
 * Created on gate focus, disposed on exit. Reads the live TurnaroundPlan node
 * array each frame: when a node becomes active its vehicle drives in from an
 * apron edge to a side-relative working position, works during the node, then
 * drives off when the node completes.
 *
 * Jet bridges are NOT built here — jetbridge3d.js owns all bridge animation, so
 * the BRIDGE / DEPLANE / BOARD nodes (vehicle 'bridge' / 'none') are skipped.
 *
 * Aircraft parks at gate center (gx, 0, 12) with nose toward −Z, so in world
 * axes: right (starboard) = +X, left (port) = −X, tail = +Z.
 */

import * as THREE from 'three';

const matDark  = new THREE.MeshPhongMaterial({ color: 0x2a2a32, shininess: 20 });
const matWheel = new THREE.MeshLambertMaterial({ color: 0x111114 });
const body = c => new THREE.MeshPhongMaterial({ color: c, shininess: 30 });

export class ServiceVehicles {
  constructor(scene, gateDef) {
    this.scene = scene;
    this.gate  = gateDef;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.vehicles = new Map();   // nodeId → { mesh, state, from, to, t, dur, node, work }
  }

  update(nodes, dt) {
    if (nodes) { for (const n of nodes) this._syncNode(n); }
    else       { this._retireAll(); }
    this._tickAnims(dt);
  }

  // ── Side → (enter, work) positions ──────────────────────────────────────────
  // Parked aircraft faces +Z (nose toward terminal at z≈15.5, tail toward apron
  // at z≈8.5, center z=12). Vehicles ring the fuselage on the apron/flank side;
  // all working spots stay south of the terminal footprint (z ≤ 16).
  _path(node) {
    const gx = this.gate.x;
    // Wings span z≈11.5–13 (root) out to gx±3.9, sitting low (y≈0.45). Keep
    // vehicles in the clear zones — FORWARD of the wing (near the nose doors,
    // z≥14) or AFT of it (z≤10) — and laterally clear of the fuselage.
    const S = {
      nose:   { work: new THREE.Vector3(gx,       0, 14.9), enter: new THREE.Vector3(gx + 9,  0, 16.5) }, // nose gear (+Z)
      fwdR:   { work: new THREE.Vector3(gx + 2.6, 0, 14.2), enter: new THREE.Vector3(gx + 11, 0, 14.5) }, // fwd-right door (fwd of wing)
      aftR:   { work: new THREE.Vector3(gx + 2.6, 0, 9.3),  enter: new THREE.Vector3(gx + 11, 0, 8)    }, // aft-right cargo (aft of wing)
      aftL:   { work: new THREE.Vector3(gx - 2.6, 0, 9.3),  enter: new THREE.Vector3(gx - 11, 0, 8)    }, // aft-left
      underL: { work: new THREE.Vector3(gx - 2.8, 0, 10.4), enter: new THREE.Vector3(gx - 11, 0, 10.4) }, // fuel, fwd of left wing root
    };
    const e = S[node.side] ?? S.nose;
    const work = e.work.clone(), enter = e.enter.clone();
    if (node.id === 'GARBAGE') work.x += 1.7;  // sit beside catering (both fwdR)
    if (node.id === 'LAV')     work.z -= 1.1;  // separate from water (both aftL)
    return [enter, work];
  }

  _syncNode(n) {
    if (n.vehicle === 'none' || n.vehicle === 'bridge') return;
    let v = this.vehicles.get(n.id);

    if (n.active && !v) {
      const mesh = this._build(n.vehicle);
      const [enter, work] = this._path(n);
      this.group.add(mesh);
      if (n.vehicle === 'chocks') {
        mesh.position.copy(work);
        v = { mesh, state: 'WORKING', node: n, work };
      } else if (n.progress > 0.2) {
        // Joined mid-node — snap to working position.
        mesh.position.copy(work);
        mesh.rotation.y = Math.atan2(-(work.x - enter.x), -(work.z - enter.z));
        v = { mesh, state: 'WORKING', node: n, work };
      } else {
        mesh.position.copy(enter);
        v = { mesh, state: 'DRIVING_IN', from: enter, to: work, t: 0, dur: 2.5, node: n, work };
      }
      this.vehicles.set(n.id, v);
    }

    if (v && n.done && (v.state === 'WORKING' || v.state === 'DRIVING_IN')) {
      const [enter] = this._path(n);
      v.state = 'DRIVING_OUT'; v.from = v.mesh.position.clone(); v.to = enter; v.t = 0; v.dur = 2.5;
    }
  }

  _retireAll() {
    for (const v of this.vehicles.values()) {
      if (v.state === 'WORKING' || v.state === 'DRIVING_IN') {
        const [enter] = this._path(v.node);
        v.state = 'DRIVING_OUT'; v.from = v.mesh.position.clone(); v.to = enter; v.t = 0; v.dur = 2.0;
      }
    }
  }

  _tickAnims(dt) {
    for (const [id, v] of this.vehicles) {
      if (v.state === 'DRIVING_IN' || v.state === 'DRIVING_OUT') {
        v.t = Math.min(1, v.t + dt / v.dur);
        v.mesh.position.lerpVectors(v.from, v.to, v.t);
        const dx = v.to.x - v.from.x, dz = v.to.z - v.from.z;
        if (dx * dx + dz * dz > 1e-4) v.mesh.rotation.y = Math.atan2(-dx, -dz);
        if (v.t >= 1) {
          if (v.state === 'DRIVING_IN') v.state = 'WORKING';
          else { this.group.remove(v.mesh); this._disposeMesh(v.mesh); this.vehicles.delete(id); }
        }
      } else if (v.state === 'WORKING') {
        const lift = v.mesh.userData.lift;
        if (lift) lift.position.y = Math.min(v.mesh.userData.liftMax ?? 1.6, lift.position.y + dt * 0.9);
      }
    }
  }

  // ── Vehicle builders ─────────────────────────────────────────────────────────
  _wheels(g, xs, zs, r = 0.26) {
    for (const x of xs) for (const z of zs) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.16, 10), matWheel);
      w.rotation.z = Math.PI / 2; w.position.set(x, r, z); g.add(w);
    }
  }

  _build(type) {
    switch (type) {
      case 'chocks':   return this._buildChocks();
      case 'baggage':  return this._buildBaggageTrain();
      case 'catering': return this._buildCateringTruck();
      case 'water':    return this._buildBoxTruck(0x1abc9c);
      case 'lavatory': return this._buildBoxTruck(0x8a6d3b);
      case 'garbage':  return this._buildBoxTruck(0x7f8c8d, 0.85);
      case 'fuel':     return this._buildFuelTruck();
      case 'tug':      return this._buildTug();
      default:         return this._buildBoxTruck(0x888888);
    }
  }

  _buildBoxTruck(color, scale = 1) {
    const g = new THREE.Group();
    const b = new THREE.Mesh(new THREE.BoxGeometry(1.0 * scale, 1.1 * scale, 1.6 * scale), body(color));
    b.position.set(0, 0.75 * scale, 0.25); b.castShadow = true; g.add(b);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(0.9 * scale, 0.8 * scale, 0.8), matDark);
    cab.position.set(0, 0.55 * scale, -0.9 * scale); g.add(cab);
    this._wheels(g, [-0.5 * scale, 0.5 * scale], [-0.7, 0.7]);
    return g;
  }

  _buildCateringTruck() {
    const g = new THREE.Group();
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.6, 2.4), body(0xd0d0d0));
    chassis.position.y = 0.5; g.add(chassis);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.7, 0.7), matDark);
    cab.position.set(0, 0.6, -1.0); g.add(cab);
    const lift = new THREE.Group();
    const box = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.1, 1.6), body(0xf39c12));
    box.position.y = 0.55; box.castShadow = true; lift.add(box);
    lift.position.set(0, 0.8, 0.3); g.add(lift);
    g.userData.lift = lift; g.userData.liftMax = 1.7;
    this._wheels(g, [-0.5, 0.5], [-0.9, 0.9]);
    return g;
  }

  _buildBaggageTrain() {
    const g = new THREE.Group();
    const cab = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.6, 1.1), body(0xe67e22));
    cab.position.set(0, 0.5, -0.6); g.add(cab);
    this._wheels(g, [-0.32, 0.32], [-0.9, -0.2], 0.2);
    for (let i = 0; i < 3; i++) {
      const z = 0.6 + i * 1.25;
      const bed = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.4, 1.0), body(0xb0b0b0));
      bed.position.set(0, 0.4, z); g.add(bed);
      const can = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.05, 1.05), matDark);
      can.position.set(0, 0.85, z); g.add(can);
      this._wheels(g, [-0.32, 0.32], [z - 0.3, z + 0.3], 0.16);
    }
    return g;
  }

  _buildFuelTruck() {
    const g = new THREE.Group();
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.3, 3.0), matDark);
    chassis.position.y = 0.32; g.add(chassis);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 1.0), body(0xc0392b));
    cab.position.set(0, 0.7, -1.2); g.add(cab);
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 2.0, 16), body(0xe74c3c));
    tank.rotation.x = Math.PI / 2; tank.position.set(0, 0.75, 0.4); tank.castShadow = true; g.add(tank);
    this._wheels(g, [-0.5, 0.5], [-1.0, 0, 1.0]);
    return g;
  }

  _buildTug() {
    const g = new THREE.Group();
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.4, 1.4), body(0xf1c40f));
    b.position.y = 0.4; g.add(b);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.4, 0.6), matDark);
    cab.position.set(0, 0.7, 0.2); g.add(cab);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 1.0), matDark);
    bar.position.set(0, 0.3, -0.9); g.add(bar);   // tow bar toward the nose
    this._wheels(g, [-0.32, 0.32], [-0.5, 0.5], 0.2);
    return g;
  }

  _buildChocks() {
    const g = new THREE.Group();
    const m = body(0x1a1a1a);
    for (const z of [-0.3, 0.3]) {
      const c = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.4), m);
      c.position.set(0, 0.15, z); g.add(c);
    }
    return g;
  }

  _disposeMesh(mesh) {
    mesh.traverse(o => { if (o.geometry) o.geometry.dispose(); });
  }

  dispose() {
    this.scene.remove(this.group);
    for (const v of this.vehicles.values()) this._disposeMesh(v.mesh);
    this.vehicles.clear();
  }
}
