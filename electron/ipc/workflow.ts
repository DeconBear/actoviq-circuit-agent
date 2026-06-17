import { app, BrowserWindow, IpcMain } from 'electron';
import { ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getActiveWorkspaceRoot } from '../workspaceState.js';

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
  'solution-analyst': '1. Solution Analyst',
  'doc-writer': '2. Doc Writer',
  librarian: '3. Librarian',
  architect: '4. Architect',
  'netlist-designer': '5. Netlist Designer',
  'simulation-verifier': '6. Simulation Verifier',
  'netlistsvg-renderer': '7. Netlistsvg Renderer',
  'workflow-lead': '8. Workflow Lead',
};

// Build a list of all stage display labels for prompt matching
const STAGE_DISPLAY_LABELS = Object.values(STAGE_LABELS);

let currentProcess: ChildProcess | null = null;
let isPaused = false;
let lastStartParams: Record<string, unknown> | null = null;
let pendingConfirmResolve: ((answer: string) => void) | null = null;

function resolvePendingConfirmation(answer: 'y' | 'n'): void {
  if (pendingConfirmResolve) {
    pendingConfirmResolve(answer);
    pendingConfirmResolve = null;
  }
}

function send(win: BrowserWindow | undefined, event: WorkflowEvent): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send('workflow:event', event);
  }
}

