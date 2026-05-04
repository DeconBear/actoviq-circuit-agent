import { app, BrowserWindow, IpcMain } from 'electron';
import { ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

interface WorkflowEvent {
  type: string;
  stageKey?: string;
  stageName?: string;
  data?: unknown;
  timestamp: number;
}

const STAGE_LABELS: Record<string, string> = {
  'solution-analyst': 'Requirements Analysis',
  'doc-writer': 'Technical Documentation',
  librarian: 'Template Selection',
  architect: 'Architecture Planning',
  'netlist-designer': 'Netlist Design',
  'simulation-verifier': 'Simulation & Verification',
  'netlistsvg-renderer': 'Schematic Rendering',
  'workflow-lead': 'Final Summary',
};

let currentProcess: ChildProcess | null = null;
let isPaused = false;
let lastStartParams: Record<string, unknown> | null = null;

function send(win: BrowserWindow | undefined, event: WorkflowEvent): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send('workflow:event', event);
  }
}

function resolveCliPath(): string {
  if (!app.isPackaged) {
    // Use tsx's ESM CLI entry directly — avoids the bash wrapper in .bin/
    return path.resolve(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  }
  return path.resolve(PROJECT_ROOT, 'bin', 'actoviq-circuit-agent.js');
}

function resolveCliArgs(): string[] {
  if (!app.isPackaged) {
    return [path.resolve(PROJECT_ROOT, 'src', 'app.ts')];
  }
  return [];
}

function buildStageNames(stages: string[]): { key: string; name: string }[] {
  return stages.map((key) => ({
    key,
    name: STAGE_LABELS[key] ?? key,
  }));
}

const ALL_STAGE_KEYS = Object.keys(STAGE_LABELS);

// Detect tool calls from output text patterns
function detectToolCalls(text: string, win: BrowserWindow | undefined, currentStage: string): void {
  // Match patterns like: "Running tool: <name>" or "[tool] <name>" or "Tool call: <name>"
  const patterns = [
    /Running tool:\s*(\S+)/gi,
    /\[tool\]\s*(\S+)/gi,
    /Tool call:\s*(\S+)/gi,
    /Executing\s+(\S+)\s*\.\.\./gi,
    /▶\s*(\S+)/gi,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) !== null) {
      send(win, {
        type: 'tool-call',
        data: { tool: match[1], stageKey: currentStage },
        timestamp: Date.now(),
      });
    }
  }
}

function startWorkflow(win: BrowserWindow, params: Record<string, unknown>): void {
  if (currentProcess) {
    return;
  }

  lastStartParams = params;
  isPaused = false;

  send(win, {
    type: 'stage-list',
    data: { stageList: buildStageNames(ALL_STAGE_KEYS) },
    timestamp: Date.now(),
  });

  const args: string[] = [
    ...resolveCliArgs(),
    '--auto-approve',
    '--approval-policy',
    (params.approvalPolicy as string) || 'all',
    '--requirement',
    params.requirement as string,
  ];

  if (params.jobName) {
    args.push('--job-name', params.jobName as string);
  }
  if (params.configPath) {
    args.push('--config', params.configPath as string);
  }

  const cliPath = resolveCliPath();
  // In dev, use system Node.js to run tsx (Electron's process.execPath is electron.exe, not node.exe).
  // In production, use the bundled JS file which can be run with Electron's embedded Node.
  const nodeBin = app.isPackaged ? process.execPath : 'node';
  const proc = spawn(nodeBin, [cliPath, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  currentProcess = proc;

  let currentStage = '';
  let stageOutput = '';

  proc.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    if (isPaused) return;

    // Detect stage transitions
    for (const key of ALL_STAGE_KEYS) {
      const label = STAGE_LABELS[key] ?? key;
      if (text.includes(`[auto-approve:`) && text.includes(label)) {
        if (currentStage && stageOutput) {
          send(win, {
            type: 'stage-complete',
            stageKey: currentStage,
            stageName: STAGE_LABELS[currentStage] ?? currentStage,
            data: { output: stageOutput },
            timestamp: Date.now(),
          });
        }
        currentStage = key;
        stageOutput = '';
        send(win, {
          type: 'stage-start',
          stageKey: key,
          stageName: label,
          timestamp: Date.now(),
        });
        break;
      }
    }

    stageOutput += text;

    // Detect tool calls in output
    detectToolCalls(text, win, currentStage);

    send(win, {
      type: 'output',
      data: { text },
      stageKey: currentStage || undefined,
      timestamp: Date.now(),
    });
  });

  proc.stderr.on('data', (chunk: Buffer) => {
    if (isPaused) return;
    const text = chunk.toString('utf8');
    send(win, {
      type: 'output',
      data: { text, stream: 'stderr' },
      stageKey: currentStage || undefined,
      timestamp: Date.now(),
    });
  });

  proc.on('close', (code) => {
    if (currentStage && stageOutput) {
      send(win, {
        type: 'stage-complete',
        stageKey: currentStage,
        stageName: STAGE_LABELS[currentStage] ?? currentStage,
        data: { output: stageOutput },
        timestamp: Date.now(),
      });
    }
    currentStage = '';
    stageOutput = '';

    send(win, {
      type: 'workflow-complete',
      data: { exitCode: code },
      timestamp: Date.now(),
    });

    currentProcess = null;
  });

  proc.on('error', (error) => {
    send(win, {
      type: 'stage-error',
      stageKey: 'fatal',
      stageName: 'Fatal Error',
      data: { error: error.message },
      timestamp: Date.now(),
    });
    currentProcess = null;
  });
}

function killProcess(): void {
  if (currentProcess) {
    try {
      currentProcess.kill('SIGTERM');
    } catch {
      // Process may already be dead
    }
    currentProcess = null;
  }
}

export function registerWorkflowHandlers(ipcMain: IpcMain): void {
  ipcMain.on('workflow:start', (_event, params) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    startWorkflow(win, params);
  });

  ipcMain.on('workflow:pause', () => {
    isPaused = true;
  });

  ipcMain.on('workflow:resume', () => {
    isPaused = false;
  });

  ipcMain.on('workflow:stop', () => {
    killProcess();
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      send(win, {
        type: 'workflow-complete',
        data: { exitCode: -1, stopped: true },
        timestamp: Date.now(),
      });
    }
  });

  ipcMain.on('workflow:retry-stage', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    // Kill current process and restart the workflow
    killProcess();
    isPaused = false;
    if (lastStartParams) {
      // Small delay to let process cleanup complete
      setTimeout(() => startWorkflow(win, lastStartParams!), 200);
    }
  });
}
