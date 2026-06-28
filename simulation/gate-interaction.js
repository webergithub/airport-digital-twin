/**
 * GateInteraction — click a gate to fly the camera into a 3/4 detail view of it;
 * exit returns to the overview. Raycasts against the apron ground markers
 * (CSS2D labels can't be picked). Includes a drag-vs-click guard so OrbitControls
 * drags don't mis-trigger a focus.
 */

import * as THREE from 'three';

const easeInOutCubic = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class GateInteraction {
  constructor({ camera, controls, renderer, getGateMarkers, gateDefs, onFocus, onExit }) {
    this.camera = camera;
    this.controls = controls;
    this.renderer = renderer;
    this.getGateMarkers = getGateMarkers;     // () => Mesh[]
    this.gateDefs = gateDefs;                 // () => gate[] or array
    this.onFocus = onFocus;
    this.onExit = onExit;

    this.focusedGateId = null;
    this.anim = null;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();

    this.overviewPos = camera.position.clone();
    this.overviewTgt = controls.target.clone();

    this._downX = 0; this._downY = 0; this._downT = 0;
    const el = renderer.domElement;
    el.addEventListener('pointerdown', e => {
      this._downX = e.clientX; this._downY = e.clientY; this._downT = performance.now();
    });
    el.addEventListener('pointerup', e => this._onPointerUp(e));
  }

  _gates() { return typeof this.gateDefs === 'function' ? this.gateDefs() : this.gateDefs; }

  _onPointerUp(e) {
    const moved = Math.hypot(e.clientX - this._downX, e.clientY - this._downY);
    if (moved > 6 || (performance.now() - this._downT) > 300) return;  // was a drag
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.getGateMarkers(), false);
    if (hits.length) this.focusGate(hits[0].object.userData.gateId);
  }

  focusGate(id) {
    const g = this._gates().find(d => d.id === id);
    if (!g) return;
    // Elevated 3/4 view from the APRON side (south, z<gate) looking north at the
    // gate, so the terminal (north of the gate) never occludes, and the camera
    // clears the front service trucks to frame the aircraft + its vehicle ring.
    const toTgt = new THREE.Vector3(g.x, 1.0, 12);
    const toPos = new THREE.Vector3(THREE.MathUtils.clamp(g.x + 8, -44, 44), 12, -1);
    this.focusedGateId = id;
    this.startAnim(this.camera.position.clone(), toPos, this.controls.target.clone(), toTgt, 1.2, null);
    this.onFocus?.(id);
  }

  exitFocus() {
    if (!this.focusedGateId && !this.anim) return;
    this.focusedGateId = null;
    this.startAnim(
      this.camera.position.clone(), this.overviewPos.clone(),
      this.controls.target.clone(), this.overviewTgt.clone(), 1.0,
      () => { this.controls.enabled = true; });
    this.onExit?.();
  }

  startAnim(fromPos, toPos, fromTgt, toTgt, dur, onDone) {
    this.anim = { fromPos, toPos, fromTgt, toTgt, t: 0, dur, onDone };
    this.controls.enabled = false;
  }

  update(dt) {
    if (!this.anim) return;
    const a = this.anim;
    a.t = Math.min(1, a.t + dt / a.dur);
    const e = easeInOutCubic(a.t);
    this.camera.position.lerpVectors(a.fromPos, a.toPos, e);
    this.controls.target.lerpVectors(a.fromTgt, a.toTgt, e);
    this.controls.update();
    if (a.t >= 1) {
      const done = a.onDone;
      this.anim = null;
      if (this.focusedGateId) this.controls.enabled = true;  // allow orbit while focused
      done && done();
    }
  }
}
