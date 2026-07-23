# Modular Desktop Project Design

Default design method for Actoviq **desktop canvas** projects
(`workspace/.../projects/<id>/`). Prefer functional modules connected with
`connect_ports`, not one dense netlist on a single sheet.

Jobs-workflow partitioning (`module-plan.json`, `compose_modules.py`) is
documented separately in [partitioned-design.md](partitioned-design.md). Do not
mix those job artifacts into an open desktop project.

## When To Split

**Default**: split by electrical responsibility whenever the circuit has more
than one functional stage (bias/reference, amp, comparator, filter, power,
encoder, load, etc.).

**Allowed single-module exception**: a trivial path with roughly **≤8**
editable devices, one signal chain, and no separate bias/reference domain
(example: first-order RC/RL filter with its stimulus in the same notebook).

ERC emits a non-blocking `oversized_module` warning when any module has more
than **16** non-`BLOCK` components, and may emit `monolithic_complex_design`
when a project still has only one substantial module with more than **8**
devices. These warnings do not block compile or simulate.

Positive example: `flash-adc-2bit` — `stimuli`, `ref_ladder`, `comp1`/`comp2`/
`comp3`, `encoder`.

## Recommended Module Roles

1. **stimuli / bench** — supplies, input sources, and analysis directives
   (`.op`, `.dc`, `.tran`, `.ac`, …).
2. **Functional cores** — one module per stage (reference ladder, OTA,
   comparator, LDO error amp, pass device, …).
3. **Interface / encode / load** — digital helpers, buffers, probe loads.

## Port And Connection Rules

- Share rails with `connect_ports` and name the `network` (`vdd`, `vin`,
  `vref`, `th1`, …).
- Use `add_port` for nets the importer does not infer (`vth`, `th*`, `c*`,
  `d*`). After `upsert_module_netlist`, module-card ports stay in sync with
  the module document.
- On a **stimuli** module, mark driving rails (`vdd`, `vin`/`input`, `vref`)
  as `direction: "output"` so hierarchical ERC sees them as drivers.
- Put `.dc` / swept sources in the module that owns the swept instance.
  Put `.print` / probes in the module that owns the probed nets (system
  compile rewrites local names when components are prefixed).
- Do **not** name resistors `Rload_*` — that prefix is reserved for hidden
  testbench loads and is skipped by the editable importer. Use `Rd1`, `Rc1`,
  etc.

## Agent Transaction Shape

For a multi-stage design, one `actoviq.command.v1` should typically include:

1. Several `upsert_module_netlist` ops (one notebook per module).
2. `add_port` for non-inferred interfaces.
3. `connect_ports` (and optional `set_connection_network`) for shared nets.
4. `set_analog_ic_profile` when `project_kind` is `analog_ic`.

Then `compile` and, when in scope, `simulate` / `simulate-module`.

## Reference Reuse

Prefer workspace `references/catalog/` assets (imported `.cir`, saved templates
with layout snapshots, layout idioms) before inventing a topology. Apply
`schematic_layout` only when `connectivity_hash` matches; see
[user-reference-assets.md](user-reference-assets.md).

## Readability Goal

Human reading happens on the **module canvas** plus **one stage at a time**.
Do not expect automatic layout to make a 40-device single sheet textbook-clean;
split first, then hand-place or run layout optimize on a single module if
needed.
