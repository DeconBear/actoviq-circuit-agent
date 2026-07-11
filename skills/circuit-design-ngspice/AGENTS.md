# Circuit Design Ngspice — Agent Guidelines

This directory is a standalone skill. The Python scripts in `scripts/` must remain portable — no `pip` dependencies beyond stdlib, no path assumptions beyond `Path(__file__).resolve()` relative lookups.

## CI / Validation

```bash
# Basic smoke: validate all Python scripts are importable
python -c "import ast, pathlib; [ast.parse(pathlib.Path(p).read_text()) for p in pathlib.Path('scripts').glob('*.py')]"
```

Changes that affect the Electron GUI, schematic editor, canvas interactions,
SVG/netlistsvg rendering, layout/routing behavior, design-memory UI, or
user-visible workflows must also be verified from the repository root:

```bash
npm run test:schematic-document
npm run test:e2e:schematic-editor
npm run test:e2e:electron
```

Type checks, unit tests, build checks, static inspection, and screenshots are
not substitutes for Playwright validation of GUI behavior. If Playwright cannot
be run, explicitly report the blocker and mark the GUI work as not fully
verified.

## Layout Rules

- `SKILL.md` is the agent-facing navigation page. Keep it short; put detailed contracts in `references/` and keep them in sync with the scripts and the desktop schematic-document model (`actoviq.module.v2` → `actoviq.schematic-document.v1`).
- `agents/openai.yaml` is the platform integration shim for OpenAI Codex.
- `tool_paths.json` is a user-editable config file — always keep the default `""` value.
- References in `references/` are documentation for the agent, not executable code.
