# actoviq-circuit-agent

[English](./README.md) | [简体中文](./README-zh.md)

Agent-native ngspice circuit-design workbench. It turns natural-language requirements into SPICE-oriented schematic design artifacts: principle schematic design, netlist generation, ngspice simulation, netlistsvg schematic rendering, and engineering reports. It is not yet a PCB layout, IC layout, signoff, or production-hardware validation tool. Future work will add more practical design automation, richer component libraries, stronger schematic layout quality, and deeper verification flows.

There are three ways to use it:

- **Desktop GUI (recommended)** — an Electron workbench whose home screen is a modular schematic canvas. Claude Code / Codex drive the design through the portable skill, and results appear live in the GUI. No API key is required for this path.
- **Portable skill** — `skills/circuit-design-ngspice/` runs inside Claude Code, OpenAI Codex, Cursor, or any agent that can read a Markdown prompt and run shell commands.
- **Built-in CLI/TUI** — a self-contained chat/slash-command agent that talks to an Anthropic-compatible API (requires a provider token).

## What It Does

- Accepts natural-language circuit requirements from the terminal.
- Starts in a lightweight TUI by default for chat, slash commands, design, and revision workflows.
- Streams each agent stage in real time.
- Supports `/allow manual`, `/allow execution`, and `/allow all` confirmation policies.
- Generates English-safe job slugs even when the requirement is written in Chinese.
- Designs primitive-oriented SPICE netlists, runs ngspice verification, and renders netlistsvg schematics.
- Bundles circuit templates, Python helpers, and render assets inside this package.

## Desktop GUI (Agent-Native Workbench)

The Electron desktop app is a result-first workbench: the home screen is a modular schematic canvas, and the chat panel is an optional drawer. The API key is only needed for the built-in chat workflow — opening the GUI, managing workspaces, and displaying results produced by Claude Code / Codex all work without one.

Launch it from a source checkout:

```powershell
npm install
npm run electron:dev
```

This compiles the Electron main process, starts Vite, and opens the window.

**Tabs**

- **Design** — each circuit module is an asset card showing its netlistsvg preview (or a function/parameter summary), its `IN` / `OUT` / `GND` system-network names, a copyable module ID, and an Agent note field. `Ctrl`+scroll zooms, the middle mouse button pans, right-click adds or edits a module, and the corner handle resizes a card. Double-click a card to open its full netlistsvg schematic. In the full schematic view, enable *Edit layout* to drag symbols/terminals; the GUI stores those layout-only edits in `modules/<id>/schematic.overrides.json` and re-renders the wires without changing the SPICE netlist.
- **Design memory** — from the Design toolbar, *Save template* stores the current project as a reusable Agent template under `references/design-memory/templates/`; *Save flow* stores the applied design process under `references/design-memory/flows/`. The Design inspector lists recent saved templates and flows so you can confirm what was saved before reusing or hand-editing it. Future workflow runs expose these saved items through the Agent asset-reuse tools.
- **Netlist** — an editable Markdown notebook per module: fenced `spice` blocks are the netlist, prose around them is notes. Saving re-renders the module SVG.
- **SVG** — the selected module's netlistsvg schematic (the same module shown in Design and Netlist).
- **Sim** — system AC metrics from ngspice (status badge, table, chart) after *Simulate system*.
- **Report** — a generated Markdown report (modules, interfaces, system networks, simulation metrics, and the system netlist).

**Workspaces** — create multiple isolated workspaces, each with its own `projects/`, `jobs/`, and `references/`. The workspace root is user-selectable and defaults inside the repo under `workspace/` (git-ignored). Drop reference PDFs/images into `references/` and optionally run them through a configurable Yunzhisheng-compatible OCR endpoint (set in Settings).

**How the agent drives it** — Claude Code / Codex use the `circuit-design-ngspice` skill to create and edit projects under the active workspace; the GUI watches those files and refreshes the affected card. See the *GUI Project Canvas Contract* in [SKILL.md](./skills/circuit-design-ngspice/SKILL.md).

## Quick Start (CLI / TUI)

### 1. Install the CLI

After the package is published, install it globally:

```powershell
npm install -g actoviq-circuit-agent
```

For local source development:

```powershell
npm install
python -m pip install schemdraw
```

### 2. Install and Configure ngspice

`actoviq-circuit-agent` does not bundle ngspice. Install ngspice separately, then configure it with either `NGSPICE_BIN` or your system `PATH`.

Recommended on Windows:

