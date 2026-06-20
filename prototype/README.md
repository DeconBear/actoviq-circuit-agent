# AI grid-layout schematic — prototype

Proves a method for AI-authored analog schematics that beats both current
renderers (netlistsvg/ELK and the schemdraw `build_layout` path).

## The idea

> Automatic schematic = **placement + routing** (hard) + **symbol drawing** (easy).

Both existing renderers *guess* placement from a flat netlist and fail: matched
analog devices (diff pair, current mirror) collapse onto each other and wires
run through component bodies. The fix is a division of labour:

- **The AI owns placement** — it understands the topology. It emits a coarse
  *layout intent* (`*.layout.json`): one device per integer grid **cell**, an
  orientation, and per-pin net names. No pixels, just integers + enums + net
  names, which LLMs emit reliably.
- **Deterministic code owns geometry** (`grid_render.py`):
  - one device per cell → **overlaps are structurally impossible**
  - power/ground **rails** → most wires leave the body area
  - orthogonal **comb routing** in the channels between cells
  - a built-in geometry self-check (crossings / body intrusions)

schemdraw is used only as the symbol pen. We do **not** make schemdraw smarter;
we give it an AI-authored placement front-end.

## Result (LDO: PMOS pass + 5T OTA, 5 MOSFETs)

| Metric              | netlistsvg (current) | AI grid prototype |
| ------------------- | -------------------- | ----------------- |
| device overlaps     | 7                    | **0**             |
| wire crossings      | 9                    | **4**             |
| wire-body intrusions| 46                   | **0**             |
| readability         | unreadable blob      | clean, labelled   |

See `comparison.png`.

## Run

```bash
python prototype/grid_render.py --layout prototype/ldo.layout.json \
    --svg-path prototype/ldo_grid.svg
node prototype/rasterize.mjs prototype/ldo_grid.svg prototype/ldo_grid.png
node prototype/compare.mjs        # side-by-side vs the netlistsvg output
```

## To productionise

1. Have the design agent emit the `layout.json` directly (it already authors the
   netlist), or derive a first guess from the netlist + a topology-idiom library
   (diff-pair / mirror / cascode) and let the agent refine it.
2. Close the loop: feed the geometry self-check back to the agent so it nudges
   cells until crossings hit zero.
3. Add a `render_grid` option to `circuit_project.py` alongside netlistsvg.
