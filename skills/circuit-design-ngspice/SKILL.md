---
name: circuit-design-ngspice
description: >
  Design, simulate, and render primitive-based SPICE circuits with ngspice and
  netlistsvg. Given a natural-language circuit requirement, run the full
  workflow: requirements analysis, specification normalization, template
  selection, architecture planning, primitive-only netlist design, AC+power
  simulation, schematic rendering, and summary reporting. Supports single-block
  and partitioned (multi-module) designs. Use this skill when the user asks to
  design a circuit, create a SPICE netlist, run ngspice simulation, or render
  a schematic from a netlist.
---

# Circuit Design Ngspice

## Overview

This skill turns natural-language circuit requirements into verified SPICE
designs and SVG schematics. It wraps a suite of Python CLI scripts for
ngspice simulation, netlist validation, and netlistsvg rendering into a
step-by-step workflow that any AI coding agent can execute.

## GUI Project Canvas Contract

When the Actoviq desktop GUI is open, treat the active workspace as the
handoff boundary between the coding agent and the visual app.

- Create or use a project under `<workspace-root>/projects/<project-id>/`.
- Put user-provided reference files under `<workspace-root>/references/`.
- If OCR text exists, read it from `<workspace-root>/references/.ocr/`.
- Treat `project.circuit.json` and each `modules/<id>/module.circuit.json` as
  the only editable source of truth.
- Use `scripts/circuit_project.py` for deterministic creation, modification,
  revision, compilation, and simulation. Do not edit generated files under
  `build/`.
- The GUI watches project files and refreshes the corresponding canvas after
  a successful atomic write.

Create a project:

```bash
python scripts/circuit_project.py create \
  --projects-root <workspace-root>/projects \
  --name "<project name>"
```

Create the three-module power/amplifier/filter example:

```bash
python scripts/circuit_project.py create-demo \
  --projects-root <workspace-root>/projects \
  --name "<project name>"
```

Inspect before modifying:

```bash
python scripts/circuit_project.py summary \
  --project-root <workspace-root>/projects/<project-id>
```

Apply a structured command:

