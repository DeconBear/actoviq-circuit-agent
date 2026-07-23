# PCB EDA Handoff + LCSC

Actoviq keeps schematic truth in `actoviq.module.v2`. Only `pcb_schematic`
projects link peer EDA folders. Identity uses `stable_id` / `ACTOVIQ_ID`.
Current pull support reconciles layout, rotation, value, and reference for
known stable-ID components. Foreign-symbol metadata is created only while
materializing unknown components during cold import; pull does not reconstruct arbitrary peer connectivity
edits and must not be described as lossless or real-time co-editing.

## Bridge manifests

- `projects/<id>/bridges/kicad.bridge.json`
- `projects/<id>/bridges/jlceda.bridge.json`

Peer packages write under `<peer_root>/actoviq-sync/` (schematic only; never
overwrite PCB/board files).

## Commands

```bash
python scripts/circuit_project.py bridge-link --project-root <p> --peer-kind kicad --peer-root <dir>
python scripts/circuit_project.py bridge-push --project-root <p> --peer-kind kicad --source-revision <n>
python scripts/circuit_project.py bridge-pull --project-root <p> --peer-kind jlceda --policy manual_review
python scripts/circuit_project.py bridge-import-cold --peer-kind kicad --peer-root <dir> --name Imported --project-kind pcb_schematic
```

Policies: `layout_wins` | `connectivity_wins` | `manual_review`.

## LCSC

Desktop settings provide the API key/secret to Python through child-process
environment variables, not command-line arguments. Offline demo uses
`--use-fallback` (non-production mock catalog).

```bash
python scripts/circuit_project.py lcsc-search --query "1k 0603" --use-fallback
python scripts/circuit_project.py lcsc-bind --project-root <p> --module-id main --component-id r1 --lcsc-id C21190 --use-fallback
```

Binding accepts a canonical C-number (`C` followed by digits) and writes
`eda.lcsc_id`, `mpn`, `manufacturer`, `datasheet_url`, `jlc_basic`, and
`footprint_hint`. Handoff export forwards LCSC/MPN as peer attributes so KiCad
or 嘉立创 EDA can resolve/map the part. A C-number does not by itself prove that
an EDA symbol, pin map, or footprint exists; verify those in the target library
before fabrication. The offline fallback is test data only. Runtime lookup
cache lives under `~/.actoviq/circuit-design-ngspice/parts-cache`, outside the
installed skill.

## Altium

Native Altium bidirectional sync is deferred. Continue using the KiCad-importable
export package / Altium-via-KiCad path until a dedicated Altium bridge exists.

## Multi-sheet

Each Actoviq module maps to one IR page / peer sheet. Cold-start import creates
`sheet1` and may materialize unknown KiCad symbols as `BLOCK` with
`eda.foreign_symbol`.
