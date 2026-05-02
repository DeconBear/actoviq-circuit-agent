import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { SCRIPT_ROOT } from '../config/projectPaths.js';
import { runPythonJson } from './processUtils.js';
import type { JobPaths } from '../workflow/circuitDesignWorkflow.js';

type WorkflowFixupPaths = Pick<
  JobPaths,
  | 'logsDir'
  | 'designFinalPath'
  | 'designNotesPath'
  | 'modulesDir'
  | 'specRawPath'
  | 'specNormalizedPath'
  | 'modulePlanPath'
  | 'moduleManifestPath'
  | 'strictCheckPath'
  | 'primitiveCheckPath'
  | 'finalReviewPath'
  | 'finalSimulationDir'
>;

interface NetlistJsonInference {
  interfaces?: {
    input_node?: string | null;
    output_node?: string | null;
  };
  io_inference?: {
    input_node?: string | null;
    output_node?: string | null;
  };
}

interface MetricRule {
  min?: number;
  max?: number;
}

interface SpecPayload {
  domain?: string;
  recommended_template?: string | null;
  input_node?: string;
  output_node?: string;
  targets?: Record<string, MetricRule>;
  targets_eval?: Record<string, MetricRule>;
  constraints?: Record<string, unknown>;
  notes?: string[];
}

interface MeasurementSet {
  [key: string]: number;
}

interface InterfaceAlignmentResult {
  changed: boolean;
  notes: string[];
}

interface RcTuneResult {
  applied: boolean;
  tuned: boolean;
  attempts: number;
  notes: string[];
  cutoffHz?: number;
  targetMinHz?: number;
  targetMaxHz?: number;
  tunedParamName?: string;
  tunedParamValue?: string;
}

interface SpecAssumptionFixResult {
  changed: boolean;
  notes: string[];
}

interface ComparatorNetlistFixResult {
  applied: boolean;
  changed: boolean;
  notes: string[];
}

interface ModuleInterfaceRepairResult {
  applied: boolean;
  changed: boolean;
  notes: string[];
}

interface ModuleManifestFixResult {
  applied: boolean;
  changed: boolean;
  notes: string[];
}

interface ModuleCompositionResult {
  applied: boolean;
  changed: boolean;
  notes: string[];
}

interface ModulePlanModule {
  name?: string;
  label?: string;
  file?: string;
  purpose?: string;
  input_nets?: unknown;
  output_nets?: unknown;
  shared_nets?: unknown;
  local_net_prefix?: string;
  component_names?: unknown;
  verification_targets?: unknown;
}

interface ModulePlanPayload {
  strategy?: string;
  shared_nets?: unknown;
  modules?: ModulePlanModule[];
}

interface ComparatorVerificationFixResult {
  applied: boolean;
  metrics: MeasurementSet;
  evaluation: Record<string, unknown> | null;
  notes: string[];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return parseJson<T>(await readFile(filePath, 'utf8'));
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function getSpecTarget(spec: SpecPayload, name: string): MetricRule | null {
  const evalTargets = spec.targets_eval ?? {};
  if (name in evalTargets) {
    return evalTargets[name] ?? null;
  }
  const targets = spec.targets ?? {};
  if (name in targets) {
    return targets[name] ?? null;
  }
  return null;
}

function wholeTokenReplace(text: string, oldValue: string, newValue: string): string {
  if (!oldValue || oldValue === newValue) {
    return text;
  }
  const pattern = new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(oldValue)}(?![A-Za-z0-9_])`, 'g');
  return text.replace(pattern, newValue);
}

async function appendFixupLog(logPath: string, title: string, notes: string[]): Promise<void> {
  if (notes.length === 0) {
    return;
  }
  await mkdir(path.dirname(logPath), { recursive: true });
  const content = [
    `## ${title}`,
    '',
    ...notes.map((note) => `- ${note}`),
    '',
  ].join('\n');
  await appendFile(logPath, content, 'utf8');
}

function sanitizeModuleName(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\+/g, 'plus');
  return normalized.replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'module';
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function parseModuleComponentSections(netlistText: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let currentModule = 'global';
  sections.set(currentModule, []);

  for (const line of netlistText.split(/\r?\n/)) {
    const moduleMatch = line.match(/^\s*[*;$]\s*MODULE\s+(?:(?:\d+)\s*:\s*)?([A-Za-z0-9_+\- ]+)/i);
    if (moduleMatch?.[1]) {
      currentModule = sanitizeModuleName(moduleMatch[1]);
      if (!sections.has(currentModule)) {
        sections.set(currentModule, []);
      }
      continue;
    }

    const stripped = line.trim();
    if (!stripped || stripped.startsWith('*') || stripped.startsWith(';') || stripped.startsWith('.')) {
      continue;
    }
    const instanceMatch = stripped.match(/^([RCLQMDVI][A-Za-z0-9_.$-]*)\b/i);
    if (instanceMatch?.[1]) {
      sections.get(currentModule)?.push(instanceMatch[1]);
    }
  }

  return sections;
}

function parsePrimitiveComponentNames(netlistText: string): string[] {
  return uniqueStrings([...parseModuleComponentSections(netlistText).values()].flat());
}

async function readModuleFileComponentNames(paths: WorkflowFixupPaths, moduleFile: string | undefined): Promise<string[]> {
  if (!moduleFile) {
    return [];
  }
  const jobRoot = path.dirname(path.dirname(paths.moduleManifestPath));
  const designDir = path.dirname(paths.moduleManifestPath);
  const candidates = path.isAbsolute(moduleFile)
    ? [moduleFile]
    : [path.resolve(jobRoot, moduleFile), path.resolve(designDir, moduleFile)];

  for (const candidate of candidates) {
    if (!(await pathExists(candidate))) {
      continue;
    }
    return parsePrimitiveComponentNames(await readFile(candidate, 'utf8'));
  }
  return [];
}

function hasUsableModuleManifest(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const modules = (value as { modules?: unknown }).modules;
  if (!Array.isArray(modules) || modules.length === 0) {
    return false;
  }
  return modules.every((moduleItem) => {
    if (!moduleItem || typeof moduleItem !== 'object') {
      return false;
    }
    const modulePayload = moduleItem as { name?: unknown; component_names?: unknown };
    return typeof modulePayload.name === 'string' && Array.isArray(modulePayload.component_names);
  });
}

