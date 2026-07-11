---
name: circuit-design-ngspice
metadata:
  version: "2.1.0"
  protocol_version: "actoviq.project-agent.v2"
description: >
  Design, simulate, and render primitive-based SPICE circuits with ngspice and
  netlistsvg for the Actoviq project canvas. Given a natural-language circuit
  requirement, run the full workflow: requirements analysis, specification
  normalization, template selection, architecture planning, primitive-only
  netlist design, multi-analysis simulation, schematic-document rendering, and
  summary reporting. Supports single-block and partitioned (multi-module)
  designs on `actoviq.module.v2` / `actoviq.schematic-document.v1`. Use this
  skill when the user asks to design a circuit, create a SPICE netlist, run
  ngspice simulation, or render a schematic from a netlist.
---

# Circuit Design Ngspice

## Overview

This skill turns natural-language circuit requirements into verified SPICE
designs and schematic artifacts. It wraps portable Python CLI scripts that any
AI coding agent can execute.

**Scope**: schematic-level SPICE design, waveform/sweep simulation, and SVG
rendering. Not for PCB layout, IC mask layout, or production signoff.

**Default path**: Actoviq desktop project canvas (`projects/<id>/`).  
**Compatibility path**: one-shot `jobs/<id>/` workflow.

Read detail files only when needed — keep this page as the map.

## Hard Constraints

- **Primitive-only**: instance prefixes `R`, `C`, `L`, `Q`, `M`, `D`, `V`, `I`.
  Forbidden: `X`, `E`, `F`, `G`, `H`, `B`, `A`, `U`.
- No `.subckt` / `.ends` / `.include` / `.lib`.
- No standalone net-label lines (nodes only as component terminals).
- Never edit generated `build/` artifacts.

## Protocol Loop (Desktop Projects)

Implements `actoviq.project-agent.v2`. Before changing a desktop project, read
[references/project-agent-protocol.md](references/project-agent-protocol.md)
and `skill-version.json`.

1. Run `agent-context`; use exact `project_id` and `base_revision`.
2. Submit one `actoviq.command.v1` transaction (`actor: "agent"`).
3. Read returned ERC; fix blocking errors.
4. Run `compile`, then required simulations for the current revision.
5. Never invent a new revision number to retry a stale command — reread context.

Editable truth: `modules/<id>/module.circuit.json` (`actoviq.module.v2`).  
Design/SVG: shared `actoviq.schematic-document.v1` projection.  
netlistsvg / `schematic.overrides.json`: export / legacy placement only.

## Desktop Canvas — Quick Start

Full contract:
[references/gui-project-canvas.md](references/gui-project-canvas.md)

**Always resolve the GUI workspace before creating projects** — do not invent
`workspace/projects/` paths. The Electron app reads
`~/.actoviq/actoviq-circuit-agent-workspaces.json` and defaults to
`<repo>/workspace/workspaces/default/projects/`.

```bash
python scripts/circuit_project.py workspace-active
python scripts/circuit_project.py workspace-list
python scripts/circuit_project.py workspace-use --workspace-id default

# create uses the active workspace projectsDir when --projects-root is omitted
python scripts/circuit_project.py create --name "<project name>"

python scripts/circuit_project.py agent-context \
  --project-root <projectsDir>/<project-id>

python scripts/circuit_project.py apply \
  --project-root <projectsDir>/<project-id> \
  --command-file <command.json>

python scripts/circuit_project.py compile --project-root <project-root>
python scripts/circuit_project.py simulate --project-root <project-root>
```

Prefer one `upsert_module_netlist` for a new AI-generated circuit. Prefer
validated entries under workspace `references/design-memory/`, then still run
fresh ERC + simulation. Ignore `.trash/projects/` as a normal projects root.

## Jobs Workflow — Outline

Full steps, inputs, and required artifacts:
[references/jobs-workflow.md](references/jobs-workflow.md)

Use this path for one-shot job bundles. Do **not** use it as the edit model for
an open desktop canvas project.

1. Requirements → `inputs/` + normalized spec  
2. Technical solution + checklist  
3. Template selection from `assets/templates/`  
4. Architecture / module plan  
5. Primitive-only netlist design loop (max 3 iterations)  
6. Simulation & verification  
7. netlistsvg render (compat export; not desktop editor truth)  
8. Final summary + `publish_job.py`

## Tools Index

Command examples, output keys, ngspice resolution, convergence rules, and
error table:
[references/tool-contracts.md](references/tool-contracts.md)

| Script | Role |
|---|---|
| `circuit_project.py workspace-*` | Resolve GUI workspace / projectsDir |
| `normalize_spec.py` | Spec normalization |
| `validate_netlist_primitives.py` | Primitive-only gate |
| `strict_param_check.py` | Parameter sanity |
| `run_dual_analysis.py` / `run_ngspice.py` | Simulation |
| `patch_netlist.py` | Parameter patches |
| `validate_module_interfaces.py` / `compose_modules.py` / `repair_module_interfaces.py` | Partitioned jobs |
| `netlist_to_json.py` / `render_netlistsvg.py` / `check_svg_geometry.py` | Compat SVG export |
| `circuit_project.py` | Desktop project transactions |

Ngspice path order: `--ngspice-bin` → `NGSPICE_BIN` → `tool_paths.json` → `PATH`.

## Installation

```bash
python scripts/install_skill.py --agent all --scope user
python scripts/install_skill.py --agent all --scope user --check
python scripts/install_skill.py --agent all --scope user --force
```

Use `--scope project --project-root <path>` for a repo-local install.

## References and Assets

- [references/project-agent-protocol.md](references/project-agent-protocol.md) — revisioned project loop
- [references/gui-project-canvas.md](references/gui-project-canvas.md) — desktop GUI contract
- [references/jobs-workflow.md](references/jobs-workflow.md) — jobs 8-step workflow
- [references/tool-contracts.md](references/tool-contracts.md) — CLI contracts and errors
- [references/module-plan-schema.md](references/module-plan-schema.md) — module-plan schema
- [references/partitioned-design.md](references/partitioned-design.md) — large-circuit partitioning
- [references/spec-schema.md](references/spec-schema.md) — specification JSON schema
- `schemas/` — project/module/command/ERC/simulation JSON schemas
- `assets/templates/` — starter SPICE netlists
- `assets/skins/analog.svg` — netlistsvg analog skin
- `tool_paths.json` — optional ngspice path override
