import { BrowserWindow, IpcMain } from 'electron';
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

function send(win: BrowserWindow | undefined, event: WorkflowEvent): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send('workflow:event', event);
  }
}

function resolveCliPath(): string {
  if (process.env.NODE_ENV === 'development' || !appIsPackaged()) {
    return path.resolve(PROJECT_ROOT, 'node_modules', '.bin', 'tsx');
  }
  return path.resolve(PROJECT_ROOT, 'bin', 'actoviq-circuit-agent.js');
}

function resolveCliArgs(): string[] {
  if (process.env.NODE_ENV === 'development' || !appIsPackaged()) {
    return [path.resolve(PROJECT_ROOT, 'src', 'app.ts')];
  }
  return [path.resolve(PROJECT_ROOT, 'bin', 'actoviq-circuit-agent.js')];
}

function appIsPackaged(): boolean {
  // In an electron-builder packaged app, app.isPackaged is true
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron');
    return app.isPackaged;
  } catch {
    return false;
  }
}

function buildStageNames(stages: string[]): { key: string; name: string }[] {
  return stages.map((key) => ({
    key,
    name: STAGE_LABELS[key] ?? key,
  }));
}

const ALL_STAGE_KEYS = Object.keys(STAGE_LABELS);

export function registerWorkflowHandlers(ipcMain: IpcMain): void {
  ipcMain.on('workflow:start', (_event, params) => {
    if (currentProcess) {
      return;
    }

    const win = BrowserWindow.getAllWindows()[0];
    isPaused = false;

    // Emit stage list so the UI can build the stepper
    send(win, {
      type: 'stage-list',
      data: { stageList: buildStageNames(ALL_STAGE_KEYS) },
      timestamp: Date.now(),
    });

    // Build CLI args
    const args: string[] = [
      ...resolveCliArgs(),
      '--auto-approve',
      '--approval-policy',
      params.approvalPolicy || 'all',
      '--requirement',
      params.requirement,
    ];

    if (params.jobName) {
      args.push('--job-name', params.jobName);
    }
    if (params.configPath) {
      args.push('--config', params.configPath);
    }

    const cliPath = resolveCliPath();
    const proc = spawn(process.execPath, [cliPath, ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NO_COLOR: '1',  // Strip ANSI so we can parse cleanly
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

      // Detect stage transitions from output patterns
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

      // Stream output for the chat/log view
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
      // Emit final stage completion
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
  });

  ipcMain.on('workflow:pause', () => {
    isPaused = true;
  });

  ipcMain.on('workflow:resume', () => {
    isPaused = false;
  });

  ipcMain.on('workflow:retry-stage', () => {
    // Not supported in child_process mode; restart the workflow
  });
}