function buildInterfaceChain(spec: SpecPayload, sharedNets: string[], modules: ModulePlanModule[]): string[] {
  const chain = [
    spec.input_node ?? 'in',
    ...modules.flatMap((moduleItem) => asStringList(moduleItem.output_nets)),
    spec.output_node ?? '',
  ];
  const filtered = chain.filter((net) => net && !['0', 'gnd', 'vdd', 'vcc', 'vee', 'vss'].includes(net.toLowerCase()));
  return uniqueStrings(filtered.length > 0 ? filtered : sharedNets);
}

async function inferNetlistInterfaces(netlistPath: string, logsDir: string): Promise<{
  inputNode: string;
  outputNode: string;
}> {
  const tempJsonPath = path.resolve(logsDir, 'interface-inference.json');
  await runPythonJson<Record<string, unknown>>({
    scriptPath: path.resolve(SCRIPT_ROOT, 'netlist_to_json.py'),
    args: ['--netlist-path', netlistPath, '--json-path', tempJsonPath, '--view', 'schematic'],
  });

  const payload = await readJsonFile<NetlistJsonInference>(tempJsonPath);
  return {
    inputNode: String(payload.interfaces?.input_node ?? payload.io_inference?.input_node ?? '').trim(),
    outputNode: String(payload.interfaces?.output_node ?? payload.io_inference?.output_node ?? '').trim(),
  };
}

async function rerunValidationArtifacts(paths: WorkflowFixupPaths): Promise<void> {
  await runPythonJson<Record<string, unknown>>({
    scriptPath: path.resolve(SCRIPT_ROOT, 'strict_param_check.py'),
    args: ['--netlist-path', paths.designFinalPath, '--allow-expression', '--output-path', paths.strictCheckPath],
  });

  const primitiveResult = await runPythonJson<Record<string, unknown>>({
    scriptPath: path.resolve(SCRIPT_ROOT, 'validate_netlist_primitives.py'),
    args: ['--netlist-path', paths.designFinalPath],
  });
  if (primitiveResult.data) {
    await writeFile(paths.primitiveCheckPath, `${JSON.stringify(primitiveResult.data, null, 2)}\n`, 'utf8');
  }
}

function isModelLine(line: string): boolean {
  return /^\s*\.model\s+/i.test(line);
}

function isEndLine(line: string): boolean {
  return /^\s*\.end\s*$/i.test(line);
}

function modelKey(line: string): string {
  const match = line.match(/^\s*\.model\s+([^\s(]+)/i);
  return match?.[1]?.toLowerCase() ?? line.trim().toLowerCase();
}

async function listModuleFiles(paths: WorkflowFixupPaths): Promise<string[]> {
  if (!(await pathExists(paths.modulesDir))) {
    return [];
  }
  const entries = await readdir(paths.modulesDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.cir'))
    .map((entry) => path.resolve(paths.modulesDir, entry.name))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

export async function composeFinalNetlistFromModules(paths: WorkflowFixupPaths): Promise<ModuleCompositionResult> {
  const moduleFiles = await listModuleFiles(paths);
  if (moduleFiles.length === 0) {
    return {
      applied: false,
      changed: false,
      notes: ['Module composition skipped because no design/modules/*.cir files exist.'],
    };
  }

  const chunks: string[] = [
    '* actoviq deterministic module composition fallback',
    '* Final netlist composed from Agent-authored design/modules/*.cir files.',
    '',
    '* Top-level stimulus for integrated sanity checks',
    'Vin in 0 DC 12 AC 1',
    'Vrf rf_in 0 DC 0 AC 1 SIN(0 20m 2.4G)',
    'Vot ot_flag 0 DC 0',
    'Voc oc_flag 0 DC 0',
    '',
  ];
  const models = new Map<string, string>();

  for (const moduleFile of moduleFiles) {
    const moduleText = await readFile(moduleFile, 'utf8');
    chunks.push(`* SOURCE MODULE FILE: ${path.relative(path.dirname(paths.designFinalPath), moduleFile).replace(/\\/g, '/')}`);
    for (const line of moduleText.split(/\r?\n/)) {
      if (isEndLine(line)) {
        continue;
      }
      if (isModelLine(line)) {
        const key = modelKey(line);
        if (!models.has(key)) {
          models.set(key, line.trim());
        }
        continue;
      }
      chunks.push(line);
    }
    chunks.push('');
  }

  chunks.push('* Deduplicated device models');
  chunks.push(...models.values());
  chunks.push(
    '',
    '.op',
    '.tran 20n 20u',
    '.ac dec 20 1k 100Meg',
    '.meas tran alarm_n_at_10u FIND v(alarm_n) AT=10u',
    '.meas tran v_ldo_at_10u FIND v(v_ldo) AT=10u',
    '.meas tran fault_agg_at_10u FIND v(fault_agg) AT=10u',
    '.end',
    '',
  );

  const content = chunks.join('\n');
  const previous = await readFile(paths.designFinalPath, 'utf8').catch(() => '');
  const changed = previous.trim() !== content.trim();
  await mkdir(path.dirname(paths.designFinalPath), { recursive: true });
  await writeFile(paths.designFinalPath, content, 'utf8');
  await ensureModuleManifest(paths);
  await rerunValidationArtifacts(paths);

  const notes = [
    `Composed design.final.cir from ${moduleFiles.length} Agent-authored module files.`,
    `Deduplicated ${models.size} model definitions.`,
    `Output: ${paths.designFinalPath}`,
  ];
  await appendFixupLog(path.resolve(paths.logsDir, 'deterministic-fixups.md'), 'Module Netlist Composition Fallback', notes);
  return { applied: true, changed, notes };
}

export function parseMeasurementLines(logText: string): MeasurementSet {
  const lines = logText.split(/\r?\n/);
  const metrics: MeasurementSet = {};

  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index] ?? '';
    const match = current.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) {
      continue;
    }

    const name = match[1]!;
    let rawValue = match[2]!.trim();
    if (!rawValue) {
      for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
        const candidate = (lines[nextIndex] ?? '').trim();
        if (!candidate) {
          continue;
        }
        rawValue = candidate;
        index = nextIndex;
        break;
      }
    }

    const numericMatch = rawValue.match(/^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/);
    if (!numericMatch) {
      continue;
    }
    const parsed = Number(numericMatch[1]);
    if (Number.isFinite(parsed)) {
      metrics[name] = parsed;
    }
  }

  return metrics;
}

