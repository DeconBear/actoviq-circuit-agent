# Tool Contracts, Caveats, and Errors

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
  --view schematic \
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

### `view_schematic_for_layout` (vision-only)

This is a read-only agent tool, not a command-line script. A vision-capable
model may call it with an existing generated schematic inside the project or
workflow workspace:

```json
{"svg_path": "<project>/build/.../preview.svg"}
```

It rasterizes the SVG with Electron and returns a short
`actoviq.vision-layout-image.v1` metadata block followed by an actual
`image/png` content block. The tool accepts SVG files only, rejects paths
outside allowed workspace roots, and does not edit the SVG, module, netlist,
or schematic document.

**Capability gate:** text-only models must not call this tool. They must make
layout decisions from `actoviq.layout-quality.v1` and other structured data.
The tool is absent from the default/text tool catalog and is injected only by
the host-invoked vision skill. Calls without explicit vision-capability metadata
are rejected.
The returned image is visual evidence only; it never authorizes changing
components, pins, nets, values, models, or SPICE data. See
[vision-layout-review.md](vision-layout-review.md).

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

