import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { SAVED_FLOW_ROOT, SAVED_TEMPLATE_ROOT } from '../config/projectPaths.js';

export interface SavedDesignTemplateSummary {
  id: string;
  name: string;
  sourceProjectId?: string;
  sourceRevision?: number;
  rootPath: string;
  templateNetlistPath: string;
  agentGuidePath: string;
  manifestPath: string;
}

export interface SavedDesignFlowSummary {
  id: string;
  name: string;
  sourceProjectId?: string;
  sourceRevision?: number;
  rootPath: string;
  flowPath: string;
  manifestPath: string;
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function readJsonFile<T>(targetPath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(targetPath, 'utf8')) as T;
  } catch {
    return null;
  }
}

export async function listSavedDesignTemplates(
  root = SAVED_TEMPLATE_ROOT,
): Promise<SavedDesignTemplateSummary[]> {
  if (!(await exists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const templates: SavedDesignTemplateSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const rootPath = path.resolve(root, entry.name);
    const manifestPath = path.resolve(rootPath, 'template.json');
    const manifest = await readJsonFile<{
      schema?: string;
      id?: string;
      name?: string;
      source_project_id?: string;
      source_revision?: number;
    }>(manifestPath);
    if (manifest?.schema !== 'actoviq.design-template.v1') continue;
    const templateNetlistPath = path.resolve(rootPath, 'template.cir');
    const agentGuidePath = path.resolve(rootPath, 'agent-guide.md');
    templates.push({
      id: manifest.id ?? entry.name,
      name: manifest.name ?? entry.name,
      sourceProjectId: manifest.source_project_id,
      sourceRevision: manifest.source_revision,
      rootPath,
      templateNetlistPath,
      agentGuidePath,
      manifestPath,
    });
  }
  return templates.sort((left, right) => left.id.localeCompare(right.id));
}

export async function listSavedDesignFlows(root = SAVED_FLOW_ROOT): Promise<SavedDesignFlowSummary[]> {
  if (!(await exists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const flows: SavedDesignFlowSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const rootPath = path.resolve(root, entry.name);
    const manifestPath = path.resolve(rootPath, 'flow.json');
    const manifest = await readJsonFile<{
      schema?: string;
      id?: string;
      name?: string;
      source_project_id?: string;
      source_revision?: number;
    }>(manifestPath);
    if (manifest?.schema !== 'actoviq.design-flow.v1') continue;
    flows.push({
      id: manifest.id ?? entry.name,
      name: manifest.name ?? entry.name,
      sourceProjectId: manifest.source_project_id,
      sourceRevision: manifest.source_revision,
      rootPath,
      flowPath: path.resolve(rootPath, 'design-flow.md'),
      manifestPath,
    });
  }
  return flows.sort((left, right) => left.id.localeCompare(right.id));
}

export async function resolveSavedTemplateNetlist(
  templateName: string,
  root = SAVED_TEMPLATE_ROOT,
): Promise<SavedDesignTemplateSummary | null> {
  const requested = templateName.trim().replace(/\\/g, '/');
  if (!requested) return null;

  const templates = await listSavedDesignTemplates(root);
  const byId = templates.find((template) =>
    template.id === requested ||
    template.name === requested ||
    requested === `${template.id}/template.cir` ||
    requested === `design-memory/templates/${template.id}/template.cir`
  );
  if (byId && (await exists(byId.templateNetlistPath))) return byId;

  const directPath = path.resolve(root, requested);
  if (!isPathInside(root, directPath) || !(await exists(directPath))) return null;
  const ownerRoot = path.dirname(directPath);
  const manifestPath = path.resolve(ownerRoot, 'template.json');
  const manifest = await readJsonFile<{ id?: string; name?: string }>(manifestPath);
  return {
    id: manifest?.id ?? path.basename(ownerRoot),
    name: manifest?.name ?? path.basename(ownerRoot),
    rootPath: ownerRoot,
    templateNetlistPath: directPath,
    agentGuidePath: path.resolve(ownerRoot, 'agent-guide.md'),
    manifestPath,
  };
}