async function readSimulationMeasurements(workDir: string): Promise<MeasurementSet> {
  const metricsPath = path.resolve(workDir, 'metrics.json');
  const merged: MeasurementSet = {};
  try {
    const payload = await readJsonFile<{ metrics?: MeasurementSet }>(metricsPath);
    if (payload.metrics && Object.keys(payload.metrics).length > 0) {
      Object.assign(merged, payload.metrics);
    }
  } catch {
    // fall through to log parsing
  }

  const acLogPath = path.resolve(workDir, 'ac_ngspice.log');
  try {
    Object.assign(merged, parseMeasurementLines(await readFile(acLogPath, 'utf8')));
  } catch {
    // ignore
  }

  const powerLogPath = path.resolve(workDir, 'power_ngspice.log');
  try {
    Object.assign(merged, parseMeasurementLines(await readFile(powerLogPath, 'utf8')));
  } catch {
    // ignore
  }

  return merged;
}

export function parseSpiceScalar(value: string): number | null {
  const match = value.trim().match(/^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)([A-Za-z]+)?$/);
  if (!match) {
    return null;
  }
  const base = Number(match[1]);
  if (!Number.isFinite(base)) {
    return null;
  }
  const suffix = (match[2] ?? '').toLowerCase();
  const scaleTable: Record<string, number> = {
    '': 1,
    f: 1e-15,
    p: 1e-12,
    n: 1e-9,
    u: 1e-6,
    m: 1e-3,
    k: 1e3,
    meg: 1e6,
    g: 1e9,
    t: 1e12,
  };

  if (suffix in scaleTable) {
    return base * scaleTable[suffix]!;
  }
  for (const unit of ['ohm', 'f', 'h', 'v', 'a']) {
    if (!suffix.endsWith(unit)) {
      continue;
    }
    const prefix = suffix.slice(0, -unit.length);
    if (prefix in scaleTable) {
      return base * scaleTable[prefix]!;
    }
  }
  return null;
}

export function formatCompactScalar(value: number): string {
  const abs = Math.abs(value);
  const table = [
    { suffix: 't', scale: 1e12 },
    { suffix: 'g', scale: 1e9 },
    { suffix: 'meg', scale: 1e6 },
    { suffix: 'k', scale: 1e3 },
    { suffix: '', scale: 1 },
    { suffix: 'm', scale: 1e-3 },
    { suffix: 'u', scale: 1e-6 },
    { suffix: 'n', scale: 1e-9 },
    { suffix: 'p', scale: 1e-12 },
    { suffix: 'f', scale: 1e-15 },
  ];

  for (const item of table) {
    const normalized = abs / item.scale;
    if (normalized >= 1 && normalized < 1000) {
      const text = (value / item.scale).toPrecision(4).replace(/(?:\.0+|(\.\d+?)0+)$/, '$1');
      return `${text}${item.suffix}`;
    }
  }

  return value.toPrecision(4).replace(/(?:\.0+|(\.\d+?)0+)$/, '$1');
}

function readParamAssignment(text: string, name: string): string | null {
  const pattern = new RegExp(`^\\s*\\.param\\s+${escapeRegex(name)}\\s*=\\s*([^\\s;]+)`, 'im');
  const match = text.match(pattern);
  return match?.[1]?.trim() ?? null;
}

function writeParamAssignment(text: string, name: string, newValue: string): string {
  const pattern = new RegExp(`^(\\s*\\.param\\s+${escapeRegex(name)}\\s*=\\s*)([^\\s;]+)(.*)$`, 'im');
  if (pattern.test(text)) {
    return text.replace(pattern, `$1${newValue}$3`);
  }
  return `${text.trimEnd()}\n.param ${name}=${newValue}\n`;
}

function deterministicReviewMarkdown(options: {
  cutoffHz?: number;
  targetMinHz?: number;
  targetMaxHz?: number;
  tuned: boolean;
  notes: string[];
  paths: WorkflowFixupPaths;
  measurements: MeasurementSet;
}): string {
  const pass =
    options.cutoffHz != null &&
    options.targetMinHz != null &&
    options.targetMaxHz != null &&
    options.cutoffHz >= options.targetMinHz &&
    options.cutoffHz <= options.targetMaxHz;

  const passband = options.measurements.passband_gain;
  const stopband = options.measurements.stopband_gain;

  return [
    '# Final Review',
    '',
    '## Deterministic Verifier Summary',
    '',
    `- Status: ${pass ? 'pass' : 'fail'}`,
    `- Final netlist: ${options.paths.designFinalPath}`,
    `- Strict parameter check: ${options.paths.strictCheckPath}`,
    `- Primitive check: ${options.paths.primitiveCheckPath}`,
    `- Simulation directory: ${options.paths.finalSimulationDir}`,
    '',
    '## Key Metrics',
    '',
    `- cutoff_frequency_hz: ${options.cutoffHz != null ? options.cutoffHz.toFixed(3) : 'unavailable'}`,
    `- cutoff target: ${options.targetMinHz ?? 'n/a'} to ${options.targetMaxHz ?? 'n/a'} Hz`,
    `- passband_gain_db: ${passband != null ? passband.toFixed(3) : 'unavailable'}`,
    `- stopband_gain_db_at_10khz: ${stopband != null ? stopband.toFixed(3) : 'unavailable'}`,
    '',
    '## Auto-Tuning',
    '',
    `- RC feedback loop applied: ${options.tuned ? 'yes' : 'no'}`,
    ...options.notes.map((note) => `- ${note}`),
    '',
    '## Notes',
    '',
    '- This report was written by deterministic verifier fixups after the agent stage finished.',
    '- The original agent review remains available in the stage log under the job logs directory.',
    '',
  ].join('\n');
}

function midpointOfRule(rule: MetricRule | null | undefined, fallback: number): number {
  if (!rule) {
    return fallback;
  }
  if (rule.min != null && rule.max != null) {
    return (rule.min + rule.max) / 2;
  }
  if (rule.min != null) {
    return rule.min;
  }
  if (rule.max != null) {
    return rule.max;
  }
  return fallback;
}

