# actoviq-circuit-agent

[English](./README.md) | [简体中文](./README-zh.md)

Interactive ngspice-based circuit-design Agent built on the published `actoviq-agent-sdk` package.

This project turns natural-language requirements into SPICE-oriented schematic design artifacts. It currently focuses on principle schematic design, netlist generation, ngspice simulation, SVG schematic rendering, and engineering report writing. It is not yet a PCB layout, IC layout, signoff, or production-hardware validation tool. Future work will add more practical design automation, richer component libraries, stronger schematic layout quality, and deeper verification flows.

## What It Does

- Accepts natural-language circuit requirements from the terminal.
- Starts in a lightweight TUI by default for chat, slash commands, design, and revision workflows.
- Streams each agent stage in real time.
- Supports `/allow manual`, `/allow execution`, and `/allow all` confirmation policies.
- Generates English-safe job slugs even when the requirement is written in Chinese.
- Designs primitive-oriented SPICE netlists, runs ngspice verification, and renders netlistsvg schematics.
- Bundles circuit templates, Python helpers, and render assets inside this package.

## Quick Start

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

## Validation

```powershell
npm test
npm run build
npm run pack:dry-run
```