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
- [references/spec-schema.md](references/spec-schema.md) — Specification JSON schema with examples
- `assets/templates/` — 11 starter SPICE netlist templates (rc_filter, opamp_noninv, opamp_mos_cascode, oscillator_ring, lna_common_emitter, buck_converter, ldo_mos_series, filter_ladder_bpf, filter_pi_lpf, filter_t_hpf, buck_mos_power)
- `assets/skins/analog.svg` — netlistsvg skin for analog circuit rendering
- `tool_paths.json` — User-editable ngspice binary path (default empty; fill in with absolute path to your ngspice executable)