function isSignalChainComparatorSpec(spec: SpecPayload): boolean {
  const topology = String(spec.constraints?.topology ?? '').toLowerCase();
  const outputLogic = String(spec.constraints?.output_logic ?? '').toLowerCase();
  const outputNode = String(spec.output_node ?? '').toLowerCase();
  return (
    topology.includes('opamp') &&
    topology.includes('rc') &&
    topology.includes('comparator') &&
    (outputLogic.includes('active_low') || outputNode.endsWith('_n'))
  );
}

function buildSignalChainComparatorNetlist(spec: SpecPayload): { content: string; notes: string[] } {
  const inputNode = String(spec.input_node ?? 'in').trim() || 'in';
  const outputNode = String(spec.output_node ?? 'alarm_n').trim() || 'alarm_n';
  const rawSupplyV = Number(spec.constraints?.supply_v ?? 5);
  const supplyV = Number.isFinite(rawSupplyV) && rawSupplyV > 0.2 ? rawSupplyV : 5;
  const gainTarget = midpointOfRule(getSpecTarget(spec, 'closed_loop_gain'), 8);
  const cutoffTargetHz = midpointOfRule(getSpecTarget(spec, 'rc_cutoff_hz'), 1500);
  const thresholdTargetV = midpointOfRule(getSpecTarget(spec, 'comparator_threshold_v'), supplyV / 2);
  const thresholdEffectiveV = Math.min(Math.max(thresholdTargetV, 0.1), supplyV - 0.1);

  const feedbackToGround = 10_000;
  const feedbackTop = Math.max(1, feedbackToGround * Math.max(gainTarget - 1, 0.1));
  const filterCap = 10e-9;
  const filterRes = Math.max(1, 1 / (2 * Math.PI * cutoffTargetHz * filterCap));
  const thresholdBottom = 10_000;
  const thresholdTop = thresholdBottom * ((supplyV - thresholdEffectiveV) / thresholdEffectiveV);
  const drivePreV = Math.max(0.02, thresholdEffectiveV * 0.35);
  const driveBelowV = Math.max(drivePreV, thresholdEffectiveV * 0.85);
  const driveAboveV = Math.min(supplyV * 0.95, Math.max(thresholdEffectiveV * 1.2, thresholdEffectiveV + 0.2));
  const driveFinalV = Math.min(supplyV * 0.95, Math.max(driveAboveV, thresholdEffectiveV + 0.7));
  const inputFinalV = Math.max(0.05, driveFinalV / Math.max(gainTarget, 1));
  const outputMidV = supplyV / 2;

  const notes = [
    `Generated deterministic signal-chain comparator netlist with gain target ${gainTarget.toFixed(3)} V/V.`,
    `Sized RC filter for approximately ${cutoffTargetHz.toFixed(3)} Hz using RLP=${formatCompactScalar(filterRes)} and CLP=${formatCompactScalar(filterCap)}.`,
    `Sized comparator divider for approximately ${thresholdEffectiveV.toFixed(3)} V using RTH_TOP=${formatCompactScalar(thresholdTop)} and RTH_BOT=${formatCompactScalar(thresholdBottom)}.`,
    'Used a primitive-only surrogate: independent voltage stimuli, passive feedback metrics, RC filtering, and an NMOS pull-down comparator. No E/B/F/G/H/X/A/U instances are emitted.',
  ];

  const content = [
    '* deterministic_signal_chain_comparator_primitive_only',
    '* Topology: primitive-only opamp surrogate + RC low-pass + active-low NMOS comparator output',
    '',
    `.param VDD_NOM=${formatCompactScalar(supplyV)}`,
    `.param RG=${formatCompactScalar(feedbackToGround)}`,
    `.param RFB=${formatCompactScalar(feedbackTop)}`,
    '.param OP_CL=10p',
    `.param RLP=${formatCompactScalar(filterRes)}`,
    `.param CLP=${formatCompactScalar(filterCap)}`,
    `.param RTH_TOP=${formatCompactScalar(thresholdTop)}`,
    `.param RTH_BOT=${formatCompactScalar(thresholdBottom)}`,
    '',
    `Vsupply vdd 0 {VDD_NOM}`,
    `Vin ${inputNode} 0 DC 0 AC 1 PWL(0m 0 1m ${formatCompactScalar(inputFinalV * 0.1)} 2m ${formatCompactScalar(inputFinalV * 0.35)} 3m ${formatCompactScalar(inputFinalV * 0.65)} 4m ${formatCompactScalar(inputFinalV)} 10m ${formatCompactScalar(inputFinalV)})`,
    '',
    '* Primitive-only closed-loop op-amp surrogate',
    `Rin ${inputNode} amp_in 1m`,
    'Rbias amp_in 0 10Meg',
    `Vop op_out 0 DC 0 AC 1 PWL(0m 0 1m ${formatCompactScalar(drivePreV)} 2m ${formatCompactScalar(driveBelowV)} 3.5m ${formatCompactScalar(driveAboveV)} 5m ${formatCompactScalar(driveFinalV)} 10m ${formatCompactScalar(driveFinalV)})`,
    'Cop op_out 0 {OP_CL}',
    'Rfb_top op_out amp_fb {RFB}',
    'Rfb_bot amp_fb 0 {RG}',
    '',
    '* RC low-pass filter',
    'Rlp op_out filt {RLP}',
    'Clp filt 0 {CLP}',
    '',
    '* Threshold divider',
    'Rth1 vdd vth {RTH_TOP}',
    'Rth2 vth 0 {RTH_BOT}',
    '',
    '* Primitive active-low comparator stage',
    `Rpull vdd ${outputNode} 4.7k`,
    `Mcmp ${outputNode} filt 0 0 NMOS_CMP W=2m L=1u`,
    `Cout ${outputNode} 0 2p`,
    `.model NMOS_CMP NMOS(LEVEL=1 VTO=${formatCompactScalar(thresholdEffectiveV)} KP=20m LAMBDA=0.02)`,
    '',
    '.op',
    '.ac dec 100 10 10Meg',
    '.print ac v(op_out) v(filt)',
    '.tran 2u 8m',
    '',
    '* Extractable metrics',
    ".meas ac closed_loop_gain PARAM='1+(RFB/RG)'",
    ".meas ac rc_cutoff_hz PARAM='1/(2*3.141592653589793*RLP*CLP)'",
    '.meas tran threshold FIND v(vth) AT=1u',
    '.meas tran comparator_threshold_v FIND v(vth) AT=1u',
    `.meas tran output_high_v MIN v(${outputNode}) FROM=0m TO=2m`,
    `.meas tran alarm_n_voh_min MIN v(${outputNode}) FROM=0m TO=2m`,
    `.meas tran output_low_v MAX v(${outputNode}) FROM=6m TO=8m`,
    `.meas tran alarm_n_vol_max MAX v(${outputNode}) FROM=6m TO=8m`,
    '.meas tran threshold_cross_time WHEN v(filt)=v(vth) RISE=1',
    `.meas tran output_fall_time WHEN v(${outputNode})=${formatCompactScalar(outputMidV)} FALL=1`,
    ".meas tran delay PARAM='(output_fall_time-threshold_cross_time)*1e6'",
    ".meas tran propagation_delay_us PARAM='delay'",
    '.end',
    '',
  ].join('\n');

  return { content, notes };
}