```bash
python scripts/circuit_project.py apply \
  --project-root <workspace-root>/projects/<project-id> \
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

`BLOCK` is deliberately not emitted as a SPICE device. The compiler records
it as a comment/source-map entry while the underlying simulated behavior must
still be implemented with primitive R/C/L/D/Q/M/V/I components. The editable
canvas, module card, and document SVG all render the block from module data.

Schemas live under `schemas/`.

The desktop module canvas keeps `module.circuit.json` as the structured manual
editing source and netlistsvg as the electrical rendering backend. The GUI
Editor mode can save components, ports, wires, and annotations through
`set_module_schematic`; after that, run `compile-module` to regenerate the SPICE
module netlist and netlistsvg preview. The SVG preview mode also supports
layout-only user edits: moving a rendered symbol or terminal writes
`modules/<id>/schematic.overrides.json`, and `compile-module` applies those
positions before re-routing wires. These overrides are not electrical edits.
Preserve the override file when regenerating a module, and do not edit generated
`build/` SVGs directly. After changing a module netlist, always run
`compile-module`; this preserves the
`netlist -> netlist_to_json -> netlistsvg SVG` flow and refreshes the GUI
preview. Read `notes` on the module reference before editing. Users may address
a module directly by its stable `id`.

The GUI can save reusable design memory under the active workspace's
`references/design-memory/` folder. `templates/<id>/` contains
`template.json`, `agent-guide.md`, `template.cir` when the source project was
compiled, `project.circuit.json`, and module files. `flows/<id>/` contains
`flow.json`, `design-flow.md`, and applied command logs when present. In future
designs, inspect these saved templates and flows during asset reuse before
inventing a new topology; treat them as reusable guidance that still requires
fresh simulation and schematic verification.

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
endpoint (sweep slightly past the point you measure), and a metric's `pass`
flag reports whether ngspice **evaluated** the measurement, not spec
conformance — a measurement ngspice could not compute is surfaced as a failed
metric instead of vanishing.

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

The GUI surfaces a project through five tabs: Design (the module canvas),
Netlist (the selected module's notebook), SVG (the selected module's
netlistsvg), Sim, and Report. `compile` and `simulate` write
`build/system/report.md` (modules, interfaces, system networks, simulation
metrics, and the system netlist), which the Report tab renders. `simulate` also writes
`build/system/simulation/result.json`; its `metrics` feed the Sim tab and the
Design inspector. Module-level metrics from `simulate-module` appear in the
Design inspector. There is no separate publish step for the canvas model —
writing these build files is what refreshes the GUI.

The older `<workspace-root>/jobs/` manifest workflow remains available only
for compatibility with existing result bundles. Do not call the legacy
built-in workflow for a project-canvas design.

## Installation

The same source skill supports Codex and Claude Code:

```bash
python scripts/install_skill.py --agent all --scope user
```

Use `--scope project --project-root <path>` for a repository-local install.
Pass `--force` only when replacing an installed copy.

**Scope**: schematic-level SPICE design, AC/power simulation, and SVG
rendering. Not for PCB layout, IC mask layout, or production signoff.

**Key constraints enforced by validation scripts**:
- **Primitive-only**: every component instance must use `R`, `C`, `L`, `Q`,
  `M`, `D`, `V`, `I`. Forbidden: `X`, `E`, `F`, `G`, `H`, `B`, `A`, `U`.
- No `.subckt` / `.ends` / `.include` / `.lib` directives.
- No standalone net-label lines (nodes only appear as component terminals).

## Required Inputs

Before starting, collect from the user (if not already provided):

- **Circuit requirement**: Natural-language description of what to design
- **Input node name**: e.g. `in`, `vin`, `rf_in` (can be inferred)
- **Output node name**: e.g. `out`, `vout`, `alarm_n` (can be inferred)
- **Target specifications**: key metrics with numeric ranges (e.g. cutoff
  frequency 900–1100 Hz, gain ≥ 10 dB, supply voltage 5 V)
- **Supply voltage**: if not mentioned, assume 5 V DC
- **Design constraints**: topology preferences, output logic polarity, etc.

If the user is vague, make reasonable assumptions and document them in the
requirements brief.

## Workflow

Execute stages in order. Each stage produces specific artifacts in a
structured workspace. Stages 1–4 are planning; stages 5–7 are execution;
stage 8 is summary.

Create a workspace directory structure early:

```
<job-root>/
  inputs/
  planning/
  design/modules/
  verification/
  render/
  reports/
