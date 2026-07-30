/**
 * ViewDirector — digital-tower camera presets (remote/virtual tower style).
 *
 * Remote and digital towers (Saab r-TWR, Frequentis smartVISION; London City
 * runs one) replace the out-the-window view with camera arrays and let the
 * controller jump between standardised viewpoints — tower cab, apron, approach
 * — plus PTZ target-tracking of an individual aircraft. This module brings the
 * same view grammar to the twin: named presets with smooth eased transitions,
 * and a FOLLOW mode that tracks a live flight until it leaves the picture.
 *
 * Pose math is pure and exported (viewPose) so the smoke test can assert it
 * headlessly; the director itself only nudges camera.position/controls.target,
 * so manual orbiting keeps working — any drag simply takes over from the
 * preset (the eased pull stops once the transition completes).
 */

// Preset poses. The tower cab sits at (58, 21, 28) in airport3d.js.
const POSES = {
  overview: { pos: [0, 88, 80],     tgt: [0, 0, -8] },
  tower:    { pos: [58, 22, 26],    tgt: [-10, 1, -30] },
  apron:    { pos: [0, 26, 44],     tgt: [0, 1, 8] },
  approach: { pos: [-150, 22, -33], tgt: [-40, 5, -30] },
};

/** Pure pose for a named view; `flight` (snapshot entry) drives FOLLOW. */
export function viewPose(name, flight = null) {
  if (name === 'follow' && flight) {
    const p = flight.position;
    // Chase position: behind-left and above, scaled up with altitude so the
    // frame widens as the aircraft climbs.
    const lift = 6 + p.y * 0.6;
    return { pos: [p.x - 14, p.y + lift, p.z + 16], tgt: [p.x, p.y, p.z] };
  }
  const v = POSES[name] || POSES.overview;
  return { pos: [...v.pos], tgt: [...v.tgt] };
}

export const VIEW_NAMES = ['overview', 'tower', 'apron', 'approach', 'follow'];

export class ViewDirector {
  constructor(camera, controls, pickFollowFlight) {
    this._cam = camera;
    this._controls = controls;
    this._pick = pickFollowFlight;    // () => snapshot flight | null
    this._mode = 'free';              // free | transition | follow
    this._view = null;
    this._pose = null;
    this._onChange = null;
    // A manual drag cancels any in-flight transition (follow keeps tracking).
    controls.addEventListener('start', () => {
      if (this._mode === 'transition') { this._mode = 'free'; this._setView(null); }
    });
  }

  onChange(cb) { this._onChange = cb; }
  get view() { return this._view; }

  go(name) {
    if (name === 'follow') {
      const f = this._pick();
      if (!f) return false;           // nothing to track — stay put
      this._mode = 'follow';
      this._setView('follow');
      return true;
    }
    this._pose = viewPose(name);
    this._mode = 'transition';
    this._setView(name);
    return true;
  }

  _setView(v) {
    this._view = v;
    if (this._onChange) this._onChange(v);
  }

  /** Ease toward the active pose; call once per render frame. */
  update(frameDt) {
    if (this._mode === 'free') return;
    let pose = this._pose;
    if (this._mode === 'follow') {
      const f = this._pick();
      if (!f) { this._mode = 'transition'; this._pose = viewPose('overview'); this._setView('overview'); return; }
      pose = viewPose('follow', f);
    }
    if (!pose) return;
    const k = 1 - Math.exp(-4 * Math.min(frameDt, 0.1));
    const c = this._cam.position, t = this._controls.target;
    c.x += (pose.pos[0] - c.x) * k; c.y += (pose.pos[1] - c.y) * k; c.z += (pose.pos[2] - c.z) * k;
    t.x += (pose.tgt[0] - t.x) * k; t.y += (pose.tgt[1] - t.y) * k; t.z += (pose.tgt[2] - t.z) * k;
    this._controls.update();
    // Transition finished → hand control back to the user.
    if (this._mode === 'transition' &&
        Math.hypot(pose.pos[0] - c.x, pose.pos[1] - c.y, pose.pos[2] - c.z) < 0.15) {
      this._mode = 'free';
    }
  }
}
