# AI grid-layout schematic — prototype

> **Status:** research / historical prototype. The desktop GUI no longer treats
> `render_grid` / netlistsvg `schematic.svg` as the editable Design/SVG source
> of truth. Production editing uses `actoviq.module.v2` projected to
> `actoviq.schematic-document.v1`; netlistsvg and grid renders remain
> compatibility / quality-check exports. Keep this directory for layout
> experiments; do not assume its SVG path is what the GUI editor saves.

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
  - **idiom routing** for known sub-circuits — the diff-pair *tail* (both
    sources drop to one bar, then a single wire to the tail source) and a local
    *diode jumper* for the mirror reference — so they draw the textbook way
  - a crossing-aware **maze router** (Dijkstra on a *pin-aware* grid: every
    device pin's exact x/y is added as a grid line, so each terminal sits *on*
    the lattice — access stubs are truly orthogonal and trunks meet the
    gate/drain/source head-on, never beside it) routes everything else,
    minimising crossings
  - crossover **hops** (little semicircle bumps) render the remaining inter-net
    crossings unambiguously, the way engineers draw them
  - a built-in geometry self-check (crossings / body intrusions)

schemdraw is used only as the symbol pen. We do **not** make schemdraw smarter;
we give it an AI-authored placement front-end.

## Result (LDO: PMOS pass + 5T OTA, 5 MOSFETs)

| Metric              | netlistsvg (current) | AI grid (auto from netlist) |
| ------------------- | -------------------- | --------------------------- |
| device overlaps     | 7                    | **0**                       |
| wire crossings      | 9                    | **3** (drawn as hops)       |
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

A production-oriented grid renderer still lives in the skill as
`skills/circuit-design-ngspice/scripts/render_grid.py` (self-contained:
netlist parse + idiom auto-layout + schemdraw draw). `circuit_project.py`
`compile-module` may still call it for **transistor/active** modules and keep
**netlistsvg** for passives when building compatibility SVGs under
`build/modules/<id>/`. That path is an export/quality check — the desktop
Design and SVG tabs render the shared `SchematicDocument` from
`module.circuit.json`, not by parsing those build SVGs back into an editor
model. schemdraw is an optional dependency: if it is missing, `render_grid`
returns `{"ok": false}` and the caller falls back to netlistsvg.

## Status / next steps

- [x] grid renderer + rails + geometry self-check
- [x] auto-derive the layout-IR from the netlist via idiom recognition
- [x] **integrated into `circuit_project.py compile-module` -> shows in the GUI**
- [x] **crossing-aware maze router** (Dijkstra on a fine channel grid with
      orthogonal pin escapes): comb 5 crossings -> 2, still 0 overlaps /
      0 intrusions. Earlier naive A* attempt regressed; the fix was proper
      obstacle sizing + orthogonal escapes + a wider cell pitch.
- [x] **crossover hops** for the remaining inter-net crossings
- [x] **pin-aware (Hanan) routing grid**: every routed pin's exact x/y becomes a
      grid line, so each terminal sits *on* the lattice. Access stubs are then
      exactly vertical/horizontal and trunks meet the gate/drain/source head-on,
      fixing the snap-induced diagonal kinks where wires landed *beside* a pin.
      Same metrics (0 overlaps / 3 crossings / 0 intrusions).
- [x] **readability polish**: junction dots derived *geometrically* (a dot
      wherever 3+ same-net wire arms meet — every rail tap, pin-stub/trunk join
      and idiom bar), same-net segments merged into continuous wires, larger
      R/C and W/L value labels, and bold `VIN`/`GND` rail labels.
- [x] **idiom routing**: diff-pair tail bar (kills the source loops) + a local
      diode jumper. The diode reference is routed through its **gate** (which
      sits at mid-height, near the pair) rather than its top drain, so the mirror
      net stays local instead of looping up over the device. (A full mirror
      gate-bus idiom was tried and reverted - it added clutter, not clarity.)
- [ ] broaden idioms (cascode, folded-cascode, multi-stage, single-stage gain)
