/**
 * Gate Layout — single source of truth for gate positions & bridge equipping.
 *
 * Replaces the old hard-coded GATES (gate-manager.js) and GATE_DEFS (airport3d.js).
 * Every layer (control + simulation) consumes getGates(); reconfiguration goes
 * through setGates(). Gate shape is LOCKED to:
 *   { id, x, z:12, terminal:'A'|'B', hasBridge:boolean, wide:boolean }
 * hasBridge = contact stand (jet bridge) vs remote/stairs stand.
 * wide      = wide-body-capable stand (can accept LARGE aircraft).
 */

export const GATE_Z       = 12;
export const MIN_GATES     = 4;
export const MAX_GATES     = 12;

// Apron spans x∈[-36,36]; keep gates inside with a central gap (terminal doors).
const A_RANGE = [-34, -8];
const B_RANGE = [  8, 34];

/**
 * Build an evenly-spaced gate layout split across concourse A (west) and B (east).
 * Bridges are assigned to the `bridgeCount` gates nearest the terminal centerline
 * (smallest |x|); the rest are remote/stairs stands.
 */
export function buildGateLayout(gateCount = 6, bridgeCount = 6) {
  const gc = Math.max(MIN_GATES, Math.min(MAX_GATES, Math.round(gateCount)));
  const bc = Math.max(0, Math.min(gc, Math.round(bridgeCount)));

  const countA = Math.ceil(gc / 2);
  const countB = gc - countA;
  const gates  = [];

  const spread = (n, [x0, x1], term) => {
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      const x = x0 + (x1 - x0) * t;
      gates.push({ id: `${term}${i + 1}`, x: +x.toFixed(2), z: GATE_Z, terminal: term, hasBridge: false, wide: false });
    }
  };
  spread(countA, A_RANGE, 'A');
  spread(countB, B_RANGE, 'B');

  // Equip the bc gates closest to the terminal centerline with jet bridges.
  [...gates].sort((a, b) => Math.abs(a.x) - Math.abs(b.x))
            .slice(0, bc)
            .forEach(g => { g.hasBridge = true; });

  // Designate the most-central ~1/3 of stands as wide-body-capable (larger
  // aprons near the terminal core). Independent of bridges so wide stands
  // exist even with bridgeCount 0.
  const wc = Math.max(1, Math.round(gc / 3));
  [...gates].sort((a, b) => Math.abs(a.x) - Math.abs(b.x))
            .slice(0, wc)
            .forEach(g => { g.wide = true; });

  return gates;
}

// ── Live, mutable layout (the single source of truth) ──────────────────────────
// Default: 6 stands, 4 with jet bridges (contact) + 2 remote/stairs stands —
// a realistic contact/remote mix that exercises the stand allocator.
let _gates = buildGateLayout(6, 4);

export function getGates() { return _gates; }

export function setGates(arr) { _gates = arr; }

export function getGateConfig() {
  return {
    gateCount:   _gates.length,
    bridgeCount: _gates.filter(g => g.hasBridge).length,
  };
}

export function getGateDef(id) { return _gates.find(g => g.id === id) ?? null; }
