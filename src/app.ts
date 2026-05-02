#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { startInteractiveCli } from './cli/startInteractiveCli.js';
import {
  ACTOVIQ_CIRCUIT_AGENT_WORKSPACE_ROOT_ENV,
  CIRCUIT_ASSETS_ROOT,
  PROJECT_ROOT,
  RUNTIME_CWD,
  TOOL_PATHS_PATH,
  WORKSPACE_ROOT,
} from './config/projectPaths.js';
import { validateRuntimePaths } from './config/validateRuntimePaths.js';
import { startTuiApp } from './tui/TuiApp.js';
import { formatErrorMessage, writeError, writeStderr, writeStdout } from './utils/runtimeSupport.js';
import type { ApprovalPolicy } from './workflow/circuitDesignWorkflow.js';

interface CliOptions {
  requirement?: string;
  requirementFile?: string;
  autoApprove: boolean;
  approvalPolicy?: ApprovalPolicy;
  jobName?: string;
  configPath?: string;
  resumeJob?: string;
  legacyCli: boolean;
  showHelp: boolean;
  showVersion: boolean;
  error?: string;
}

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const packageJsonPath = path.resolve(currentDir, '..', 'package.json');
const packageVersion = JSON.parse(readFileSync(packageJsonPath, 'utf8')).version as string;

function printHelp(): void {
  writeStdout(
    [
      'actoviq-circuit-agent',
      '',
      'Usage:',
      '  actoviq-circuit-agent [options]',
      '',
      'Options:',
      '  --requirement <text>   Start the workflow with a requirement string.',
      '  --requirement-file <path> Load the requirement text from a UTF-8 file.',
      '  --job-name <name>      Provide a naming hint for the generated English job slug.',
      '  --config <path>        Load an explicit Actoviq JSON config file.',
      '  --resume-job <id|path> Resume an existing workflow job from the first incomplete stage.',
      '  --auto-approve         Skip y-confirmation between agent stages.',
      '  --approval-policy <mode> manual | execution | all.',
      '  --legacy-cli, --no-tui  Use the previous one-shot readline requirement prompt.',
      '  -h, --help             Show this help text.',
      '  -v, --version          Show the CLI version.',
      '',
      'Environment:',
      '  ACTOVIQ_AGENT_CONFIG_PATH              Explicit Actoviq config path.',
      `  ${ACTOVIQ_CIRCUIT_AGENT_WORKSPACE_ROOT_ENV}   Workspace root override.`,
      '  NGSPICE_BIN                            Override ngspice executable path.',
      '',
      'Defaults:',
      `  Package root: ${PROJECT_ROOT}`,
      `  Current working directory: ${RUNTIME_CWD}`,
      `  Workspace root: ${WORKSPACE_ROOT}`,
      `  Bundled circuit assets: ${CIRCUIT_ASSETS_ROOT}`,
      `  Bundled tool path config: ${TOOL_PATHS_PATH}`,
      '  Debug config fallback: <workspace>/actoviq.settings.json',
      '',
      'Examples:',
      '  actoviq-circuit-agent',
      '  actoviq-circuit-agent --requirement "Design a 1 kHz RC low-pass filter"',
      '  actoviq-circuit-agent --auto-approve --job-name rc-demo',
      '  actoviq-circuit-agent --resume-job 20260409-215611-lna-full-regression',
    ].join('\n'),
  );
  writeStdout('\n');
}

type BooleanCliKey = 'autoApprove' | 'legacyCli' | 'showHelp' | 'showVersion';
type ValueCliKey = 'requirement' | 'requirementFile' | 'jobName' | 'configPath' | 'resumeJob';

const BOOLEAN_FLAGS: Record<string, BooleanCliKey> = {
  '--auto-approve': 'autoApprove',
  '--legacy-cli': 'legacyCli',
  '--no-tui': 'legacyCli',
  '--help': 'showHelp',
  '-h': 'showHelp',
  '--version': 'showVersion',
  '-v': 'showVersion',
};

const VALUE_FLAGS: Record<string, ValueCliKey> = {
  '--requirement': 'requirement',
  '--requirement-file': 'requirementFile',
  '--job-name': 'jobName',
  '--config': 'configPath',
  '--resume-job': 'resumeJob',
};

function readFlagValue(argv: string[], index: number, arg: string): { value?: string; error?: string } {
  const value = argv[index + 1];
  if (!value || value.startsWith('-')) {
    return { error: `missing value for ${arg}` };
  }
  return { value };
}

