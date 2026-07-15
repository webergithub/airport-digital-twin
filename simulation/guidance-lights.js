/**
 * TaxiGuidance — A-SMGCS Guidance Service ("Follow-the-Greens").
 *
 * Real A-SMGCS Level-3/4 guidance (ADB Safegate Follow-the-Greens at Beijing
 * Daxing, Heathrow, Dubai; EUROCONTROL A-SMGCS Spec v2.0 Guidance Service)
 * lights the green taxiway-centreline segments ahead of each aircraft along its
 * assigned route and shows a red stop-bar at the next hold point, switching the
 * bar to green (route lit onward) when the aircraft is cleared. This mirror
 * lights a rolling green carpet ahead of every taxiing aircraft and drops a red
 * stop-bar at any aircraft holding short of a runway.
 *
 * Purely presentational: it reads the live flight objects' ground routes and
 * drives two InstancedMeshes; it never alters control logic.
 */

import * as THREE from 'three';

const GROUND_STATES = new Set(['TAXIING_IN', 'PUSHBACK', 'TAXIING_OUT', 'HOLDING']);
const STEP    = 2.6;    // spacing between green centreline lights (world units)
const MAX_LEN = 64;     // max carpet length lit ahead of each aircraft
const DOTS    = 340;    // green-light instance pool
const BARS    = 16;     // red stop-bar instance pool

export class TaxiGuidance {
  constructor(scene) {
    this.enabled = true;

    const dotGeo = new THREE.CircleGeometry(0.36, 10);
    dotGeo.rotateX(-Math.PI / 2);                     // lay flat on the ground
    this.dots = new THREE.InstancedMesh(dotGeo, new THREE.MeshBasicMaterial({ color: 0x2bff5a }), DOTS);
    this.dots.frustumCulled = false;
    scene.add(this.dots);

    this.bars = new THREE.InstancedMesh(
      new THREE.BoxGeometry(4.2, 0.14, 0.5),
      new THREE.MeshBasicMaterial({ color: 0xff2a1a }), BARS);
    this.bars.frustumCulled = false;
    scene.add(this.bars);

    this._d = new THREE.Object3D();
    this._active = 0; this._holds = 0;
    this._hideFrom(this.dots, 0); this._hideFrom(this.bars, 0);
    this.dots.instanceMatrix.needsUpdate = true; this.bars.instanceMatrix.needsUpdate = true;
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!on) {
      this._hideFrom(this.dots, 0); this._hideFrom(this.bars, 0);
      this.dots.instanceMatrix.needsUpdate = true; this.bars.instanceMatrix.needsUpdate = true;
      this._active = 0; this._holds = 0;
    }
  }

  _hideFrom(mesh, from) {
    const d = this._d;
    d.position.set(0, -999, 0); d.rotation.set(0, 0, 0); d.scale.setScalar(0); d.updateMatrix();
    for (let i = from; i < mesh.count; i++) mesh.setMatrixAt(i, d.matrix);
  }

  /** Called each render frame with the control API (reads live flight objects). */
  update(api) {
    if (!this.enabled) return;
    const d = this._d;
    let di = 0, bi = 0, active = 0;

    for (const f of api.getRawFlights()) {
      if (!GROUND_STATES.has(f.state) || (f.y || 0) > 2) continue;
      let guided = false;
      const route = f.getGroundRoute();

      // Green carpet: walk the polyline, a light every STEP up to MAX_LEN ahead.
      if (route.length >= 2) {
        guided = true;
        let acc = 0, carried = 0;
        for (let k = 1; k < route.length && acc < MAX_LEN; k++) {
          const a = route[k - 1], b = route[k];
          const segLen = Math.hypot(b.x - a.x, b.z - a.z);
          if (segLen < 1e-3) continue;
          const ux = (b.x - a.x) / segLen, uz = (b.z - a.z) / segLen;
          let t = carried;
          while (t < segLen && acc < MAX_LEN && di < DOTS) {
            d.position.set(a.x + ux * t, 0.16, a.z + uz * t);
            d.rotation.set(0, 0, 0); d.scale.setScalar(1); d.updateMatrix();
            this.dots.setMatrixAt(di++, d.matrix);
            t += STEP; acc += STEP;
          }
          carried = t - segLen;
        }
      }

      // Red stop-bar across the taxiway at an aircraft holding short of the
      // runway. Independent of route length (a holding flight's ground route is
      // just its current point — the runway ahead is deliberately excluded).
      if (f.state === 'HOLDING' && bi < BARS) {
        guided = true;
        const dir = f.getDirection();
        d.position.set(f.x, 0.15, f.z);
        d.rotation.set(0, Math.atan2(dir.z, dir.x) + Math.PI / 2, 0);   // span perpendicular to travel
        d.scale.setScalar(1); d.updateMatrix();
        this.bars.setMatrixAt(bi++, d.matrix);
      }

      if (guided) active++;
    }

    this._hideFrom(this.dots, di); this._hideFrom(this.bars, bi);
    this.dots.instanceMatrix.needsUpdate = true;
    this.bars.instanceMatrix.needsUpdate = true;
    this._active = active; this._holds = bi;
  }

  getStatus() { return { active: this._active, holds: this._holds, enabled: this.enabled }; }
}
