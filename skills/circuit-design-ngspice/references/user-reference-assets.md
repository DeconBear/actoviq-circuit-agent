# User Reference Assets

Actoviq stores reusable **electrical** and **schematic-layout** references under
the active workspace `references/` tree. Layout means principle-sheet placement
and orthogonal routing — not GDS/physical IC layout and not PCB KiCad cold
import.

## Directory layout

```text
<workspace>/references/
  catalog/<asset_id>/
    asset.json                 # actoviq.reference-asset.v1
    payload/                   # cir, layout-reference, idiom, preview, ...
  design-memory/templates|flows/
  <documents> + .ocr/          # read-only document references
```

## Asset kinds

| kind | Typical use_as |
|------|----------------|
| `circuit_project` / `circuit_module` | `seed_new_project`, `insert_module` |
| `schematic_layout` | `apply_layout_seed` (requires matching `connectivity_hash`) |
| `layout_idiom` | `guide_router` (tag/role match → constrained layout-patch) |
| `layout_visual` | `agent_context_only` until vision promotion |
| `document` / `spec` / `pdk_binding` | context or PDK path binding |

**Netlist is source of truth.** Layout references never change SPICE. On hash
mismatch they degrade to `agent_context_only`.

## CLI (`circuit_project.py`)

```bash
python skills/circuit-design-ngspice/scripts/circuit_project.py reference-catalog-list
python ... reference-import-circuit --file path/to/deck.cir --as circuit_module
python ... reference-import-visual --file path/to/schematic.png
python ... prepare-layout-from-reference --project-root <proj> --module-id <id> --asset-id <id>
python ... apply-layout-from-reference --project-root <proj> --module-id <id> --asset-id <id>
python ... reference-promote-visual-layout --asset-id <visual> --layout-reference-json <json>
```

`.subckt` imports are **flattened** into one module notebook (no `X` hierarchy).
Multiple subcircuits require `--subckt-name`.

## Design memory

Saving a template also writes per-module `layout-reference.json` and registers a
`catalog/` entry so agents can discover electrical + layout packages together.

## Vision promotion

`layout_visual` images may be inspected by the vision layout reviewer. Accepted
`layout-patch` improvements can be promoted to a `schematic_layout` asset with
the current module `connectivity_hash`. Images are never a direct source write
path (see [vision-layout-review.md](vision-layout-review.md)).

## Related

- [gui-project-canvas.md](gui-project-canvas.md)
- [modular-project-design.md](modular-project-design.md)
- [analog-ic-design.md](analog-ic-design.md)