export function parseCliOptions(argv: string[]): CliOptions {
  const options: CliOptions = {
    autoApprove: false,
    legacyCli: false,
    showHelp: false,
    showVersion: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const booleanKey = BOOLEAN_FLAGS[arg];
    if (booleanKey) {
      options[booleanKey] = true;
      continue;
    }

    if (arg === '--approval-policy') {
      const { value, error } = readFlagValue(argv, index, arg);
      if (error || value === undefined) {
        options.error = error;
        break;
      }
      if (value !== 'manual' && value !== 'execution' && value !== 'all') {
        options.error = '--approval-policy must be manual, execution, or all';
        break;
      }
      options.approvalPolicy = value;
      index += 1;
      continue;
    }

    const valueKey = VALUE_FLAGS[arg];
    if (valueKey) {
      const { value, error } = readFlagValue(argv, index, arg);
      if (error || value === undefined) {
        options.error = error;
        break;
      }
      options[valueKey] = value;
      index += 1;
      continue;
    }

    options.error = `unknown argument: ${arg}`;
    break;
  }

  return options;
}

function checkNgspice(): void {
  const envBin = process.env.NGSPICE_BIN?.trim();
  if (envBin) {
    writeStdout(`ngspice: ${envBin} (from NGSPICE_BIN)\n`);
    return;
  }

  try {
    const raw = readFileSync(TOOL_PATHS_PATH, 'utf8');
    const toolPaths = JSON.parse(raw) as { ngspice_bin?: string };
    if (toolPaths.ngspice_bin?.trim()) {
      writeStdout(`ngspice: ${toolPaths.ngspice_bin} (from tool_paths.json)\n`);
      return;
    }
  } catch {
    // tool_paths.json not readable, continue
  }

  try {
    const result = execSync('command -v ngspice', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (result) {
      writeStdout(`ngspice: ${result} (from PATH)\n`);
      return;
    }
  } catch {
    // not in PATH
  }

  writeStdout('\n');
  writeStdout('-- ngspice not found --------------------------------------------------------\n');
  writeStdout('  The simulation stage requires ngspice. Set it via one of:\n');
  writeStdout('    1. Environment variable: set NGSPICE_BIN=/path/to/ngspice\n');
  writeStdout('    2. Config file: edit embedded/circuit-design/tool_paths.json -> ngspice_bin\n');
  writeStdout('    3. Add ngspice to your system PATH\n');
  writeStdout('  Download: https://ngspice.sourceforge.net/download.html\n');
  writeStdout('-----------------------------------------------------------------------------\n');
  writeStdout('\n');
}

export async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  if (options.error) {
    writeError(`Error: ${options.error}\n\n`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  if (options.showVersion) {
    writeStdout(`${packageVersion}\n`);
    return;
  }

  if (options.showHelp) {
    printHelp();
    return;
  }

  if (options.configPath?.trim()) {
    process.env.ACTOVIQ_AGENT_CONFIG_PATH = path.resolve(options.configPath.trim());
  }

  if (options.requirement && options.requirementFile) {
    writeError('Error: use either --requirement or --requirement-file, not both.\n');
    process.exitCode = 1;
    return;
  }

  const requirementFromFile = options.requirementFile?.trim()
    ? readFileSync(path.resolve(options.requirementFile.trim()), 'utf8')
    : undefined;

  const pathStatus = await validateRuntimePaths();
  const missing = pathStatus.filter((entry) => !entry.exists);
  if (missing.length > 0) {
    writeError('Missing required runtime paths:\n');
    for (const entry of missing) {
      const suffix = entry.envVar ? ` (set ${entry.envVar})` : '';
      writeError(`- ${entry.label}: ${entry.targetPath}${suffix}\n`);
    }
    writeStderr('\n');
    writeError('The CLI now bundles its circuit assets, but required packaged runtime files are missing.\n');
    process.exitCode = 1;
    return;
  }

  checkNgspice();

  writeStdout(`actoviq-circuit-agent v${packageVersion}\n`);
  writeStdout(`workspace: ${WORKSPACE_ROOT}\n`);
  if (!options.legacyCli && !options.requirement && !options.requirementFile && !options.resumeJob) {
    await startTuiApp();
    return;
  }

  writeStdout(
    'interactive mode: enter a natural-language requirement; type y before stage transitions; netlist-to-simulation runs as a closed loop.\n',
  );

  await startInteractiveCli({
    requirement: requirementFromFile ?? options.requirement,
    autoApprove: options.autoApprove,
    approvalPolicy: options.approvalPolicy,
    jobName: options.jobName,
    resumeJob: options.resumeJob,
  });

  if (options.autoApprove || options.requirement || options.requirementFile || options.resumeJob) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    process.exit(process.exitCode ?? 0);
  }
}

const isDirectRun = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isDirectRun) {
  main().catch((error) => {
    const message = error instanceof Error && error.stack ? error.stack : formatErrorMessage(error);
    writeError(`${message}\n`);
    process.exitCode = 1;
  });
}
