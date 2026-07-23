# Actoviq Project Agent Protocol v2

## Source Of Truth

An Actoviq project is a revisioned CircuitDocument stored by
`project.circuit.json`, `modules/<id>/module.circuit.json` (`actoviq.module.v2`),
and each module's netlist notebook. Design and document SVG render the same
`actoviq.schematic-document.v1` projection of that module; Netlist, netlistsvg
export, simulation probes, and report are also projections of the current
revision. Never edit `build/` artifacts, and never attach probe vectors from
another revision.

## Required Loop

1. Run `agent-context --project-root <project>`.
2. Verify `protocol_version`, `project_kind`, `base_revision`, document hash, ERC,
   build state, simulation state (required only when `kind.requires_simulation`),
   linked `bridges`, `lcsc.supported`, `pcb_readiness`, and `next_action`.
3. Retrieve saved templates/flows, but only prefer entries whose validation
   metadata says they passed for the applicable circuit family and spec range.
4. For `pcb_schematic`, prefer LCSC search → bind (`bind_lcsc_part` / `lcsc-bind`)
   before a KiCad handoff or experimental JLCEDA exchange. For `analog_ic`, set and validate
   `analog_ic_profile` before accepting transistor sizing or simulation.
5. Submit one `actoviq.command.v1` transaction with the exact current
   `base_revision` and `actor: "agent"`.
6. Read the transaction ERC. Fix blocking errors before claiming a valid
   circuit. Reread context after any stale-revision rejection.
7. Run `compile`, then reread context and confirm the build revision/hash are
   current.
8. Run the analyses required by the specification when simulation is in-scope.
   Execution success, measurement success, and specification pass are independent
   states.
9. For `pcb_schematic`, use `bridge-push` / `bridge-pull` for stable-ID-based
   layout/property handoff with KiCad or the vendor-unverified experimental
   嘉立创 EDA exchange JSON. This does not yet reconstruct
   arbitrary peer connectivity edits. For `analog_ic`, use the validated
   SPICE/CDL + mapping + SKILL Virtuoso package instead.
10. Write the report only from simulation runs whose source revision and hash
    match the current document.

Native project analyses are `.op`, `.dc`, `.ac`, `.tran`, `.sp`, `.noise`, and
`.pz`. Use `.actoviq fft`, `.actoviq sweep`, and `.actoviq montecarlo` for
derived/ensemble runs and `.actoviq spec` for numeric acceptance limits. The
exact syntax and constraints are documented in `SKILL.md` under the GUI
project contract.

## Modular Creation (Default)

Desktop projects default to **functional modules**, not one dense notebook.
See [modular-project-design.md](modular-project-design.md).

Typical roles: `stimuli` (sources + analyses), one module per stage
(reference, amp, comparator, …), then encode/load. Wire shared nets with
`add_port` + `connect_ports`. Mark stimuli rail ports as `output` so ERC
treats them as drivers.

**Exception**: a trivial single-path circuit (about ≤8 editable devices) may
use one `upsert_module_netlist`:

```json
{
  "schema": "actoviq.command.v1",
  "command_id": "agent-create-filter-001",
  "actor": "agent",
  "project_id": "filter-project",
  "base_revision": 0,
  "message": "Create and verify an RC low-pass filter",
  "operations": [
    {
      "op": "upsert_module_netlist",
      "module_id": "filter",
      "name": "RC low-pass filter",
      "kind": "filter",
      "function": "First-order low-pass response",
      "netlist_notebook": "```spice\n* RC filter\nV1 in 0 AC 1\nR1 in out 1k\nC1 out 0 100n\n.ac dec 20 10 1meg\n.end\n```"
    }
  ]
}
```

For multi-stage designs, one transaction should include several
`upsert_module_netlist` ops, then `add_port` / `connect_ports`. Example shape
(abbreviated): stimuli + `ref_ladder` + `comp1` + `encoder`, with networks
`vdd` / `vin` / `th1` / `c1`. The flash ADC project `flash-adc-2bit` is the
canonical desktop sample.

The importer creates editable components, stable net IDs, explicit labels,
ports, layout input, and preserved SPICE source in the same revision. The
kind-scoped netlist gate runs before parsing: forbidden prefixes/directives are
rejected rather than hidden in preserved `opaque` or `models` content.

## Analog IC Loop

1. Commit `set_analog_ic_profile` with the user-supplied PDK/model library,
   corner, temperature, and sizing policy.
2. Run `analog-ic-audit`; reconcile structured MOS identity with the exact
   notebook used by compile and require explicit positive W/L (plus valid M/NF).
3. Compile and simulate with ngspice. Relative top-level model paths are
   materialized for the isolated temporary working directory.
4. Export Virtuoso only after the audit passes. Treat SPICE/CDL and the handoff
   manifest as authoritative; SKILL is a connectivity/geometry bootstrap, not
   an ADE/CDF/PCell/layout round trip.

## ERC Gate

Blocking checks include conflicting network labels, missing device models,
missing ground, floating critical transistor pins, invalid DC sweep sources,
missing AC excitation, and invalid S-parameter ports. Warnings include
undriven inputs, missing transient excitation, schematic-only blocks,
`oversized_module` (more than 16 non-`BLOCK` devices in one module), and
`monolithic_complex_design` (a lone substantial module with more than 8
devices). Modularity warnings are advisory; split by function rather than
hiding devices.

Do not hide or rename a conflicting net to make ERC green. Resolve the actual
topology or explicitly update the label primitive. A MOS gate connected to a
named net is electrically connected only when its pin references that net's
stable `net_id`; visible text alone is not connectivity.

## Revision Rules

- Mouse-up, completed wire, property submit, and Agent command are transaction
  boundaries.
- A stale command must fail. Never silently rebase it.
- Restore creates a new revision and does not rewrite history.
- Build, simulation, report, template, and flow records must carry source
  revision and document hash.
- A result from an older hash is stale even if its numeric revision appears
  similar.