```powershell
[Environment]::SetEnvironmentVariable(
  'NGSPICE_BIN',
  'C:\path\to\ngspice.exe',
  'User'
)
```

Open a new terminal after setting a permanent environment variable.

Temporary PowerShell session:

```powershell
$env:NGSPICE_BIN='C:\path\to\ngspice.exe'
```

macOS/Linux:

```bash
export NGSPICE_BIN=/usr/local/bin/ngspice
```

You can also add `ngspice` to your system `PATH`.

Resolution priority:

1. Python script argument `--ngspice-bin`
2. Environment variable `NGSPICE_BIN`
3. Packaged `embedded/circuit-design/tool_paths.json`
4. `ngspice` found on system `PATH`

For npm users, prefer `NGSPICE_BIN` or `PATH`. Do not edit files inside the installed npm package.

### 3. About Red Error Messages

During agent execution you may see red error messages in the terminal. These are produced by agent tool calls and exist to show whether the agent can detect and self-correct errors. They do **not** mean the workflow has failed. The agent often retries with alternative approaches and continues normally. If the workflow reaches the final summary stage, the design is complete regardless of intermediate tool errors.

### 4. Configure the Actoviq Provider

`actoviq-circuit-agent` talks to the model through an Anthropic-compatible API (the same request/response format as `https://api.anthropic.com/v1/messages`). Any provider that exposes that interface — Anthropic itself, an enterprise gateway, or a self-hosted proxy — works as long as it accepts an Anthropic-style auth header and returns Anthropic-style streaming responses.

Create an Actoviq config in the directory where you will run the CLI, or use `~/.actoviq/settings.json`.

```powershell
mkdir my-circuit-workspace
cd my-circuit-workspace
copy C:\path\to\agent.settings.example.json .\actoviq.settings.json
```

Edit `actoviq.settings.json` and fill in your provider endpoint, token, and model names. Never commit real API keys.

### 5. Start the Agent

Run the CLI from the directory you want to use as the workspace:

```powershell
actoviq-circuit-agent
```

The current directory becomes the workspace. Outputs are written to:

```text
./jobs/<job-id>/
./sessions/
```

Inside the TUI:

```text
/help
/allow execution
/design Design an op-amp gain stage followed by an RC filter and active-low comparator output.
```

Use `/allow all` for fully automatic stage transitions, or `/allow manual` to confirm every stage.

### 6. One-Shot Run

```powershell
actoviq-circuit-agent --approval-policy execution --job-name rc-demo --requirement "Design a 1 kHz RC low-pass filter and output the netlist, simulation report, and SVG schematic."
```

For source checkout development, replace `actoviq-circuit-agent` with:

```powershell
npm run dev -- --approval-policy execution --job-name rc-demo --requirement "Design a 1 kHz RC low-pass filter and output the netlist, simulation report, and SVG schematic."
```

## Run From Source

```powershell
npm run dev
```

The default entry opens the TUI. Type normal questions to chat with the general agent, or use slash commands:

```text
/help
/allow execution
/design Design a 1 kHz RC low-pass filter
/modify Increase the output drive and redraw the schematic
```

Use the previous one-shot requirement prompt with:

```powershell
npm run dev -- --legacy-cli
```

Source smoke run:

```powershell
npm run dev -- --auto-approve --job-name rc-demo --requirement "Design a 1 kHz RC low-pass filter and output the netlist, simulation report, and netlistsvg schematic."
```

## Linked Local CLI

For editable local installation:

```powershell
npm link
actoviq-circuit-agent --help
```

When installed with `npm link`, the command uses the directory where you run it as the workspace root. Outputs go to:

```text
./jobs/<job-id>/
./sessions/
```

Override that behavior with:

```powershell
$env:ACTOVIQ_CIRCUIT_AGENT_WORKSPACE_ROOT='C:\path\to\workspace'
```

## Config Resolution

Actoviq config is loaded in this order:

1. `--config <path>` or `ACTOVIQ_AGENT_CONFIG_PATH`
2. `./agent.settings.local.json` in the current working directory
3. `./actoviq.settings.json` in the current working directory
4. `agent.settings.local.json` in the package checkout
5. `~/.actoviq/settings.json`

Do not commit real API keys. Use `agent.settings.example.json` as the template.

## Large Circuit Partitioning

Large designs are partitioned by function during the design stage. The workflow writes `planning/module-plan.json` and `design/module-manifest.json`, then reuses those module boundaries during rendering. The final netlistsvg output is a single SVG sheet with labelled module/submodule sections; cross-module connectivity is represented by matching net labels and visible ports instead of long cross-sheet wires.

