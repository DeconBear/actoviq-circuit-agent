# GUI Project Canvas Contract

When the Actoviq desktop GUI is open, treat the active workspace as the
handoff boundary between the coding agent and the visual app.

## Workspace location (do this first)

The GUI and `circuit_project.py` share
`~/.actoviq/actoviq-circuit-agent-workspaces.json`. The default workspace root
is `<repo>/workspace/workspaces/default/` with projects under `projects/`.

**Never** create projects under bare `<repo>/workspace/projects/` — the GUI
will not list them.

```bash
python scripts/circuit_project.py workspace-active
python scripts/circuit_project.py workspace-list
python scripts/circuit_project.py workspace-use --workspace-id default
python scripts/circuit_project.py workspace-resolve-projects-root
```

`create` / `create-demo` omit `--projects-root` to use the active workspace
`projectsDir`. Optional overrides:

- `--workspace-id <id>` — write into that workspace without changing active
- `--projects-root <path>` — explicit projects directory
- `ACTOVIQ_CIRCUIT_AGENT_WORKSPACE_ROOT` — env override of the workspace root

## Project contract

- Create or use a project under `<active-workspace>/projects/<project-id>/`.
- Set `project_kind` on create (`simulation` | `pcb_schematic` | `analog_ic`).
  Missing legacy values migrate to `simulation`; explicit unknown values fail
  closed. Kind gates validation, Agent `next_action`, handoff, and LCSC availability.
- Put user-provided reference files under `<active-workspace>/references/`.
- Structured reusable assets live in `<active-workspace>/references/catalog/`
  (`actoviq.reference-asset.v1`): circuit modules/projects, schematic layout
  snapshots, layout idioms, and layout visuals. See
  [user-reference-assets.md](user-reference-assets.md).
- If OCR text exists, read it from `<active-workspace>/references/.ocr/`.
- Treat `project.circuit.json` and each `modules/<id>/module.circuit.json` as
  the only editable source of truth. Persist `stable_id` on objects for EDA
  round-trip (`ACTOVIQ_ID` in peer tools).
- Use `scripts/circuit_project.py` for deterministic creation, modification,
  revision, compilation, simulation, Bridge, and LCSC bind. Do not edit
  generated files under `build/`.
- For `pcb_schematic`, use stable-ID KiCad handoff or the experimental,
  vendor-unverified JLCEDA exchange plus LCSC binding; peer connectivity
  reconstruction is not yet lossless. For `analog_ic`, run the PDK
  audit/simulation loop and use the Virtuoso SPICE/CDL package. See
  [eda-bridge-lcsc.md](eda-bridge-lcsc.md) and [analog-ic-design.md](analog-ic-design.md).
- The GUI watches project files and refreshes the corresponding canvas after
  a successful atomic write.
- Default topology for multi-stage designs is hierarchical modules on the
  project canvas; see [modular-project-design.md](modular-project-design.md).
  Read stage schematics one module at a time rather than one dense sheet.

Create a project:

```bash
python scripts/circuit_project.py create \
  --name "<project name>"
```

Or pin a workspace explicitly:

```bash
python scripts/circuit_project.py create \
  --workspace-id default \
  --name "<project name>"
```

Create the three-module power/amplifier/filter example:

```bash
python scripts/circuit_project.py create-demo \
  --name "<project name>"
```

Inspect before modifying:

```bash
python scripts/circuit_project.py summary \
  --project-root <projectsDir>/<project-id>
python scripts/circuit_project.py agent-context \
  --project-root <projectsDir>/<project-id>
python scripts/circuit_project.py erc \
  --project-root <projectsDir>/<project-id>
```

Apply a structured command:

```bash
python scripts/circuit_project.py apply \
  --project-root <projectsDir>/<project-id> \
  --command-file <command.json>
```

Compile or simulate:

```bash
python scripts/circuit_project.py compile --project-root <project-root>
python scripts/circuit_project.py simulate --project-root <project-root>
python scripts/circuit_project.py compile-module --project-root <project-root> --module-id <id>
python scripts/circuit_project.py simulate-module --project-root <project-root> --module-id <id>
```

Every command must use the current `base_revision`. A stale command must be
rejected, not silently rebased. Supported initial operations are
`move_module`, `resize_module`, `set_component_value`, `move_component`,
`set_module_schematic`, `move_schematic_item`, `reset_schematic_item`, `connect_ports`,
`set_connection_network`, and `connect_pins`. Agents can construct larger designs with `upsert_module`,
`remove_module`, `add_port`, `add_component`, and `remove_component`.
Use `set_module_note`, `set_module_preview`, and `set_module_metadata` for the
GUI card note, preview preference, name, kind, function summary, and parameter
summary. Keep the stable module `id` unchanged when editing metadata.

