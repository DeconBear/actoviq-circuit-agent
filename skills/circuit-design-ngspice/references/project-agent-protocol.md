# Actoviq Project Agent Protocol v2

## Source Of Truth

An Actoviq project is a revisioned CircuitDocument stored by
`project.circuit.json`, `modules/<id>/module.circuit.json`, and each module's
netlist notebook. Design, Netlist, document SVG, netlistsvg export, simulation,
and report are projections of that document. Never edit `build/` artifacts.

## Required Loop

1. Run `agent-context --project-root <project>`.
2. Verify `protocol_version`, `base_revision`, document hash, ERC, build state,
   simulation state, and `next_action`.
3. Retrieve saved templates/flows, but only prefer entries whose validation
   metadata says they passed for the applicable circuit family and spec range.
4. Submit one `actoviq.command.v1` transaction with the exact current
   `base_revision` and `actor: "agent"`.
5. Read the transaction ERC. Fix blocking errors before claiming a valid
   circuit. Reread context after any stale-revision rejection.
6. Run `compile`, then reread context and confirm the build revision/hash are
   current.
7. Run the analyses required by the specification. Execution success,
   measurement success, and specification pass are independent states.
8. Write the report only from simulation runs whose source revision and hash
   match the current document.

Native project analyses are `.op`, `.dc`, `.ac`, `.tran`, `.sp`, `.noise`, and
`.pz`. Use `.actoviq fft`, `.actoviq sweep`, and `.actoviq montecarlo` for
derived/ensemble runs and `.actoviq spec` for numeric acceptance limits. The
exact syntax and constraints are documented in `SKILL.md` under the GUI
project contract.

## Netlist First Creation

Use `upsert_module_netlist` to turn an AI-generated netlist directly into the
editable schematic model:

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

The importer creates editable components, stable net IDs, explicit labels,
ports, layout input, and preserved SPICE source in the same revision. Unknown
legal statements remain in preserved SPICE content and are never silently
deleted.

## ERC Gate

Blocking checks include conflicting network labels, missing device models,
missing ground, floating critical transistor pins, invalid DC sweep sources,
missing AC excitation, and invalid S-parameter ports. Warnings include
undriven inputs, missing transient excitation, and schematic-only blocks.

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