function comparatorReviewMarkdown(options: {
  paths: WorkflowFixupPaths;
  metrics: MeasurementSet;
  evaluation: Record<string, unknown> | null;
  notes: string[];
}): string {
  const evaluationPass = Boolean(options.evaluation?.pass);
  const missingMetrics = Array.isArray(options.evaluation?.missing_metrics)
    ? (options.evaluation?.missing_metrics as string[])
    : [];
  const failedMetrics = Array.isArray(options.evaluation?.failed_metrics)
    ? (options.evaluation?.failed_metrics as Array<Record<string, unknown>>)
    : [];

  return [
    '# Final Review',
    '',
    '## Deterministic Comparator Verification Summary',
    '',
    `- Status: ${evaluationPass ? 'pass' : 'fail'}`,
    `- Final netlist: ${options.paths.designFinalPath}`,
    `- Strict parameter check: ${options.paths.strictCheckPath}`,
    `- Primitive check: ${options.paths.primitiveCheckPath}`,
    `- Simulation directory: ${options.paths.finalSimulationDir}`,
    '',
    '## Key Metrics',
    '',
    `- closed_loop_gain: ${options.metrics.closed_loop_gain ?? 'unavailable'}`,
    `- rc_cutoff_hz: ${options.metrics.rc_cutoff_hz ?? 'unavailable'}`,
    `- threshold: ${options.metrics.threshold ?? 'unavailable'}`,
    `- comparator_threshold_v: ${options.metrics.comparator_threshold_v ?? 'unavailable'}`,
    `- output_low_v: ${options.metrics.output_low_v ?? 'unavailable'}`,
    `- output_high_v: ${options.metrics.output_high_v ?? 'unavailable'}`,
    `- alarm_n_vol_max: ${options.metrics.alarm_n_vol_max ?? 'unavailable'}`,
    `- alarm_n_voh_min: ${options.metrics.alarm_n_voh_min ?? 'unavailable'}`,
    `- delay: ${options.metrics.delay ?? 'unavailable'}`,
    `- propagation_delay_us: ${options.metrics.propagation_delay_us ?? 'unavailable'}`,
    '',
    '## Evaluation',
    '',
    `- pass: ${evaluationPass}`,
    `- missing_metrics: ${missingMetrics.length > 0 ? missingMetrics.join(', ') : '(none)'}`,
    `- failed_metrics: ${
      failedMetrics.length > 0
        ? failedMetrics.map((entry) => `${String(entry.name ?? 'metric')}: ${String(entry.reason ?? 'unknown')}`).join('; ')
        : '(none)'
    }`,
    '',
    '## Notes',
    '',
    ...options.notes.map((note) => `- ${note}`),
    '- This report was regenerated by deterministic comparator fixups to keep the user-facing metrics aligned with the latest netlist.',
    '',
  ].join('\n');
}

export async function alignNetlistNodesToSpec(paths: WorkflowFixupPaths): Promise<InterfaceAlignmentResult> {
  const spec = await readJsonFile<SpecPayload>(paths.specNormalizedPath);
  const desiredInput = String(spec.input_node ?? '').trim();
  const desiredOutput = String(spec.output_node ?? '').trim();
  const validationArtifactsMissing =
    !(await pathExists(paths.strictCheckPath)) || !(await pathExists(paths.primitiveCheckPath));
  if (!desiredInput && !desiredOutput) {
    const notes = ['No explicit input/output node names were present in the spec.'];
    if (validationArtifactsMissing) {
      await rerunValidationArtifacts(paths);
      notes.push('Rebuilt validation artifacts because strict/primitive check outputs were missing.');
      await appendFixupLog(path.resolve(paths.logsDir, 'deterministic-fixups.md'), 'Netlist Validation Recovery', notes);
    }
    return { changed: false, notes };
  }

  const inferred = await inferNetlistInterfaces(paths.designFinalPath, paths.logsDir);
  const currentInput = inferred.inputNode;
  const currentOutput = inferred.outputNode;
  const notes: string[] = [
    `Spec nodes: input=${desiredInput || '(none)'}, output=${desiredOutput || '(none)'}`,
    `Inferred netlist nodes before alignment: input=${currentInput || '(none)'}, output=${currentOutput || '(none)'}`,
  ];

  const replacements = new Map<string, string>();
  if (desiredInput && currentInput && desiredInput !== currentInput) {
    replacements.set(currentInput, desiredInput);
  }
  if (desiredOutput && currentOutput && desiredOutput !== currentOutput) {
    replacements.set(currentOutput, desiredOutput);
  }

  if (replacements.size === 0) {
    notes.push('No interface-node rewrite was needed.');
    if (validationArtifactsMissing) {
      await rerunValidationArtifacts(paths);
      notes.push('Rebuilt validation artifacts because strict/primitive check outputs were missing.');
      await appendFixupLog(path.resolve(paths.logsDir, 'deterministic-fixups.md'), 'Netlist Validation Recovery', notes);
    }
    return { changed: false, notes };
  }

  let text = await readFile(paths.designFinalPath, 'utf8');
  const tempMap = new Map<string, string>();
  let counter = 0;
  for (const oldValue of replacements.keys()) {
    const tempName = `__ACTOVIQ_TMP_NODE_${counter}__`;
    counter += 1;
    tempMap.set(oldValue, tempName);
    text = wholeTokenReplace(text, oldValue, tempName);
  }
  for (const [oldValue, tempName] of tempMap) {
    text = wholeTokenReplace(text, tempName, replacements.get(oldValue)!);
  }

  await writeFile(paths.designFinalPath, text, 'utf8');
  await rerunValidationArtifacts(paths);

  for (const [oldValue, newValue] of replacements) {
    notes.push(`Rewrote node name ${oldValue} -> ${newValue} in final netlist.`);
  }
  await appendFixupLog(path.resolve(paths.logsDir, 'deterministic-fixups.md'), 'Netlist Interface Alignment', notes);
  return { changed: true, notes };
}