```

### Step 1: Requirements Analysis

**Goal**: Parse the natural-language requirement into a structured spec.

1. Read the user's requirement and write `inputs/user-requirements.md` as a
   Markdown summary of the requirement, design goals, explicit and assumed
   parameters, constraints, and a recommended circuit domain.

2. Write `planning/spec.raw.json` with these keys:
   ```json
   {
     "project_name": "snake_case_name",
     "domain": "filter|opamp|oscillator|lna_rf|power|comparator|ldo|mixer",
     "input_node": "in",
     "output_node": "out",
     "supply_node": "vcc",
     "constraints": { "topology": "...", "supply_v": 5 },
     "targets": { "cutoff_hz": { "min": 900, "max": 1100 } },
     "notes": "assumptions and rationale"
   }
   ```

3. Normalize the spec:
   ```bash
   python scripts/normalize_spec.py --spec-path planning/spec.raw.json --output-path planning/spec.normalized.json
   ```
   This derives complementary metrics (e.g. linear gain → dB), creates
   `targets_eval`, and normalizes units. Read the output JSON for `warnings`.

**Outputs**: `inputs/user-requirements.md`, `planning/spec.raw.json`,
`planning/spec.normalized.json`.

### Step 2: Technical Solution & Execution Checklist

**Goal**: Evaluate solution approaches and produce a concrete checklist.

Read `planning/spec.normalized.json`. Write two files:

- `planning/technical-solution.md` (≤70 lines): solution overview, candidate
  topologies, key tradeoffs, parameter budget, and template reuse strategy.
- `planning/execution-checklist.md` (≤70 lines): numbered stage-by-stage
  action list with inputs, outputs, and tool calls for each step.

For multi-stage signal chains (e.g. op-amp → RC filter → comparator), note
whether the design should be single-block or partitioned.

**Outputs**: `planning/technical-solution.md`,
`planning/execution-checklist.md`.

### Step 3: Template Selection

**Goal**: Pick a starter netlist from the template library.

1. List available templates:
   ```bash
   ls assets/templates/
   ```
   Available: `rc_filter.cir`, `oscillator_ring_mos_3stage.cir`,
   `lna_common_emitter_rf_bench.cir`, `opamp_mos_cascode_eval.cir`,
   `opamp_noninv.cir`, `filter_ladder_bpf_50ohm.cir`,
   `filter_pi_lpf_50ohm.cir`, `filter_t_hpf_50ohm.cir`,
   `buck_converter.cir`, `buck_mos_power_bench.cir`,
   `ldo_mos_series_bench.cir`.

2. Select the best match and copy it:
   ```bash
   cp assets/templates/<template>.cir design/template.cir
   ```

3. Write `planning/asset-reuse-plan.md` (≤80 lines): which template was
   selected and why, parameter modifications needed, and which validation
   scripts will be used.

**Outputs**: `design/template.cir`, `planning/asset-reuse-plan.md`.

### Step 4: Architecture & Module Planning

**Goal**: Define topology, parameter budget, and module boundaries.

Read `planning/spec.normalized.json` and `design/template.cir`. Write:

- `planning/architecture.md` (≤90 lines): topology diagram (ASCII or
  descriptive), parameter equations, node naming convention, signal flow,
  and template-to-design modification strategy.

- `planning/verification-plan.md` (≤90 lines): how each spec target will be
  verified via simulation — which analysis types, which `.meas` directives,
  and expected ranges.

- `planning/module-plan.json`: partition strategy. See
  [references/module-plan-schema.md](references/module-plan-schema.md) for
  the full schema. Use `"single_block"` for designs with ≤20 components.
  Use `"partitioned"` for large designs, multi-domain designs, or when the
  spec requests it. For partitioned designs, list each module with its
  input/output nets, local net prefix, and component names.

For partitioned designs, read
[references/partitioned-design.md](references/partitioned-design.md), then
run:

```bash
python scripts/validate_module_interfaces.py --job-root <job-root> --require-partitioned
python scripts/compose_modules.py --job-root <job-root>
```

**Outputs**: `planning/architecture.md`, `planning/verification-plan.md`,
`planning/module-plan.json`.

### Step 5: Netlist Design

**Goal**: Produce a validated, primitive-only SPICE netlist.

This is the core design step. Start from `design/template.cir` and iterate
until all validations pass.

**Primitive-only hard requirement**:
- Allowed component prefixes: `R`, `C`, `L`, `Q`, `M`, `D`, `V`, `I`
- Forbidden: `X`, `E`, `F`, `G`, `H`, `B`, `A`, `U`
- No `.subckt` / `.ends` / `.include` / `.lib`
- Approximate op-amps, comparators, and active circuits with transistor-level
  primitives (MOSFET `M`, BJT `Q`, diode `D`)

**Design loop** (max 3 iterations):

1. Edit the netlist. For single-block designs, work in
   `design/design.final.cir`. For partitioned designs, write one
   `design/modules/<nn>_<name>.cir` per module, then compose into
   `design/design.final.cir` by concatenation. Each module section starts
   with `* MODULE <order>: <name>`.

2. Run primitive validation:
   ```bash
   python scripts/validate_netlist_primitives.py --netlist-path design/design.final.cir
   ```
   Check the `ok` field in the output JSON. Fix any violations before
   proceeding. Expect `forbidden_instance_count: 0`.

3. Run parameter check (optional but recommended):
   ```bash
   python scripts/strict_param_check.py --netlist-path design/design.final.cir --allow-expression --output-path verification/strict-param-check.json
   ```

4. Run dual analysis (AC + power):
   ```bash
   python scripts/run_dual_analysis.py --work-dir verification/ --netlist-path design/design.final.cir --spec-path planning/spec.normalized.json --ngspice-bin <path> --timeout-sec 60
   ```
   If ngspice is not found, determine the path via:
   - `--ngspice-bin` CLI argument
   - `NGSPICE_BIN` environment variable
   - `tool_paths.json` in the skill root
   - System `PATH` lookup

   Check the output JSON: `ok`, `ac.ok`, `power.ok`, `evaluation.pass`,
   `evaluation.failed_metrics`, `evaluation.gaps`.

5. If evaluation fails but the netlist is structurally correct, apply
   targeted parameter patches:
   ```bash
   python scripts/patch_netlist.py --netlist-path design/design.final.cir --patch-plan-path design/patch-plan.json --output-path design/design.final.cir
   ```
   The patch plan is a JSON file with `set_param` (name→value map) and
   `replace_text` (old→new string replacements).

6. If three iterations fail to converge, stop and proceed to the verification
   stage with the best result so far. Document remaining gaps.

**Module composition notes for partitioned designs**:
- Modules connect through matching net labels (node names)
- Each module's local nets should use a unique prefix (from module plan)
- After writing `design/modules/*.cir`, read all module files and concatenate
  into `design/design.final.cir`
- Run `repair_module_interfaces.py` if output nets are accidentally reused:
  ```bash
  python scripts/repair_module_interfaces.py --netlist-path design/design.final.cir --module-plan-path planning/module-plan.json --spec-path planning/spec.normalized.json --apply
  ```
- Prefer `validate_module_interfaces.py` followed by `compose_modules.py`
  over manual concatenation. These tools enforce module ownership, unique
  component names, private net prefixes, and balanced interfaces.

Write supporting artifacts:
- `design/design-notes.md` (≤80 lines): device enumeration, parameter
  decisions, iteration log, remaining warnings.
- `design/detailed-design-report.md` (≤100 lines): topology rationale,
  functional block walkthrough, signal flow, parameter equations, simulation
  results, limitations, template reuse status.
- `design/module-manifest.json`: for partitioned designs. See
  [references/module-plan-schema.md](references/module-plan-schema.md).

**Outputs**: `design/design.final.cir`, `design/design-notes.md`,
`design/detailed-design-report.md`, `verification/strict-param-check.json`,
`verification/primitive-check.json`.

### Step 6: Simulation & Verification

**Goal**: Confirm the design passes all spec targets and identify gaps.

Run the final verification pass:

```bash
python scripts/run_dual_analysis.py --work-dir verification/final/ --netlist-path design/design.final.cir --spec-path planning/spec.normalized.json --ngspice-bin <path> --timeout-sec 120
```

Inspect the output:
- `data.ok`: transport success (tool ran) — not the same as verification pass
- `evaluation.pass`: whether all spec metrics are within target ranges
- `evaluation.failed_metrics`: which metrics are out of spec
- `evaluation.missing_metrics`: which targets couldn't be measured
- `evaluation.gaps`: warnings about coverage

Write `verification/final-review.md` (≤70 lines): pass/fail for each spec
target with measured vs. expected values, remaining risks, and next steps.

**Do not redesign the topology at this stage.** If failures are limited to
trimmable parameters (e.g. RC values), apply targeted patches and re-run.

If using a signal-chain comparator topology, ensure the comparator output
stage uses a pull-up/pull-down resistor network (not an ideal model).

**Outputs**: `verification/final-review.md`.

### Step 7: Schematic Rendering

**Goal**: Generate an SVG schematic from the validated netlist.

1. Convert the netlist to JSON:
   ```bash
   python scripts/netlist_to_json.py --netlist-path design/design.final.cir --json-path render/design.json --input-node <in> --output-node <out>
   ```
   If a `module-manifest.json` exists, pass `--module-manifest-path design/module-manifest.json`.

2. Render with netlistsvg:
   ```bash
   python scripts/render_netlistsvg.py --json-path render/design.json --svg-path render/netlistsvg.svg --netlistsvg-bin netlistsvg --skin-profile analog
   ```
   The `netlistsvg` npm package must be installed (`npm install -g netlistsvg` or locally). If not found, install it first.

3. The render pipeline automatically:
   - Calls the `netlistsvg` CLI to produce the base SVG
   - Applies the analog skin profile (`assets/skins/analog.svg`)
   - Replaces generic rectangles with recognisable op-amp/comparator symbols
   - Performs wire routing (horizontal trunks + vertical taps)
   - Applies user schematic layout overrides from
     `modules/<id>/schematic.overrides.json` before routing, when present
   - Exposes hidden control/bias source nodes as connected terminals such as
     `GATE`, `VREF`, `ITAIL`, and `VB`
   - Generates `render/netlistsvg.geometry.json` and `render/netlistsvg.layout.json`
   - Checks SVG geometry for readability

4. Write `render/netlistsvg-notes.md` with rendering notes and any geometry
   issues noted in the layout report.

**Outputs**: `render/design.json`, `render/netlistsvg.svg`,
`render/netlistsvg.geometry.json`, `render/netlistsvg.layout.json`,
`render/netlistsvg-notes.md`.

### Step 8: Final Summary

**Goal**: Produce a consolidated project summary.

Read all key artifacts. Write `reports/final-summary.md` (≤90 lines) including:
- Requirement summary
- Selected topology and rationale
- Final netlist path: `design/design.final.cir`
- Verification status: pass/fail per target with values
- Schematic SVG path: `render/netlistsvg.svg`
- Module manifest path (if partitioned)
- Remaining risks and recommended next steps

Write `reports/manifest.json` listing all output files:
```json
{
  "job_id": "<slug>",
  "design_final": "design/design.final.cir",
  "schematic_svg": "render/netlistsvg.svg",
  "final_review": "verification/final-review.md",
  "final_summary": "reports/final-summary.md"
}
```

Then publish the job to the GUI:

```bash
python scripts/publish_job.py --job-root <job-root> --job-id <slug>
```

**Outputs**: `reports/final-summary.md`, `reports/manifest.json`.

## Tool Usage Contract

All command-line arguments in `<angle brackets>` must be replaced with
absolute or relative paths. Use `python <script_path>` unless the system
defaults to `python3`.

### `normalize_spec.py`

```bash
python scripts/normalize_spec.py --spec-path planning/spec.raw.json --output-path planning/spec.normalized.json
```
Output JSON keys: `ok`, `output_path`, `warnings`, `derived_metrics`.

### `validate_netlist_primitives.py`

```bash
python scripts/validate_netlist_primitives.py --netlist-path design/design.final.cir
```
Output JSON keys: `ok`, `violations[]`, `summary { allowed_instance_count, forbidden_instance_count, forbidden_directive_count, missing_param_count }`.
The `ok` field is `true` only when `forbidden_instance_count == 0`.

### `strict_param_check.py`

```bash
python scripts/strict_param_check.py --netlist-path design/design.final.cir --allow-expression --output-path verification/strict-param-check.json
```
Output JSON keys: `ok`, `violations[]`, `warnings[]`, `summary { checked_components, violating_components, skipped_components }`.

### `run_dual_analysis.py`

```bash
python scripts/run_dual_analysis.py \
  --work-dir verification/ \
  --netlist-path design/design.final.cir \
  --spec-path planning/spec.normalized.json \
  --ngspice-bin <path_or_ngspice> \
  --timeout-sec 60 \
  --power-analysis tran \
  --supply-source V1
```
Output JSON keys: `ok`, `ac { run, metrics }`, `power { run, metrics }`,
`metrics_path`, `evaluation_path`, `evaluation { pass, failed_metrics[], missing_metrics[], gaps[] }`, `warnings[]`.

The script automatically:
1. Splits the netlist into AC and power-analysis halves via `split_netlist_analyses.py`
2. Runs ngspice on each half
3. Parses results via `parse_results.py`
4. Evaluates against spec via `evaluate_against_spec.py`

**Ngspice path resolution** (in order):
1. `--ngspice-bin` CLI argument
2. `NGSPICE_BIN` environment variable
3. `tool_paths.json` in the skill root directory
4. System `PATH` lookup for `ngspice`

### `run_ngspice.py`

Low-level wrapper for running a single netlist with ngspice.
```bash
python scripts/run_ngspice.py --netlist-path <netlist.cir> --work-dir <dir> --ngspice-bin <path> --timeout-sec 30
```
Output JSON keys: `ok`, `return_code`, `log_path`, `stderr`, `artifacts[]`.

### `patch_netlist.py`

```bash
python scripts/patch_netlist.py --netlist-path design/design.final.cir --patch-plan-path design/patch-plan.json --output-path design/design.final.cir
```
Patch plan format:
```json
{
  "set_param": { "R1": "10k", "C1": "100n" },
  "replace_text": [{ "old": "R1 in out 1k", "new": "R1 in out 10k" }]
}
```
Output JSON keys: `ok`, `updated_netlist_path`, `diff_summary[]`.

### `repair_module_interfaces.py`

```bash
python scripts/repair_module_interfaces.py --netlist-path design/design.final.cir --module-plan-path planning/module-plan.json --spec-path planning/spec.normalized.json --apply
```
Output JSON keys: `ok`, `changed`, `changes[]`, `warnings[]`.

### `netlist_to_json.py`

```bash
python scripts/netlist_to_json.py \
  --netlist-path design/design.final.cir \
  --json-path render/design.json \
  --input-node <in_node> \
  --output-node <out_node> \
  --module-manifest-path design/module-manifest.json \
  --format netlistsvg
```
Writes a netlistsvg-compatible JSON with: components, params, interfaces,
io_inference, schematic_intent, schematic_blocks, module_manifest,
circuit_metadata, modules.

### `render_netlistsvg.py`

```bash
python scripts/render_netlistsvg.py \
  --json-path render/design.json \
  --svg-path render/netlistsvg.svg \
  --netlistsvg-bin netlistsvg \
  --skin-profile analog
```
The `netlistsvg` npm package must be on PATH. If the binary is not found,
install it: `npm install -g netlistsvg`.

Output JSON keys: `ok`, `svg_path`, `skin_path`, `geometry`, `layout`,
`warnings[]`.

### `check_svg_geometry.py`

```bash
python scripts/check_svg_geometry.py --svg-path render/netlistsvg.svg --json-path render/design.json --report-path render/netlistsvg.geometry.json
```
Output JSON keys: `ok`, `summary { pins_checked, net_segments, missing_pin_connections, wire_crossings, component_overlaps, readability_score }`.

## Analysis Execution Caveat

**ngspice batch mode**: The `run_ngspice.py` and `run_dual_analysis.py`
scripts run ngspice in batch mode (`-b`). Interactive features (plotting,
`.alter` loops, etc.) are not available. All analysis must be expressed
through `.ac`, `.tran`, `.dc`, `.op`, `.meas`, and `.print` directives
embedded in the netlist. The `split_netlist_analyses.py` script separates
AC-directed measurements (`.ac` + `.meas AC`) from power-directed measurements
(`.tran`/`.dc`/`.op` + `.meas DC`/`.meas TRAN`) into two standalone netlists
to avoid analysis-type conflicts.

**ngspice binary resolution**: Always determine the ngspice path before
running simulations. On Windows the binary is typically `ngspice.exe`. The
resolution order is: CLI argument → `NGSPICE_BIN` env var → `tool_paths.json`
→ `PATH`. If ngspice cannot be resolved, stop and instruct the user to
configure it.

## Convergence Rules

During the netlist design step (Step 5), follow these rules:

1. **Priority order**: Fix primitive violations first, then parameter errors,
   then AC metrics, then power/DC metrics. Structural correctness before
   performance tuning.

2. **Rollback threshold**: If an edit round makes MORE metrics fail, discard
   it and revert to the previous iteration. Apply smaller, incremental
   changes.

3. **Termination**: Stop iterating after 3 rounds even if specs are not fully
   met. Proceed to verification and report the gaps honestly. Do not loop
   indefinitely.

4. **Parameter-only fixes**: If all validation checks pass but an AC metric
   is slightly off (within 20% of target), fix by tuning passive component
   values only — do not change topology.

5. **No ideal sources**: Never use behavioral sources (B), VCVS (E), VCCS
   (G), or ideal op-amp models to meet a spec. Every active element must be a
   real transistor or diode.

## Output Requirements

All design artifacts are written under a `<job-root>` directory. A single
design produces:

**Required (every design)**:
```
<job-root>/
  inputs/user-requirements.md
  planning/spec.raw.json
  planning/spec.normalized.json
  planning/technical-solution.md
  planning/execution-checklist.md
  planning/asset-reuse-plan.md
  planning/architecture.md
  planning/verification-plan.md
  planning/module-plan.json
  design/template.cir
  design/design.final.cir
  design/design-notes.md
  design/detailed-design-report.md
  verification/strict-param-check.json
  verification/primitive-check.json
  verification/final-review.md
  render/design.json
  render/netlistsvg.svg
  render/netlistsvg.geometry.json
  render/netlistsvg.layout.json
  render/netlistsvg-notes.md
  reports/final-summary.md
  reports/manifest.json
```

**Additional for partitioned designs**:
```
  design/modules/<nn>_<name>.cir  (one per module)
  design/module-manifest.json
```

## Error Handling

| Condition | Action |
|---|---|
| `ngspice` not found on PATH, `NGSPICE_BIN` not set, `tool_paths.json` empty | Stop and tell the user to set `NGSPICE_BIN` or install ngspice. Do not proceed to simulation steps. |
| `validate_netlist_primitives.py` returns `ok: false` | Read the `violations` array. Fix each violation (remove/replace forbidden instances). Re-run until `ok: true`. |
| `run_dual_analysis.py` returns `ok: false` | Read `warnings` and `stderr` (if accessible via the log). Check that `design/design.final.cir` is syntactically valid SPICE. Common causes: unquoted node names, missing `.end`, analysis-type mismatch. |
| `netlistsvg` binary not found | Run `npm install -g netlistsvg` or guide the user to install it. The `render_netlistsvg.py` script requires a `netlistsvg` binary on PATH. |
| `render_netlistsvg.py` returns `ok: false` | The script writes partial SVG by default (best-effort). Check `warnings[]` for the specific failure. If netlistsvg itself failed, try running it manually: `netlistsvg render/design.json -o render/netlistsvg.svg`. |
| Module plan references a module file that doesn't exist | Create the missing `design/modules/<nn>_<name>.cir` file with the components listed in the module plan entry. |
| Three design iterations without convergence | Stop. Mark remaining gaps in the verification report. Do not loop. |

## References and Assets

- [references/module-plan-schema.md](references/module-plan-schema.md) — Full module-plan.json schema and partitioning guide
- [references/partitioned-design.md](references/partitioned-design.md) — Large-circuit partitioning and interface budgets
- [references/spec-schema.md](references/spec-schema.md) — Specification JSON schema with examples
- `assets/templates/` — 11 starter SPICE netlist templates (rc_filter, opamp_noninv, opamp_mos_cascode, oscillator_ring, lna_common_emitter, buck_converter, ldo_mos_series, filter_ladder_bpf, filter_pi_lpf, filter_t_hpf, buck_mos_power)
- `assets/skins/analog.svg` — netlistsvg skin for analog circuit rendering
- `tool_paths.json` — User-editable ngspice binary path (default empty; fill in with absolute path to your ngspice executable)