## Rendering

The workflow generates schematics via the netlistsvg backend:

- `render/netlistsvg.svg`: primary schematic output for all circuits.
- In schematic view, bench-only voltage/current sources are hidden to keep the
  drawing readable. When one of those hidden sources drives a visible
  non-rail control or bias node, the renderer exposes a named terminal such as
  `GATE`, `VREF`, `ITAIL`, or `VB` and routes it as a real net connection.
- Module schematic layout edits from the GUI are saved separately in
  `modules/<id>/schematic.overrides.json`. They move rendered cells before the
  router runs, so wires reconnect to the moved anchors while the module netlist
  remains the electrical source of truth.
- Reusable project templates and process notes saved from the GUI live under
  the active workspace's `references/design-memory/` folder. The Agent asset
  reuse stage lists those saved templates and flows alongside bundled starter
  templates.
- Rendering writes geometry/readability reports next to the SVG. These reports
  check missing pin connections, wire crossings, component overlaps, wire-body
  intrusions, and tight spacing.
- `npm run test:schematic-quality` generates a small regression corpus under
  `output/schematic-quality/` (RC, RLC, rectifier, BJT, MOS, and LDO examples),
  applies starter `schematic.overrides.json` placements, renders SVGs, and
  fails if any hard geometry check regresses.

`netlistsvg` is a Node.js package required for rendering. Install it once:

```powershell
npm install -g netlistsvg
```

## Standalone Skill (Claude Code / Codex / Cursor)

The `skills/circuit-design-ngspice/` directory contains a portable,
agent-runtime-agnostic skill that captures the same circuit-design workflow
without depending on `actoviq-agent-sdk`. It can be used directly inside
Claude Code, OpenAI Codex, Cursor, or any AI coding tool that can read a
Markdown prompt and execute shell commands.

### Installing the Skill

```powershell
# Install the same skill source for both Codex and Claude Code.
python skills\circuit-design-ngspice\scripts\install_skill.py --agent all --scope user
```

For a project-scoped install:

```powershell
python skills\circuit-design-ngspice\scripts\install_skill.py `
  --agent all `
  --scope project `
  --project-root C:\path\to\project
```

The installer copies one portable source into `.codex/skills/` and
`.claude/skills/`. Use `--force` to replace an existing installed copy.

**Manual use with any agent**:

Load `SKILL.md` into the agent's context and tell it to follow the
instructions. All Python scripts are under `skills/circuit-design-ngspice/scripts/`
and accept standard `argparse` arguments.

### Configuring ngspice for the Skill

The skill resolves ngspice in this order:

1. `--ngspice-bin` argument passed directly to Python scripts
2. `NGSPICE_BIN` environment variable
3. `tool_paths.json` in the skill root directory
4. system `PATH`

To configure it permanently, either set the environment variable (see
section 2 above) or edit the skill's `tool_paths.json`:

```json
{
  "ngspice_bin": "E:/Program/ngspice-45.2_64/Spice64/bin/ngspice.exe"
}
```

The skill reads `tool_paths.json` from its own directory, so each copy of
the skill can point to a different ngspice installation.

### Installing netlistsvg for the Skill

The `render_netlistsvg.py` script requires the `netlistsvg` CLI on your
system PATH:

```powershell
npm install -g netlistsvg
```

Verify it is reachable:

```powershell
netlistsvg --help
```

### Running a Design with the Skill

Tell the agent to load `SKILL.md` and provide a circuit requirement:

```
Please follow the circuit-design-ngspice skill in skills/circuit-design-ngspice/SKILL.md.
Design a 1 kHz RC low-pass filter and render the schematic.
```

The agent will create a workspace directory, run the 8-step workflow,
and produce all design artifacts including `design/design.final.cir`,
`render/netlistsvg.svg`, and `reports/final-summary.md`.

**Canvas project model (used with the desktop GUI).** When the GUI is open, the
agent works on the editable project model instead of the one-shot job workflow:
`scripts/circuit_project.py` creates and revises a project under
`<workspace>/projects/<id>/` (a `project.circuit.json` plus per-module
`modules/<id>/module.circuit.json` and `netlist-notebook.md`), then compiles and
simulates it. The GUI watches those files and refreshes the canvas, Netlist,
SVG, Sim, and Report tabs live. The full command and operation contract is in
[SKILL.md](./skills/circuit-design-ngspice/SKILL.md) under *GUI Project Canvas
Contract*.

## Validation

```powershell
npm test
npm run build
npm run pack:dry-run
```
