# Module Plan Schema (module-plan.json)

Used for partitioned (multi-module) designs. Write this during the architecture stage.

## Schema

```json
{
  "strategy": "single_block",
  "project_name": "example_design",
  "complexity_score": 15,
  "shared_nets": ["vdd", "0"],
  "top_level_input_nets": ["in"],
  "top_level_output_nets": ["out"],
  "modules": [
    {
      "name": "input_stage",
      "file": "design/modules/01_input_stage.cir",
      "purpose": "Input impedance matching and ESD protection",
      "input_nets": ["in"],
      "output_nets": ["mid1"],
      "local_net_prefix": "i_",
      "component_names": ["R1", "C1"],
      "verification_targets": ["zin_50ohm"]
    }
  ]
}
```

## Strategy Values

- `"single_block"`: Design is small enough for a single flat netlist. No modules needed.
- `"partitioned"`: Design is partitioned into modules. Write each module's `.cir` file under `design/modules/`, then compose into `design/design.final.cir`.

## When to Partition

- Total component count exceeds 20-25 devices
- Design spans multiple domains (RF frontend + baseband + logic)
- Multiple independent feedback loops
- Design explicitly requests partitioned approach

## Constraints

- Modules connect ONLY through named net labels (matching node names)
- No subcircuits (`.subckt`/`.ends`) — primitives only
- Each module section starts with `* MODULE <order>: <name>`
- Final netlist is a flat concatenation of all module sections
- Module output nets must not be reused as intermediate nets in other modules
- Component names must be globally unique.
- Private nets must start with the module's `local_net_prefix`.
- Non-top-level interface nets need one producer and at least one consumer.
- Run `validate_module_interfaces.py` before `compose_modules.py`.
