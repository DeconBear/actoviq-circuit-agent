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
  - a crossing-aware **maze router** (Dijkstra on a fine channel grid, with
    orthogonal pin escapes) routes the rest, minimising crossings
  - crossover **hops** (little semicircle bumps) render the remaining inter-net
    crossings unambiguously, the way engineers draw them
  - a built-in geometry self-check (crossings / body intrusions)

schemdraw is used only as the symbol pen. We do **not** make schemdraw smarter;
we give it an AI-authored placement front-end.

## Result (LDO: PMOS pass + 5T OTA, 5 MOSFETs)

| Metric              | netlistsvg (current) | AI grid (auto from netlist) |
| ------------------- | -------------------- | --------------------------- |
| device overlaps     | 7                    | **0**                       |
| wire crossings      | 9                    | **2**                       |
| wire-body intrusions| 46                   | **0**                       |
| readability         | unreadable blob      | clean, labelled             |

See `comparison.png` (left: netlistsvg; right: auto-generated from the same netlist).

## Run

Fully automatic (netlist -> idiom recognition -> layout-IR -> schematic):

```bash
python prototype/auto_layout.py \
    --netlist <project>/modules/ldo/netlist-notebook.md \
    --out prototype/ldo_auto.layout.json
python prototype/grid_render.py --layout prototype/ldo_auto.layout.json \
    --svg-path prototype/ldo_auto.svg
node prototype/rasterize.mjs prototype/ldo_auto.svg prototype/ldo_auto.png
node prototype/compare.mjs        # side-by-side vs the netlistsvg output
```

`prototype/ldo.layout.json` is the original hand-authored layout, kept for
reference. `auto_layout.py` reproduces it (and more) straight from the netlist.

## How the auto-placer works (`auto_layout.py`)

Parses the SPICE netlist and recognises the common analog idioms purely from
connectivity, then places them with known-good relative positions:

- **current mirror** — same-type FETs sharing a gate net, one diode-connected
- **differential pair** — same-type FETs sharing a (non-rail) source net
- **tail source / reference / pass device / feedback divider / output loads**
- **rails** — the supply (highest source fan-out net) and ground become buses;
  the supply-defining source is drawn as the rail, not an inline battery

Unrecognised devices fall back to a spare row so the drawing always closes.

## Integrated into the skill

The production version lives in the skill as
`skills/circuit-design-ngspice/scripts/render_grid.py` (self-contained:
netlist parse + idiom auto-layout + schemdraw draw). `circuit_project.py`
`compile-module` now calls it for **transistor/active** modules (any netlist
with `M`/`Q` devices) and keeps **netlistsvg** for passive ones, writing the
same `build/modules/<id>/schematic.svg` the GUI already reads — so the Design
and SVG tabs show the clean schematic automatically, no GUI changes needed.
schemdraw is an optional dependency: if it is missing, `render_grid` returns
`{"ok": false}` and the caller falls back to netlistsvg.

## Status / next steps

- [x] grid renderer + rails + geometry self-check
- [x] auto-derive the layout-IR from the netlist via idiom recognition
- [x] **integrated into `circuit_project.py compile-module` -> shows in the GUI**
- [x] **crossing-aware maze router** (Dijkstra on a fine channel grid with
      orthogonal pin escapes): comb 5 crossings -> 2, still 0 overlaps /
      0 intrusions. Earlier naive A* attempt regressed; the fix was proper
      obstacle sizing + orthogonal escapes + a wider cell pitch.
- [x] **crossover hops** for the remaining inter-net crossings + shallower
      pin escapes for tidier diff-pair source routing
- [ ] broaden idioms (cascode, folded-cascode, multi-stage). The diff-pair
      source-to-tail loops remain a minor cosmetic item: they are inherent to
      the escape clearance that guarantees zero body intrusions, and would need
      idiom-specific tail routing (join the two sources at one point) to remove.
