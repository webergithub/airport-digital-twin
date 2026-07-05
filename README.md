# Airport Digital Twin · 机场数字孪生

A browser-based **airport ground-operations digital twin** built with Three.js (ES modules, no build step). Aircraft fly real approach/departure profiles, dock to animated jet bridges, run a full 13-node ground-handling turnaround with service vehicles, and queue for the runway one at a time — while an analytics layer continuously optimizes the operation.

🌐 **Live demo:** https://opcstudio.cc/airport-twin/

<br>

## Features

- **Realistic procedural aircraft** — Boeing/Airbus-style narrow- and wide-body models (tapered lathe fuselage, swept wings with winglets/sharklets/raked tips), with real takeoff/landing speed and altitude profiles (rotate, climb-out, descent, flare) and nose-up/down pitch.
- **Ground handling** — clickable numbered gates zoom into a per-gate detail view that choreographs the full turnaround: chocks → bridge → deplane → unload → catering → water → lavatory → garbage → refuel → load → board → chocks off → pushback tug. Each node records start/end timestamps.
- **Jet bridges** — animated docking to the forward door and retraction before pushback.
- **Pushback with tug** — aircraft are pushed back tail-first by a tug (no in-place turning).
- **Runway sequencing** — departures hold-short on the taxiway and line up without overlapping; only one aircraft is on the runway at a time.
- **A-CDM milestones** — each flight records the standard Airport Collaborative Decision Making timestamps (ATA → AIBT → TOBT → ARDT → TSAT → AOBT → ATOT), shown as a milestone strip in the gate detail view and driving an on-time-performance KPI. Turnaround durations vary with a realistic right-skewed delay distribution.
- **DMAN departure metering** — as in Eurocontrol A-CDM pre-departure sequencing and NASA ATD-2 surface metering, ready flights are held at the gate (engines off) instead of joining a long runway queue, then released one at a time with a TSAT start-up approval. A toggle turns metering on/off, and the analytics panel estimates fuel saved by the holds.
- **Movable UI** — every panel can be dragged, minimized to a title bar, and resized.
- **Bilingual** — full 中文 / English toggle.

## Three-layer architecture

| Layer | Folder | Responsibility |
|-------|--------|----------------|
| **UI 层** | `simulation/` | 3D twin rendering + panels; consumes the data layer's standard JSON snapshot via the API. |
| **模拟输入数据层** | `control/` | Simulates aircraft positions / speeds / altitudes and the ground-handling process; exposes everything through `AirportAPI` and `getSnapshot()` (a standard JSON data contract). |
| **数据算法层** | `optimization/` | `AnalyticsEngine` ingests the snapshot stream, derives metrics, and continuously optimizes parameters; `RunLogger` records all running data (events + snapshots + turnaround timelines) and exports JSON. |

The standard data interface (`api.getSnapshot()`) returns a serializable snapshot of every flight (position, speed in m/s, altitude, heading, turnaround), gates, runways and stats — also exposed at `window.__snapshot` for external consumers.

## Run locally

It's a static, build-free ES-module app. Serve the folder with any static server:

```bash
# included no-cache dev server (Python 3)
python3 .devserver.py 5181
# then open http://localhost:5181/
```

Three.js is loaded from a CDN via an import map, so no `npm install` is required.

## Project layout

```
index.html              # entry (OPC Studio nav bar + canvas + UI root)
simulation/             # UI layer — scene, airport3d, aircraft3d, jetbridge3d,
                        #   service-vehicles, gate-interaction, ui-overlay,
                        #   window-manager, i18n, main
control/                # data layer — airport-api, flight-manager, gate-layout,
                        #   gate-manager, turnaround-plan, runway-controller
optimization/           # algorithm layer — scheduler, analytics, run-logger
```

## License

MIT
