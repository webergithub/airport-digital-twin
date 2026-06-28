/**
 * Three.js scene bootstrap — renderer, camera, lighting, OrbitControls, CSS2DRenderer.
 * Optimised for top-down airport overview (isometric-ish perspective).
 */

import * as THREE from 'three';
import { OrbitControls }  from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer }  from 'three/addons/renderers/CSS2DRenderer.js';

export function createScene(container) {
  // ── Renderer ──────────────────────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
  renderer.toneMapping       = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  container.appendChild(renderer.domElement);

  // CSS2D label overlay
  const labelRenderer = new CSS2DRenderer();
  labelRenderer.setSize(container.clientWidth, container.clientHeight);
  labelRenderer.domElement.style.position = 'absolute';
  labelRenderer.domElement.style.top      = '0';
  labelRenderer.domElement.style.left     = '0';
  labelRenderer.domElement.style.pointerEvents = 'none';
  container.appendChild(labelRenderer.domElement);

  // ── Scene ──────────────────────────────────────────────────────────────────
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x040c18);
  scene.fog = new THREE.FogExp2(0x040c18, 0.006);

  // ── Camera ─────────────────────────────────────────────────────────────────
  const aspect = container.clientWidth / container.clientHeight;
  const camera = new THREE.PerspectiveCamera(42, aspect, 0.5, 600);
  camera.position.set(0, 88, 80);
  camera.lookAt(0, 0, -8);

  // ── Lighting ───────────────────────────────────────────────────────────────
  // Ambient — deep blue night sky base
  scene.add(new THREE.AmbientLight(0x1a3060, 3.0));

  // Key light — warm dusk sun from west
  const sun = new THREE.DirectionalLight(0xffcc88, 2.8);
  sun.position.set(-60, 50, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.camera.near   = 1;
  sun.shadow.camera.far    = 200;
  sun.shadow.camera.left   = sun.shadow.camera.bottom = -90;
  sun.shadow.camera.right  = sun.shadow.camera.top    =  90;
  scene.add(sun);

  // Fill light — cool blue from east
  const fill = new THREE.DirectionalLight(0x4488cc, 0.8);
  fill.position.set(40, 30, -20);
  scene.add(fill);

  // Ground bounce — very subtle warm
  const bounce = new THREE.DirectionalLight(0xddaa66, 0.25);
  bounce.position.set(0, -1, 0);
  scene.add(bounce);

  // ── Ground plane (grass) ────────────────────────────────────────────────────
  const groundGeo = new THREE.PlaneGeometry(400, 400);
  const groundMat = new THREE.MeshLambertMaterial({ color: 0x0a1a0c });
  const ground    = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x  = -Math.PI / 2;
  ground.position.y  = -0.05;
  ground.receiveShadow = true;
  scene.add(ground);

  // ── OrbitControls ──────────────────────────────────────────────────────────
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, -8);
  controls.enableDamping  = true;
  controls.dampingFactor  = 0.08;
  controls.minDistance    = 15;
  controls.maxDistance    = 220;
  controls.maxPolarAngle  = Math.PI / 2 + 0.05;
  controls.update();

  // ── Resize handler ─────────────────────────────────────────────────────────
  window.addEventListener('resize', () => {
    const w = container.clientWidth, h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    labelRenderer.setSize(w, h);
  });

  return { scene, camera, renderer, labelRenderer, controls };
}
