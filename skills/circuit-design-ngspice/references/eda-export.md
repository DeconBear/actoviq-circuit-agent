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

Artifacts are written under `build/exports/<export-id>/` by default (or under `--output-dir`). KiCad is generated directly with a portable `Actoviq_Standard` symbol library. Altium receives an exact, validated copy of that KiCad import source. OrCAD receives EDIF 2.0.0. Virtuoso receives SPICE/CDL, mapping data (including deterministic generic-symbol fallbacks), module schematics, a top-level hierarchy, and a SKILL bootstrap.

The public `targets.<target>.status` contract is:

| Status | Meaning |
| --- | --- |
| `native` | The configured vendor tool parsed the package and its available round-trip checks passed. |
| `import_ready` | The portable package passed Actoviq structural/round-trip validation and is ready for manual vendor import. |
| `warning` | A usable package remains, but an optional vendor check or unattended conversion did not complete cleanly. |
| `failed` | Required native validation/conversion failed. |

Format-specific structural results remain machine-readable under `targets.<target>.detail.structural_status` (`syntax_validated`, `kicad_import_source`, or `generated_unverified`). `--native-convert never` returns `import_ready` after internal validation without invoking vendor tools. `--native-convert auto` returns `native` when an implemented vendor check succeeds, `import_ready` when no tool is configured, or `warning` when a non-blocking optional check cannot complete. `--native-convert required` returns `failed` and fails the command when native validation/conversion cannot pass.

Internal validation is stricter than a file-presence check:

- KiCad cross-checks every instance against embedded and project-local symbol definitions, pin numbers, UUIDs, and normalized connectivity; `kicad-cli`, when available, additionally runs ERC and netlist round-trip.
- Altium verifies that every KiCad project/schematic/library/table file is copied byte-for-byte. Altium-specific mapping is retained as advisory metadata because the first-stage importer consumes the KiCad bindings.
- OrCAD parses the EDIF libraries, symbol ports, pin locations, instances, transforms, page nets, stored wire coordinates, and top hierarchy against EDA IR.
- Virtuoso compares both SPICE and CDL with the IR pin order/net partition, verifies device-map and generic fallback coverage, and checks that SKILL reconstructs every module, terminal, wire path, component, and top-level connection.

Without Altium, OrCAD Capture, or Virtuoso installed, Actoviq can prove package structure and normalized connectivity but cannot claim that a particular vendor release has imported and re-saved its native database. Those targets remain `import_ready`, not `native`.

Layout adjustment proposals use `actoviq.layout-patch.v1`. The validator accepts only bounded component/port moves, cardinal rotations, BLOCK pin-side changes, and rank/lane changes. It rejects electrical edits.
