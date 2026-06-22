import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);

function resolveEnvOrFallback(envName: string, fallbackPath: string): string {
  const configured = process.env[envName]?.trim();
  return path.resolve(configured || fallbackPath);
}

export const PROJECT_ROOT = path.resolve(currentDir, '..', '..');
export const RUNTIME_CWD = path.resolve(process.cwd());

export const ACTOVIQ_CIRCUIT_AGENT_WORKSPACE_ROOT_ENV = 'ACTOVIQ_CIRCUIT_AGENT_WORKSPACE_ROOT';
export const EMBEDDED_ROOT = path.resolve(PROJECT_ROOT, 'embedded');
export const CIRCUIT_ASSETS_ROOT = path.resolve(EMBEDDED_ROOT, 'circuit-design');
export const PYTHON_HELPERS_ROOT = path.resolve(PROJECT_ROOT, 'python');
const defaultWorkspaceRoot = RUNTIME_CWD;
export const WORKSPACE_ROOT = resolveEnvOrFallback(
  ACTOVIQ_CIRCUIT_AGENT_WORKSPACE_ROOT_ENV,
  defaultWorkspaceRoot,
);
export const JOBS_ROOT = path.resolve(WORKSPACE_ROOT, 'jobs');
export const DESIGN_MEMORY_ROOT = path.resolve(WORKSPACE_ROOT, 'references', 'design-memory');
export const SAVED_TEMPLATE_ROOT = path.resolve(DESIGN_MEMORY_ROOT, 'templates');
export const SAVED_FLOW_ROOT = path.resolve(DESIGN_MEMORY_ROOT, 'flows');

export const TEMPLATE_ROOT = path.resolve(CIRCUIT_ASSETS_ROOT, 'assets', 'templates');
export const SKIN_ROOT = path.resolve(CIRCUIT_ASSETS_ROOT, 'assets', 'skins');
export const SCRIPT_ROOT = path.resolve(CIRCUIT_ASSETS_ROOT, 'scripts');
export const TOOL_PATHS_PATH = path.resolve(CIRCUIT_ASSETS_ROOT, 'tool_paths.json');
export const REPORT_ROOT = path.resolve(PROJECT_ROOT, 'docs');