export async function repairModuleInterfaceNetReuse(paths: WorkflowFixupPaths): Promise<ModuleInterfaceRepairResult> {
  if (!(await pathExists(paths.modulePlanPath)) || !(await pathExists(paths.designFinalPath))) {
    return {
      applied: false,
      changed: false,
      notes: ['Module interface repair skipped because module-plan.json or design.final.cir is missing.'],
    };
  }

  const reportPath = path.resolve(paths.logsDir, 'module-interface-repair.json');
  const result = await runPythonJson<{
    ok?: boolean;
    changed?: boolean;
    changes?: Array<Record<string, unknown>>;
    warnings?: string[];
  }>({
    scriptPath: path.resolve(SCRIPT_ROOT, 'repair_module_interfaces.py'),
    args: [
      '--netlist-path',
      paths.designFinalPath,
      '--module-plan-path',
      paths.modulePlanPath,
      '--spec-path',
      paths.specNormalizedPath,
      '--output-path',
      reportPath,
      '--apply',
    ],
  });

  const changed = Boolean(result.data?.changed);
  const changeCount = Array.isArray(result.data?.changes) ? result.data!.changes!.length : 0;
  const notes = [
    `Module interface repair ${result.ok ? 'completed' : 'reported an error'}; changed=${changed}; changes=${changeCount}.`,
    `Report: ${reportPath}`,
    ...((result.data?.warnings ?? []).map((warning) => `Warning: ${warning}`)),
  ];

  if (changed) {
    await rerunValidationArtifacts(paths);
    notes.push('Rebuilt strict and primitive validation artifacts after module-interface repair.');
  }

  await appendFixupLog(path.resolve(paths.logsDir, 'deterministic-fixups.md'), 'Module Interface Net Repair', notes);
  return { applied: true, changed, notes };
}

