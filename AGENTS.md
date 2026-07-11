# Project Agent Guidelines

## Mandatory Validation For GUI / Schematic Work

- Any change that touches the Electron GUI, schematic editor, canvas interactions, SVG/netlistsvg rendering, layout/routing behavior, design-memory UI, or user-visible project workflows must be validated before it is considered complete.
- When the change affects `actoviq.module.v2`, `actoviq.schematic-document.v1`, or the schematic editor model, run:
  - `npm run test:schematic-document`
- For schematic-editor or manual-layout work, also run:
  - `npm run test:e2e:schematic-editor`
- For broader GUI workflow changes, run:
  - `npm run test:e2e:electron`
- Unit tests, type checks, build checks, static inspection, and screenshots are useful but do not replace Playwright validation for GUI behavior.
- Playwright artifacts should stay under `output/playwright/`.
- If Playwright cannot be run, explicitly report that the GUI work is not fully verified and explain the blocker.

## Preserve The AI Design Pipeline

- Keep the existing AI/netlist to `compile-module` to netlistsvg SVG path working when adding manual schematic editing.
- Manual editor changes should write structured project/module data first (`actoviq.module.v2`), then rebuild Design/SVG previews through the shared `actoviq.schematic-document.v1` projection and the existing compiler/rendering pipeline.
- Legacy `schematic.overrides.json` remains compatibility/export placement only; it is not the primary desktop edit path.
