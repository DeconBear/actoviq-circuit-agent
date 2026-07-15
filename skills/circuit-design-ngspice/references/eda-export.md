# EDA schematic export

`export-eda` creates non-destructive editable schematic packages from the current `actoviq.module.v2` project revision. It never writes source modules, generated SVG placement overrides, or connectivity changes.

```powershell
python scripts/circuit_project.py export-eda `
  --project-root <project> `
  --scope project `
  --targets kicad,altium,orcad,virtuoso `
  --view design `
  --native-convert auto `
  --source-revision <current-revision>
```

Use `--scope module --module-id <id>` for a single module. `--strict-layout` rejects readability below 90. A configured `actoviq.eda-symbol-map.v1` file may be supplied with `--mapping-file`; incomplete or duplicate pin mappings fail the affected export rather than changing pin count or connectivity. Optional `--output-dir <folder>` writes the package to `<folder>/<export-id>/` instead of the default `<project>/build/exports/<export-id>/`.

The command runs ERC, rejects blocking diagnostics and stale revisions, generates deterministic layout candidates, compares them lexicographically, and verifies that the normalized connectivity hash is unchanged.

**View selection**

- A `design` view excludes components marked `mount_policy: testbench_exclude`. Ideal SPICE sources (`V` / `I`) are also omitted unless the project explicitly sets `mount_policy: design_include` (they are treated as bench objects by default). Nets that become exposed after omission are promoted to IR ports.
- A `simulation` view retains sources and testbench components.

**Artifacts and target status**

Artifacts are written under `build/exports/<export-id>/` by default (or under `--output-dir`). KiCad is generated directly with a portable `Actoviq_Standard` symbol library. Altium receives a KiCad import package (`kicad_import_source`). OrCAD receives EDIF 2.0.0. Virtuoso receives SPICE/CDL, mapping data, and a SKILL bootstrap.

Structural generation statuses:

| Status | Meaning |
| --- | --- |
| `syntax_validated` | Generated package passed structural / S-expression checks (KiCad, OrCAD). |
| `kicad_import_source` | Altium package is a validated KiCad import source, not a native SchDoc. |
| `generated_unverified` | Virtuoso package files were written; vendor import was not verified. |
| `vendor_parsed` | Optional native tool path succeeded (for example KiCad ERC + connectivity round-trip). |
| `failed` | Required native validation failed, or auto native checks could not complete. |

`--native-convert never` keeps the structural status only. `--native-convert auto` may attempt vendor checks when tools are present; failures are recorded without discarding already-generated packages. `--native-convert required` fails the export when native validation cannot pass.

Layout adjustment proposals use `actoviq.layout-patch.v1`. The validator accepts only bounded component/port moves, cardinal rotations, BLOCK pin-side changes, and rank/lane changes. It rejects electrical edits.
