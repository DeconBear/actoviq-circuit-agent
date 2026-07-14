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

Use `--scope module --module-id <id>` for a single module. `--strict-layout` rejects readability below 90. A configured `actoviq.eda-symbol-map.v1` file may be supplied with `--mapping-file`; incomplete or duplicate pin mappings fail the affected export rather than changing pin count or connectivity.

The command runs ERC, rejects blocking diagnostics and stale revisions, generates deterministic layout candidates, compares them lexicographically, and verifies that the normalized connectivity hash is unchanged. A `design` view excludes only components explicitly marked `mount_policy: testbench_exclude`; any exposed node becomes an IR port. A `simulation` view retains sources and testbench components.

Artifacts are written under `build/exports/<export-id>/`. KiCad is generated directly. Altium receives a KiCad 8 import package, OrCAD receives EDIF 2.0.0, and Virtuoso receives SPICE/CDL, mapping data, and a SKILL bootstrap. Proprietary native files are optional vendor-tool conversions; without those tools the target status is `import_ready`.

Layout adjustment proposals use `actoviq.layout-patch.v1`. The validator accepts only bounded component/port moves, cardinal rotations, BLOCK pin-side changes, and rank/lane changes. It rejects electrical edits.
