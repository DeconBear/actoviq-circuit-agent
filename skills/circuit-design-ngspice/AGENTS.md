# Circuit Design Ngspice — Agent Guidelines

This directory is a standalone skill. The Python scripts in `scripts/` must remain portable — no `pip` dependencies beyond stdlib, no path assumptions beyond `Path(__file__).resolve()` relative lookups.

## CI / Validation

```bash
# Basic smoke: validate all Python scripts are importable
python -c "import ast, pathlib; [ast.parse(pathlib.Path(p).read_text()) for p in pathlib.Path('scripts').glob('*.py')]"
```

## Layout Rules

- `SKILL.md` is the agent-facing instruction manual. Keep it in sync with the scripts.
- `agents/openai.yaml` is the platform integration shim for OpenAI Codex.
- `tool_paths.json` is a user-editable config file — always keep the default `""` value.
- References in `references/` are documentation for the agent, not executable code.