Agents may create schematic-only functional blocks with `add_component` and
`type: "BLOCK"`. A block accepts any non-empty `pins` array; each pin has a
stable `id`, visible `name`, electrical `net`, and optional `side`
(`left|right|top|bottom`) plus `order`. Optional `block.width` and
`block.height` control its symbol body. Example:

```json
{
  "op": "add_component",
  "module_id": "control",
  "component": {
    "id": "adc_block",
    "type": "BLOCK",
    "name": "U1",
    "value": "ADC + DSP",
    "position": { "x": 420, "y": 220 },
    "rotation": 0,
    "pins": [
      { "id": "ain", "name": "AIN", "net": "filtered", "side": "left", "order": 0 },
      { "id": "clk", "name": "CLK", "net": "sample_clk", "side": "left", "order": 1 },
      { "id": "data", "name": "DATA", "net": "sample_data", "side": "right", "order": 0 },
      { "id": "vdd", "name": "VDD", "net": "vdd", "side": "top", "order": 0 },
      { "id": "gnd", "name": "GND", "net": "0", "side": "bottom", "order": 0 }
    ],
    "block": { "width": 180, "height": 140 }
  }
}
```

`BLOCK` defaults to schematic-only and is reported by ERC as not simulated.
A block participates in simulation only when it preserves an explicit legal
SPICE statement in `spice.raw` and declares `spice.simulated: true`. Reports
must identify every schematic-only block. The editable canvas, module card,
and document SVG all render the block from module data.

Schemas live under `schemas/`.

Editable truth is each `modules/<id>/module.circuit.json` (`actoviq.module.v2`)
inside a revisioned CircuitDocument. Design and SVG both render the same
`actoviq.schematic-document.v1` projection (symbols, semantic pin anchors such
as MOS `D/G/S/B`, orthogonal wires, junctions, explicit labels, and view
bounds). Save electrical and layout edits through `set_module_schematic` (or
netlist notebook upserts); one completed gesture is one revisioned transaction.
The background build coordinator regenerates the SPICE module netlist and
previews from that revision. Do not treat document SVG as a second editable
model, and do not edit generated `build/` artifacts.

`render/netlistsvg.svg` and module compatibility builds remain the AI/netlist
→ `netlist_to_json` → netlistsvg export path with independent geometry checks.
Legacy `modules/<id>/schematic.overrides.json` is still readable for historical
projects and netlistsvg-only placement; it is not the desktop editor's primary
write path. Preserve an existing override file when regenerating a module if
present. After changing a module netlist, run `compile-module` (or project
`compile`) and inspect ERC so the GUI preview refreshes. Read `notes` on the
module reference before editing. Users may address a module directly by its
stable `id`.

The GUI can save reusable design memory under the active workspace's
`references/design-memory/` folder (*Save template* / *Save flow*).
`templates/<id>/` contains `template.json`, `agent-guide.md`, `template.cir`
when the source project was compiled, `project.circuit.json`, module files, and
per-module `layout-reference.json` (connectivity-hash guarded placement).
Saving a template also registers a `references/catalog/` entry. The sidebar
**Reference catalog** can import `.cir` / layout images, seed projects, insert
modules, apply layout seeds, and promote visuals after a placement snapshot.
`flows/<id>/` contains `flow.json`, `design-flow.md`, and applied command logs
when present. Prefer validated memories during asset reuse, but still run fresh
ERC and simulation. Deleted projects move to `.trash/projects/`; do not treat
trash as a normal projects directory. Restoring history creates a new revision
(see `references/project-agent-protocol.md`).

In schematic view, bench-only voltage/current sources are intentionally hidden.
If a hidden source drives a visible non-rail control or bias node, the renderer
must expose that node as a named terminal such as `GATE`, `VREF`, `ITAIL`, or
`VB`; these terminals are part of the real netlistsvg connectivity and must not
be replaced by floating text labels.

The Netlist tab uses `modules/<id>/netlist-notebook.md` when that file exists.
It is an editable Markdown document: prose outside fenced code blocks is for
notes and explanations, while fenced `spice`, `cir`, or `netlist` blocks are
concatenated as the module netlist used by `compile-module`. When an Agent
edits a notebook-backed module, update the notebook code block and run
`compile-module` so the Design preview and SVG tab remain synchronized.