function resolveCliPath(): string {
  if (!app.isPackaged) {
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

// Detect the CLI's y/n confirmation prompt: "从 X 切换到 Y 前请输入 y 确认: "
function detectConfirmPrompt(text: string): { currentStage: string; nextStage: string } | null {
  // Build regex dynamically from known stage labels
  const labelPattern = STAGE_DISPLAY_LABELS.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const regex = new RegExp(
    `从\\s+(${labelPattern})\\s+切换到\\s+(${labelPattern})\\s+前请输入\\s*y\\s*确认`,
    'i',
  );
  const match = regex.exec(text);
  if (match && match[1] && match[2]) {
    return { currentStage: match[1], nextStage: match[2] };
  }
  return null;
}

async function handleConfirmPrompt(
  win: BrowserWindow,
  currentStage: string,
  nextStage: string,
): Promise<string> {
  return new Promise((resolve) => {
    pendingConfirmResolve = resolve;
    send(win, {
      type: 'confirm-request',
      data: { currentStage, nextStage },
      timestamp: Date.now(),
    });
  });
}

async function startWorkflow(win: BrowserWindow, params: Record<string, unknown>): Promise<void> {
  // Kill any previous process to ensure clean state
  if (currentProcess) {
    resolvePendingConfirmation('n');
    try {
      currentProcess.kill('SIGTERM');
    } catch { /* already dead */ }
    currentProcess = null;
  }

  lastStartParams = params;
  isPaused = false;

  send(win, {
    type: 'stage-list',
    data: { stageList: buildStageNames(ALL_STAGE_KEYS), rerunFromStage: params.rerunFromStage },
    timestamp: Date.now(),
  });

  const args: string[] = [
    ...resolveCliArgs(),
    '--auto-approve',
    '--approval-policy',
    (params.approvalPolicy as string) || 'all',
  ];

  if (params.resumeJob) {
    args.push('--resume-job', params.resumeJob as string);
  } else {
    args.push('--requirement', params.requirement as string);
  }
  if (params.revisionBaseJob) {
    args.push('--revision-base-job', params.revisionBaseJob as string);
  }
  if (params.jobParentDir) {
    args.push('--job-parent-dir', params.jobParentDir as string);
  }
  if (params.rerunFromStage) {
    args.push('--rerun-from-stage', params.rerunFromStage as string);
  }
  if (params.jobName) {
    args.push('--job-name', params.jobName as string);
  }
  if (params.configPath) {
    args.push('--config', params.configPath as string);
  }

  const cliPath = resolveCliPath();
  const nodeBin = app.isPackaged ? process.execPath : 'node';
  const workspaceRoot = await getActiveWorkspaceRoot();
  const proc = spawn(nodeBin, [cliPath, ...args], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      ACTOVIQ_CIRCUIT_AGENT_WORKSPACE_ROOT: workspaceRoot,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  currentProcess = proc;

  let currentStage = '';
  let stageOutput = '';
  let detectedJobId = '';

  proc.stdout.on('data', async (chunk: Buffer) => {
    if (currentProcess !== proc) return;
    const text = chunk.toString('utf8');
    if (isPaused) return;

    // Detect job ID from [workspace] .../jobs/<jobId> output
    if (!detectedJobId) {
      // Try multiple patterns to detect job ID from output
      const wsMatch = text.match(/\[workspace\]\s*(.+)/);
      const jobDirMatch = text.match(/[\\/]jobs[\\/]([^\\/\s]+)/);
      const jobNameMatch = text.match(/Job\s+(?:created|started|initialized)[:\s]*(\S+)/i);
      const jobId = wsMatch?.[1]?.trim()
        || jobDirMatch?.[1]?.trim()
        || jobNameMatch?.[1]?.trim();
      if (jobId) {
        detectedJobId = path.basename(jobId);
        send(win, {
          type: 'job-info',
          data: { jobId: detectedJobId },
          timestamp: Date.now(),
        });
      }
    }

    // Check for confirmation prompt BEFORE stage detection
    const confirmMatch = detectConfirmPrompt(text);
    if (confirmMatch) {
      // Complete the previous stage
      if (currentStage && stageOutput) {
        send(win, {
          type: 'stage-complete',
          stageKey: currentStage,
          stageName: STAGE_LABELS[currentStage] ?? currentStage,
          data: { output: stageOutput },
          timestamp: Date.now(),
        });
      }
      // Send output up to the prompt (without the prompt itself)
      const promptIndex = text.indexOf('从 ');
      if (promptIndex > 0) {
        send(win, {
          type: 'output',
          data: { text: text.slice(0, promptIndex) },
          stageKey: currentStage || undefined,
          timestamp: Date.now(),
        });
      }

      // Resolve next stage key from label
      const nextKey = ALL_STAGE_KEYS.find((k) => STAGE_LABELS[k] === confirmMatch.nextStage) ?? '';
      currentStage = nextKey;
      stageOutput = '';

      // Ask the renderer for confirmation
      const answer = await handleConfirmPrompt(win, confirmMatch.currentStage, confirmMatch.nextStage);

      if (answer === 'y') {
        proc.stdin.write('y\n');
        send(win, {
          type: 'stage-start',
          stageKey: nextKey,
          stageName: confirmMatch.nextStage,
          timestamp: Date.now(),
        });
      } else {
        proc.stdin.write('n\n');
        // If rejected, the CLI will handle the fallback
        send(win, {
          type: 'confirm-rejected',
          data: { currentStage: confirmMatch.currentStage, nextStage: confirmMatch.nextStage },
          timestamp: Date.now(),
        });
      }
      return;
    }

    // Detect stage transitions (auto-approve path)
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
    if (currentProcess !== proc) return;
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
    if (currentProcess !== proc) return;
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
    if (currentProcess !== proc) return;
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
    resolvePendingConfirmation('n');
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
    startWorkflow(win, params).catch((error: unknown) => {
      send(win, {
        type: 'stage-error',
        stageKey: 'fatal',
        stageName: 'Fatal Error',
        data: { error: error instanceof Error ? error.message : String(error) },
        timestamp: Date.now(),
      });
    });
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
    killProcess();
    isPaused = false;
    if (lastStartParams) {
      setTimeout(() => {
        startWorkflow(win, lastStartParams!).catch((error: unknown) => {
          send(win, {
            type: 'stage-error',
            stageKey: 'fatal',
            stageName: 'Fatal Error',
            data: { error: error instanceof Error ? error.message : String(error) },
            timestamp: Date.now(),
          });
        });
      }, 200);
    }
  });

  ipcMain.on('workflow:confirm-response', (_event, answer: 'y' | 'n') => {
    resolvePendingConfirmation(answer);
  });
}
