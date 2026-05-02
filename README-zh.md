# actoviq-circuit-agent

[English](./README.md) | [简体中文](./README-zh.md)

基于已发布的 `actoviq-agent-sdk` 构建的交互式、基于 ngspice 的电路设计 Agent。

本项目把自然语言电路需求转换为面向 SPICE 的原理图设计产物。目前重点覆盖原理图级设计、网表生成、ngspice 仿真、SVG 电路图渲染和工程报告编写。它还不是 PCB layout、IC layout、signoff 或生产级硬件验证工具。后续会继续开发更实用的设计自动化能力、更丰富的器件库、更高质量的原理图布局，以及更深入的验证流程。

## 功能概览

- 在终端中接收自然语言电路需求。
- 默认启动轻量 TUI，支持对话、斜杠命令、设计和修改工作流。
- 实时流式输出每个 Agent 阶段。
- 支持 `/allow manual`、`/allow execution` 和 `/allow all` 三种确认策略。
- 即使用户用中文描述需求，也会生成英文安全的 job slug。
- 生成 primitive-oriented SPICE 网表，调用 ngspice 验证，并渲染 netlistsvg 原理图。
- 内置电路模板、Python 辅助脚本和渲染资源。

## 快速开始

### 1. 安装 CLI

npm 包发布后，可以全局安装：

```powershell
npm install -g actoviq-circuit-agent
```

如果是本地源码开发：

```powershell
npm install
python -m pip install schemdraw
```

### 2. 安装并配置 ngspice

`actoviq-circuit-agent` 不内置 ngspice。请单独安装 ngspice，然后通过 `NGSPICE_BIN` 或系统 `PATH` 配置。

Windows 推荐方式：

```powershell
[Environment]::SetEnvironmentVariable(
  'NGSPICE_BIN',
  'C:\path\to\ngspice.exe',
  'User'
)
```

设置永久环境变量后，需要重新打开终端。

仅当前 PowerShell 会话生效：

```powershell
$env:NGSPICE_BIN='C:\path\to\ngspice.exe'
```

macOS/Linux：

```bash
export NGSPICE_BIN=/usr/local/bin/ngspice
```

也可以直接把 `ngspice` 加入系统 `PATH`。

ngspice 路径解析优先级：

1. Python 脚本参数 `--ngspice-bin`
2. 环境变量 `NGSPICE_BIN`
3. 包内 `embedded/circuit-design/tool_paths.json`
4. 系统 `PATH` 中的 `ngspice`

对 npm 用户，推荐使用 `NGSPICE_BIN` 或 `PATH`。不要直接修改已安装 npm 包内部的文件。

### 3. 关于红色报错信息

Agent 运行过程中终端可能会出现红色报错信息。这些是由 Agent 工具调用产生的，用于监看 Agent 是否能够检测并自我修正错误，**并不**影响设计流程。Agent 通常会尝试其他方案并继续正常执行。只要工作流抵达了最终汇总阶段，设计就是完整的，与中间工具调用报错无关。

### 4. 配置 Actoviq Provider

在运行 CLI 的目录中创建 Actoviq 配置，或者使用 `~/.actoviq/settings.json`。

```powershell
mkdir my-circuit-workspace
cd my-circuit-workspace
copy C:\path\to\agent.settings.example.json .\actoviq.settings.json
```

编辑 `actoviq.settings.json`，填入 provider endpoint、token 和模型名称。不要提交真实 API key。

### 5. 启动 Agent

在你希望作为 workspace 的目录中运行：

```powershell
actoviq-circuit-agent
```

当前目录会作为 workspace。输出文件会写入：

```text
./jobs/<job-id>/
./sessions/
```

TUI 中可以输入：

```text
/help
/allow execution
/design 设计一个运放增益级，后接 RC 滤波器，并输出有效低比较器告警信号。
```

使用 `/allow all` 可以自动通过所有阶段切换；使用 `/allow manual` 则每个阶段都需要确认。

### 6. 单次任务运行

```powershell
actoviq-circuit-agent --approval-policy execution --job-name rc-demo --requirement "Design a 1 kHz RC low-pass filter and output the netlist, simulation report, and SVG schematic."
```

如果从源码目录运行，把 `actoviq-circuit-agent` 替换为：

```powershell
npm run dev -- --approval-policy execution --job-name rc-demo --requirement "Design a 1 kHz RC low-pass filter and output the netlist, simulation report, and SVG schematic."
```

## 从源码运行

```powershell
npm run dev
```

默认入口会打开 TUI。你可以直接提问，也可以使用斜杠命令：

```text
/help
/allow execution
/design Design a 1 kHz RC low-pass filter
/modify Increase the output drive and redraw the schematic
```

使用旧版一次性需求输入模式：

```powershell
npm run dev -- --legacy-cli
```

源码 smoke run：

```powershell
npm run dev -- --auto-approve --job-name rc-demo --requirement "Design a 1 kHz RC low-pass filter and output the netlist, simulation report, and netlistsvg schematic."
```

## 本地可编辑 CLI

本地可编辑安装：

```powershell
npm link
actoviq-circuit-agent --help
```

使用 `npm link` 后，命令会把你运行它的目录作为 workspace root。输出路径为：

```text
./jobs/<job-id>/
./sessions/
```

可以通过环境变量覆盖 workspace root：

```powershell
$env:ACTOVIQ_CIRCUIT_AGENT_WORKSPACE_ROOT='C:\path\to\workspace'
```

## 配置加载顺序

Actoviq 配置按以下顺序加载：

1. `--config <path>` 或 `ACTOVIQ_AGENT_CONFIG_PATH`
2. 当前运行目录中的 `./agent.settings.local.json`
3. 当前运行目录中的 `./actoviq.settings.json`
4. 包源码目录中的 `agent.settings.local.json`
5. `~/.actoviq/settings.json`

不要提交真实 API key。请使用 `agent.settings.example.json` 作为模板。

## 大型电路分块

大型设计会在设计阶段按功能分块。工作流会写入 `planning/module-plan.json` 和 `design/module-manifest.json`，并在渲染阶段复用这些模块边界。最终 netlistsvg 输出是单张 SVG 图纸，包含带标签的模块/子模块区域；跨模块连接通过匹配的网络标签和可见端口表达，而不是使用很长的跨图纸连线。

## 渲染

工作流通过 netlistsvg 后端生成原理图：

- `render/netlistsvg.svg`：所有电路的主要原理图输出。

## 验证

```powershell
npm test
npm run build
npm run pack:dry-run
```