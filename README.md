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
- **AMAN arrival manager** — inbound traffic is sequenced to each runway with an ETA, a RECAT-EU-style wake-turbulence separation minimum, and a Scheduled Time of Arrival; each aircraft absorbs its assigned delay by slowing on final (spacing arrivals on approach), shown on a vertical arrival-ladder HMI. Departures on a shared runway hold while an arrival occupies it (RIMCAS stays as the safety backstop). Modelled on EUROCONTROL AMAN / Heathrow Intelligent Approach.
- **A-CDM milestones** — each flight records the standard Airport Collaborative Decision Making timestamps (ATA → AIBT → TOBT → ARDT → TSAT → AOBT → ATOT), shown as a milestone strip in the gate detail view and driving an on-time-performance KPI. Turnaround durations vary with a realistic right-skewed delay distribution.
- **DMAN departure metering** — as in Eurocontrol A-CDM pre-departure sequencing and NASA ATD-2 surface metering, ready flights are held at the gate (engines off) instead of joining a long runway queue, then released one at a time with a TSAT start-up approval. A toggle turns metering on/off, and the analytics panel estimates fuel saved by the holds.
- **Turnaround Control wall** — an Assaia-/Schiphol-style operations wall with one card per occupied gate: a live 13-node progress strip, a predicted off-block time (POBT) countdown, and a POBT-vs-target (TOBT) risk chip, auto-sorted worst-first with an at-risk count. Click a card to zoom into that gate's detail view.
- **Rule-based stand allocation** — arriving aircraft are assigned a stand the way real resource-management systems (Amadeus F-RMS, INFORM GroundStar) do: a hard aircraft-size/stand-class constraint (wide-body → wide stand) plus a weighted score over the free compatible stands (jet-bridge contact preference, wide-stand conservation, taxi distance from the arrival runway). A **Stand Plan** Gantt shows every stand's class (contact/remote, wide) and a rolling in-block → off-block occupancy bar with a now-line; analytics tracks the contact-stand rate and stand-fit quality.
- **OOOI feed & ASPM stats** — the A-CDM milestones are reframed as the universal ACARS **OOOI** wire format (wheels **ON** → gate **IN** → gate **OUT** → wheels **OFF**) in a Zulu-timestamped ticker, and rolled up into an FAA **ASPM**-style per-runway taxi-out / taxi-in median-and-P90 table. The raw OOOI stream is included in the exported run-log JSON.
- **A-SMGCS runway safety net (RIMCAS)** — an Advanced-Surface-Movement Level-2 conflict monitor watches each shared runway and raises a two-stage alert (amber **CAUTION** → red **ALARM**) when a runway is occupied while another aircraft is rolling out or landing, with a flashing 3D runway overlay, a per-runway status panel, a conflict-free-time KPI, and a conflict log. It is advisory only — like the real safety net it alerts, it does not brake the aircraft.
- **Surface surveillance radar** — an ASDE-X / digital-tower-style top-down map of the movement area: every aircraft is a heading-rotated target with a leader-lined data block (callsign, type, gate/runway, groundspeed) and a fading track-history trail, and runway strips flash straight from the RIMCAS safety net.
- **Follow-the-Greens taxi guidance** — the A-SMGCS Guidance Service: a rolling carpet of green taxiway-centreline lights leads ahead of every taxiing aircraft along its route, with a red stop-bar dropped across the taxiway at any aircraft holding short of a runway. Toggleable. Modelled on ADB Safegate Follow-the-Greens.
- **Ground emissions & single-engine taxi** — a Scope-3 ground-emissions ledger sums per-type taxi-out/taxi-in fuel burn (ICAO Doc 9889 idle rates) into a taxi-CO₂ figure, and a single-engine-taxi toggle estimates the fuel and CO₂ that shutting one engine during taxi would save (with a both-engine warm-up allowance).
- **What-If console** — an APOC/TAM-style disruption sandbox: close a runway (its departures hold and arrivals reroute) or step the weather VMC → MVMC → IMC → LVP (each level widens runway separation, floors the arrival acceptance rate, and thickens the scene fog). A frozen-baseline delta strip shows how gate utilization, taxi-out and departure-wait move against the pre-disruption baseline.
- **Demand-Capacity forecast (DCB)** — the twin's forward-looking layer: it projects predicted movements (departures from POBT + taxi-out, arrivals from the AMAN sequence) into rolling per-runway time bins, compares them against each runway's declared capacity (bin ÷ effective separation), and flags red hotspots where demand will exceed capacity — so closing a runway or setting LVP in the What-If console makes a hotspot bloom in the forecast *before* the congestion arrives. Modelled on EUROCONTROL/SESAR DCB and the Airport Operations Plan.
- **Surface replay (RECALL)** — the run-logger's recorded snapshots become a rewind-and-scrub tool: a second surface radar plays back the airfield on an independent clock with play/pause, a timeline scrubber, adjustable speed, and prev/next-incident jumps, with an incident rail marking conflicts, closures and holds. Frames are interpolated between the 5-second snapshots. Modelled on Searidge RECALL / ASDE-X playback.
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

## About OPC Studio

This **airport digital twin / 机场数字孪生（数字机场）** is one of the projects from **[OPC Studio](https://opcstudio.cc/)** — an independent studio building AI-powered tools and interactive 3D experiences in the browser.

Explore more live projects:

- ✈️ **[AirportTwin · 机场数字孪生](https://opcstudio.cc/airport-twin/)** — this project (Boeing/Airbus, jet-bridge docking, A-CDM, runway sequencing)
- 🛗 **[ElevatorTwin · 电梯数字孪生](https://opcstudio.cc/elevator-twin/)** — elevator dispatch digital twin with AI scheduling
- 🏠 **[HouseTwin · 3D 住宅设计器](https://opcstudio.cc/house-twin/)** — parametric 3D home & interior designer
- ♟ **[BattleAI](https://opcstudio.cc/battleai/)** — watch LLMs battle in chess, xiangqi, gomoku and tetris
- 🌐 **All projects → [opcstudio.cc](https://opcstudio.cc/)**

## License

MIT