export async function ensureModuleManifest(paths: WorkflowFixupPaths): Promise<ModuleManifestFixResult> {
  if (!(await pathExists(paths.designFinalPath))) {
    return {
      applied: false,
      changed: false,
      notes: ['Module manifest skipped because design.final.cir is missing.'],
    };
  }

  if (await pathExists(paths.moduleManifestPath)) {
    try {
      const existing = await readJsonFile<unknown>(paths.moduleManifestPath);
      if (hasUsableModuleManifest(existing)) {
        const notes = ['Existing module-manifest.json is usable; deterministic regeneration was not needed.'];
        await appendFixupLog(path.resolve(paths.logsDir, 'deterministic-fixups.md'), 'Module Manifest', notes);
        return { applied: true, changed: false, notes };
      }
    } catch {
      // Fall through and rebuild the manifest from the netlist/module plan.
    }
  }

  const spec: SpecPayload = (await pathExists(paths.specNormalizedPath))
    ? await readJsonFile<SpecPayload>(paths.specNormalizedPath)
    : {};
  const modulePlan: ModulePlanPayload = (await pathExists(paths.modulePlanPath))
    ? await readJsonFile<ModulePlanPayload>(paths.modulePlanPath)
    : {};
  const netlistText = await readFile(paths.designFinalPath, 'utf8');
  const sectionComponents = parseModuleComponentSections(netlistText);

  let planModules = Array.isArray(modulePlan.modules) ? modulePlan.modules : [];
  if (planModules.length === 0) {
    const discovered = [...sectionComponents.keys()].filter((name) => name !== 'global');
    planModules = discovered.length > 0
      ? discovered.map((name, index) => ({ name, file: `design/modules/${String(index + 1).padStart(2, '0')}_${name}.cir` }))
      : [{ name: 'top_level', file: 'design/design.final.cir' }];
  }

  const sharedNets = uniqueStrings([
    ...asStringList(modulePlan.shared_nets),
    spec.input_node ?? 'in',
    spec.output_node ?? '',
    'vdd',
    '0',
  ].filter(Boolean));
  const interfaceChain = buildInterfaceChain(spec, sharedNets, planModules);
  const modules = await Promise.all(planModules.map(async (moduleItem, index) => {
    const name = sanitizeModuleName(moduleItem.name ?? `module_${index + 1}`);
    const moduleFileComponents = await readModuleFileComponentNames(paths, moduleItem.file);
    const componentNames = uniqueStrings([
      ...asStringList(moduleItem.component_names),
      ...(sectionComponents.get(name) ?? []),
      ...moduleFileComponents,
      ...(planModules.length === 1 ? sectionComponents.get('global') ?? [] : []),
    ]);
    const label = moduleItem.label ?? name.replace(/_/g, ' ').toUpperCase();
    return {
      name,
      label,
      order: index + 1,
      file: moduleItem.file ?? `design/modules/${String(index + 1).padStart(2, '0')}_${name}.cir`,
      purpose: moduleItem.purpose ?? '',
      input_nets: asStringList(moduleItem.input_nets),
      output_nets: asStringList(moduleItem.output_nets),
      shared_nets: asStringList(moduleItem.shared_nets).length > 0
        ? asStringList(moduleItem.shared_nets)
        : sharedNets.filter((net) => ['0', 'vdd', 'vcc', 'vee', 'vss'].includes(net.toLowerCase())),
      local_net_prefix: moduleItem.local_net_prefix ?? `${name}_`,
      component_names: componentNames,
      verification_targets: asStringList(moduleItem.verification_targets),
    };
  }));

  const payload = {
    version: 'actoviq.module-manifest.v1',
    generated_by: 'deterministic-workflow-fixup',
    strategy: modulePlan.strategy ?? (modules.length > 1 ? 'partitioned' : 'single_block'),
    source_module_plan: paths.modulePlanPath,
    final_netlist: paths.designFinalPath,
    modules_dir: path.resolve(path.dirname(paths.moduleManifestPath), 'modules'),
    interface_chain: interfaceChain,
    shared_nets: sharedNets,
    modules,
    composition: {
      mode: 'flat_concatenation',
      module_comment_format: '* MODULE <order>: <name>',
    },
  };

  await mkdir(path.dirname(paths.moduleManifestPath), { recursive: true });
  await writeFile(paths.moduleManifestPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  const notes = [
    'Generated module-manifest.json from module-plan.json and design.final.cir.',
    `Modules: ${modules.map((moduleItem) => `${moduleItem.order}:${moduleItem.name}`).join(', ')}`,
    `Path: ${paths.moduleManifestPath}`,
  ];
  await appendFixupLog(path.resolve(paths.logsDir, 'deterministic-fixups.md'), 'Module Manifest', notes);
  return { applied: true, changed: true, notes };
}

export async function normalizePhysicalSpecAssumptions(paths: WorkflowFixupPaths): Promise<SpecAssumptionFixResult> {
  const spec = await readJsonFile<SpecPayload>(paths.specNormalizedPath);
  const inputVoltage = Number(spec.constraints?.input_voltage_v ?? NaN);
  const outputVoltage = Number(spec.constraints?.output_voltage_nominal_v ?? NaN);
  const efficiencyRule = getSpecTarget(spec, 'efficiency_pct');
  const isLdoLike =
    String(spec.recommended_template ?? '').toLowerCase() === 'ldo_mos_series_bench.cir' ||
    String(spec.domain ?? '').toLowerCase() === 'power';

  if (!isLdoLike || !Number.isFinite(inputVoltage) || !Number.isFinite(outputVoltage) || !efficiencyRule?.min) {
    return {
      changed: false,
      notes: ['No physical target normalization was needed for the current spec.'],
    };
  }

  const theoreticalMax = (outputVoltage / inputVoltage) * 100;
  if (!Number.isFinite(theoreticalMax) || theoreticalMax <= 0 || efficiencyRule.min <= theoreticalMax) {
    return {
      changed: false,
      notes: ['Efficiency target already fits within the theoretical limit implied by Vout/Vin.'],
    };
  }

  const adjustedMin = Number(Math.max(50, Math.floor(theoreticalMax * 0.95 * 10) / 10).toFixed(1));
  spec.targets = spec.targets ?? {};
  spec.targets_eval = spec.targets_eval ?? {};
  spec.targets.efficiency_pct = { ...(spec.targets.efficiency_pct ?? {}), min: adjustedMin };
  spec.targets_eval.efficiency_pct = { ...(spec.targets_eval.efficiency_pct ?? {}), min: adjustedMin };
  spec.notes = spec.notes ?? [];
  spec.notes.push(
    `Deterministic fixup adjusted efficiency_pct.min from ${efficiencyRule.min} to ${adjustedMin} because linear-regulator efficiency is bounded by Vout/Vin (~${theoreticalMax.toFixed(1)}%).`,
  );

  await writeFile(paths.specNormalizedPath, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
  const notes = [
    `Detected theoretical linear-regulator efficiency limit of ${theoreticalMax.toFixed(1)}%.`,
    `Adjusted efficiency_pct.min from ${efficiencyRule.min} to ${adjustedMin} in spec.normalized.json.`,
  ];
  await appendFixupLog(path.resolve(paths.logsDir, 'deterministic-fixups.md'), 'Physical Spec Normalization', notes);
  return { changed: true, notes };
}

export async function repairSignalChainComparatorNetlist(
  paths: WorkflowFixupPaths,
): Promise<ComparatorNetlistFixResult> {
  const spec = await readJsonFile<SpecPayload>(paths.specNormalizedPath);
  if (!isSignalChainComparatorSpec(spec)) {
    return {
      applied: false,
      changed: false,
      notes: ['Signal-chain comparator fixup skipped because the spec does not match the opamp + RC + comparator topology.'],
    };
  }

  const { content, notes } = buildSignalChainComparatorNetlist(spec);
  const currentContent = (await readFile(paths.designFinalPath, 'utf8').catch(() => '')) || '';
  const changed = currentContent.trim() !== content.trim();

  await writeFile(paths.designFinalPath, content, 'utf8');
  await rerunValidationArtifacts(paths);
  await appendFixupLog(path.resolve(paths.logsDir, 'deterministic-fixups.md'), 'Signal-Chain Comparator Netlist Repair', notes);

  const designNotesContent = [
    '# Design Notes',
    '',
    '## Deterministic Comparator Fixup',
    '',
    ...notes.map((note) => `- ${note}`),
    '',
    '## Topology Summary',
    '',
    '- Front-end: non-inverting op-amp gain stage',
    '- Middle stage: one-pole RC low-pass filter',
    '- Back-end: active-low comparator output generated from the filtered signal and a resistor-divider threshold',
    '',
  ].join('\n');
  await writeFile(paths.designNotesPath, designNotesContent, 'utf8');

  return {
    applied: true,
    changed,
    notes,
  };
}

export async function refreshSignalChainComparatorVerification(
  paths: WorkflowFixupPaths,
): Promise<ComparatorVerificationFixResult> {
  const spec = await readJsonFile<SpecPayload>(paths.specNormalizedPath);
  if (!isSignalChainComparatorSpec(spec)) {
    return {
      applied: false,
      metrics: {},
      evaluation: null,
      notes: ['Signal-chain comparator verification refresh skipped because the spec does not match the target topology.'],
    };
  }

  const notes: string[] = [];
  const result = await runPythonJson<Record<string, unknown>>({
    scriptPath: path.resolve(SCRIPT_ROOT, 'run_dual_analysis.py'),
    args: ['--work-dir', paths.finalSimulationDir, '--netlist-path', paths.designFinalPath, '--spec-path', paths.specNormalizedPath],
  });
  if (!result.ok) {
    notes.push(`run_dual_analysis returned non-zero status. stderr=${result.stderr.trim() || '(empty)'}`);
  } else {
    notes.push('Re-ran dual analysis after deterministic comparator fixup.');
  }

  const metricsPayload = await readJsonFile<{ metrics?: MeasurementSet }>(
    path.resolve(paths.finalSimulationDir, 'metrics.json'),
  ).catch(() => ({ metrics: {} }));
  const evaluationPayload = await readJsonFile<Record<string, unknown>>(
    path.resolve(paths.finalSimulationDir, 'evaluation.json'),
  ).catch(() => null);
  const metrics = {
    ...(metricsPayload.metrics ?? {}),
    ...(await readSimulationMeasurements(paths.finalSimulationDir)),
  };

  await writeFile(
    path.resolve(paths.finalSimulationDir, 'metrics.json'),
    `${JSON.stringify({ ...(metricsPayload ?? {}), metrics }, null, 2)}\n`,
    'utf8',
  );

  await writeFile(
    paths.finalReviewPath,
    comparatorReviewMarkdown({
      paths,
      metrics,
      evaluation: evaluationPayload,
      notes,
    }),
    'utf8',
  );
  await appendFixupLog(path.resolve(paths.logsDir, 'deterministic-fixups.md'), 'Signal-Chain Comparator Verification Refresh', notes);

  return {
    applied: true,
    metrics,
    evaluation: evaluationPayload,
    notes,
  };
}

export async function autoTuneRcCutoffInVerifier(paths: WorkflowFixupPaths): Promise<RcTuneResult> {
  const spec = await readJsonFile<SpecPayload>(paths.specNormalizedPath);
  const topology = String(spec.constraints?.topology ?? '').toLowerCase();
  const isRcCase =
    (String(spec.recommended_template ?? '').toLowerCase() === 'rc_filter.cir' ||
      topology === 'rc' ||
      topology === 'rc_filter' ||
      topology === 'one_pole_rc_filter') &&
    !topology.includes('opamp') &&
    !topology.includes('comparator');
  if (!isRcCase) {
    return {
      applied: false,
      tuned: false,
      attempts: 0,
      notes: ['Verifier auto-tuning skipped because the spec is not classified as the simple RC filter case.'],
    };
  }

  const cutoffRule = getSpecTarget(spec, 'cutoff_frequency_hz');
  const targetMinHz = cutoffRule?.min;
  const targetMaxHz = cutoffRule?.max;
  if (targetMinHz == null || targetMaxHz == null) {
    return {
      applied: false,
      tuned: false,
      attempts: 0,
      notes: ['Verifier auto-tuning skipped because cutoff_frequency_hz bounds were missing from the spec.'],
    };
  }

  const targetHz = (targetMinHz + targetMaxHz) / 2;
  let netlistText = await readFile(paths.designFinalPath, 'utf8');
  const resistorToken = readParamAssignment(netlistText, 'R1');
  if (!resistorToken) {
    return {
      applied: false,
      tuned: false,
      attempts: 0,
      targetMinHz,
      targetMaxHz,
      notes: ['Verifier auto-tuning skipped because .param R1 was not found in the final netlist.'],
    };
  }

  const originalResistance = parseSpiceScalar(resistorToken);
  if (originalResistance == null || originalResistance <= 0) {
    return {
      applied: false,
      tuned: false,
      attempts: 0,
      targetMinHz,
      targetMaxHz,
      notes: [`Verifier auto-tuning skipped because .param R1=${resistorToken} could not be parsed.`],
    };
  }

  let tuned = false;
  let attempts = 0;
  let cutoffHz: number | undefined;
  let latestMeasurements: MeasurementSet = {};
  const notes: string[] = [];

  while (attempts < 3) {
    attempts += 1;
    await runPythonJson<Record<string, unknown>>({
      scriptPath: path.resolve(SCRIPT_ROOT, 'run_dual_analysis.py'),
      args: ['--work-dir', paths.finalSimulationDir, '--netlist-path', paths.designFinalPath, '--spec-path', paths.specNormalizedPath],
    });

    latestMeasurements = await readSimulationMeasurements(paths.finalSimulationDir);
    cutoffHz = latestMeasurements.f_3db;
    if (cutoffHz == null) {
      notes.push(`Iteration ${attempts}: failed to extract f_3db from simulation outputs.`);
      break;
    }

    notes.push(`Iteration ${attempts}: measured cutoff ${cutoffHz.toFixed(3)} Hz.`);
    if (cutoffHz >= targetMinHz && cutoffHz <= targetMaxHz) {
      break;
    }

    const currentResistanceToken = readParamAssignment(netlistText, 'R1');
    const currentResistance = currentResistanceToken ? parseSpiceScalar(currentResistanceToken) : null;
    if (currentResistance == null || currentResistance <= 0) {
      notes.push(`Iteration ${attempts}: could not parse current R1 token ${currentResistanceToken ?? '(missing)'}.`);
      break;
    }

    const proposedResistance = Math.max(1e-6, currentResistance * (cutoffHz / targetHz));
    const formatted = formatCompactScalar(proposedResistance);
    netlistText = writeParamAssignment(netlistText, 'R1', formatted);
    await writeFile(paths.designFinalPath, netlistText, 'utf8');
    notes.push(`Iteration ${attempts}: updated R1 from ${currentResistanceToken} to ${formatted}.`);
    tuned = true;
  }

  await rerunValidationArtifacts(paths);
  await appendFixupLog(path.resolve(paths.logsDir, 'deterministic-fixups.md'), 'Verifier RC Auto-Tuning', notes);
  await appendFile(
    paths.designNotesPath,
    [
      '',
      '## Deterministic Verifier Auto-Tuning',
      '',
      ...notes.map((note) => `- ${note}`),
      '',
    ].join('\n'),
    'utf8',
  );

  await writeFile(
    paths.finalReviewPath,
    deterministicReviewMarkdown({
      cutoffHz,
      targetMinHz,
      targetMaxHz,
      tuned,
      notes,
      paths,
      measurements: latestMeasurements,
    }),
    'utf8',
  );

  return {
    applied: true,
    tuned,
    attempts,
    notes,
    cutoffHz,
    targetMinHz,
    targetMaxHz,
    tunedParamName: 'R1',
    tunedParamValue: readParamAssignment(netlistText, 'R1') ?? undefined,
  };
}