Notebook modules also drive **system-level** simulation. `compile`/`simulate`
splice each notebook module's devices and `.model` cards into
`build/system/design.final.cir` and hoist its analysis/measurement directives
(`.dc`, `.tran`, `.op`, `.ac`, `.meas`, `.print`, `.options`, ...) to the top
of the deck, so a DC regulator, transient, or MOSFET/active design simulates at
the system level instead of only through the auto-generated AC bench. Use this
path for anything needing models or a non-AC analysis: the structured
`components` list has no `.model` mechanism, so active devices (`M`, `Q`, `D`)
belong in a notebook. A notebook module is treated as a self-contained
sub-circuit — its local node names are kept verbatim and are not remapped to
system networks, so keep one self-contained design (or modules that share node
names intentionally) per project when mixing notebook netlists. Two gotchas:
ngspice `.meas ... FIND <expr> AT=<x>` cannot evaluate at the exact sweep
endpoint (sweep slightly past the point you measure). Simulation v2 reports
execution, measurement, and specification status independently. A measured
value is not a specification pass unless an explicit target evaluated it.

Project simulation isolates each analysis in its own deck and stores raw
vectors under the source revision. Native `.op`, `.dc`, `.ac`, `.tran`, `.sp`,
`.noise`, and `.pz` directives are supported. Actoviq metadata directives add
analyses that are not single native ngspice deck statements:

```spice
.actoviq fft v(out) window=blackman
.actoviq sweep R1 800 1200 9 analysis=dc
.actoviq montecarlo R1 1k 0.05 40 seed=42 analysis=op
.actoviq spec bandwidth_3db min=900 max=1100 unit=Hz
```

FFT requires a `.tran` directive. Sweep targets are an R/C/L instance name or
`param:<name>` and require a native inner analysis selected by `analysis=`.
Monte Carlo uses a nominal value, relative sigma, run count, and deterministic
optional seed. A specification accepts `min=`, `max=`, or both; thresholds may
use SPICE scalar suffixes. A run may have `execution_status: success` while
`specification_status: failed`. Treat a design as verified only when ERC is
non-blocking, build/simulation hashes match the current revision, required
analyses completed, and every declared specification passed.

The simulator saves native device-current vectors alongside node voltages. For
R/C/L AC analyses, ngspice's zero-valued internal placeholders are replaced by
the exact complex currents derived from node voltages and component values. In
the desktop editor, a pin/wire voltage probe or component current probe is
resolved through `build/system/source-map.json`, then opens Sim and selects the
matching vector. If the current run predates the probe vectors or belongs to
another revision, rerun simulation; never substitute a fabricated trace.

Every inter-module electrical network must have one explicit system name.
Pass `network` when using `connect_ports`, or use
`set_connection_network` with a stable `connection_id`. Renaming one
connection renames the entire connected group, so a source output such as
`VDD` or `DAC#1` appears with the same label on every consuming module in
the GUI. Keep each module's local `port.net` unchanged; the compiler maps
the shared system name to SPICE-safe node names.

For complex circuits, plan module boundaries and port contracts first. Keep
power, input protection, analog front end, gain, filter, detector/control, and
output stages separate when they have independent electrical responsibilities.
Modify one module per command when practical, keep its external ports stable,
compile after structural edits, and simulate before declaring completion.

The GUI surfaces a project through Design (module canvas / schematic editor),
Netlist (selected module notebook), SVG (shared `SchematicDocument` preview),
Sim, Report, plus Design memory actions for templates/flows. Sim supports
dataset selection plus Cartesian, Bode, polar, Smith, and table diagrams.
`compile` and `simulate` write `build/system/report.md` (modules, interfaces,
system networks, simulation metrics, and the system netlist), which the Report
tab renders. `simulate` also writes `build/system/simulation/result.json`; its
`metrics` feed the Sim tab and the Design inspector. Module-level metrics from
`simulate-module` appear in the Design inspector. There is no separate publish
step for the canvas model — writing these build files is what refreshes the GUI.

The older `<workspace-root>/jobs/` manifest workflow remains available only
for compatibility with existing result bundles. Do not call the legacy
built-in workflow for a project-canvas design.

For a new AI-generated circuit, **prefer functional modules** (stimuli / stage
cores / encode-load) with `upsert_module_netlist`, `add_port`, and
`connect_ports` in one revision. A single `upsert_module_netlist` is only for
trivial paths (about ≤8 devices). See
[modular-project-design.md](modular-project-design.md). Each upsert accepts
module metadata plus `netlist_notebook`, parses supported devices into
editable symbols, preserves models/directives/unknown legal statements,
infers ports and stable nets, and commits outputs as one revision. Use
`set_module_netlist` for an existing module. Do not construct a parallel SVG-
only representation.

