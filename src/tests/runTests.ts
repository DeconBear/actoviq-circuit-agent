import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import type { ToolExecutionContext } from 'actoviq-agent-sdk';

import { parseCliOptions } from '../app.js';
import { createWorkspaceFileTools } from '../tools/fileTools.js';
import { parseTuiCommand } from '../tui/commandParser.js';
import { TuiStateStore } from '../tui/TuiState.js';
import { classifyError } from '../utils/errors.js';
import {
  composeFinalNetlistFromModules,
  formatCompactScalar,
  parseMeasurementLines,
  parseSpiceScalar,
  repairSignalChainComparatorNetlist,
} from '../utils/workflowFixups.js';
import {
  buildJobId,
  buildUniqueJobId,
  type JobPaths,
} from '../workflow/circuitDesignWorkflow.js';
import { createWorkflowStages } from '../workflow/stagePromptRegistry.js';

type TestCase = {
  name: string;
  run: () => void | Promise<void>;
};

const tests: TestCase[] = [];

function test(name: string, run: TestCase['run']): void {
  tests.push({ name, run });
}

function createToolContext(cwd: string): ToolExecutionContext {
  return {
    runId: 'unit-test',
    cwd,
    metadata: {},
    prompt: 'unit test',
    iteration: 1,
  };
}

function createTestJobPaths(jobRoot: string): JobPaths {
  const inputsDir = path.resolve(jobRoot, 'inputs');
  const planningDir = path.resolve(jobRoot, 'planning');
  const designDir = path.resolve(jobRoot, 'design');
  const verificationDir = path.resolve(jobRoot, 'verification');
  const simulationDir = path.resolve(jobRoot, 'simulation');
  const finalSimulationDir = path.resolve(simulationDir, 'final');
  const renderDir = path.resolve(jobRoot, 'render');
  const reportsDir = path.resolve(jobRoot, 'reports');
  const logsDir = path.resolve(jobRoot, 'logs');
  return {
    jobId: path.basename(jobRoot),
    jobRoot,
    inputsDir,
    planningDir,
    designDir,
    verificationDir,
    simulationDir,
    finalSimulationDir,
    renderDir,
    reportsDir,
    logsDir,
    userRequirementPath: path.resolve(inputsDir, 'user-requirements.md'),
    requirementBriefPath: path.resolve(planningDir, 'requirements-brief.md'),
    specRawPath: path.resolve(planningDir, 'spec.raw.json'),
    specNormalizedPath: path.resolve(planningDir, 'spec.normalized.json'),
    technicalSolutionPath: path.resolve(planningDir, 'technical-solution.md'),
    executionChecklistPath: path.resolve(planningDir, 'execution-checklist.md'),
    assetReusePlanPath: path.resolve(planningDir, 'asset-reuse-plan.md'),
    architecturePath: path.resolve(planningDir, 'architecture.md'),
    verificationPlanPath: path.resolve(planningDir, 'verification-plan.md'),
    modulePlanPath: path.resolve(planningDir, 'module-plan.json'),
    templateNetlistPath: path.resolve(designDir, 'template.cir'),
    modulesDir: path.resolve(designDir, 'modules'),
    moduleManifestPath: path.resolve(designDir, 'module-manifest.json'),
    designFinalPath: path.resolve(designDir, 'design.final.cir'),
    designNotesPath: path.resolve(designDir, 'design-notes.md'),
    detailedDesignReportPath: path.resolve(designDir, 'detailed-design-report.md'),
    patchPlanPath: path.resolve(designDir, 'patch-plan.json'),
    strictCheckPath: path.resolve(verificationDir, 'strict-param-check.json'),
    primitiveCheckPath: path.resolve(verificationDir, 'primitive-check.json'),
    finalReviewPath: path.resolve(verificationDir, 'final-review.md'),
    designJsonPath: path.resolve(renderDir, 'design.json'),
    netlistsvgPath: path.resolve(renderDir, 'netlistsvg.svg'),
    netlistsvgGeometryPath: path.resolve(renderDir, 'netlistsvg.geometry.json'),
    netlistsvgLayoutReportPath: path.resolve(renderDir, 'netlistsvg.layout-report.json'),
    netlistsvgNotesPath: path.resolve(renderDir, 'netlistsvg-notes.md'),
    schemdrawPath: path.resolve(renderDir, 'schemdraw.svg'),
    schemdrawNotesPath: path.resolve(renderDir, 'schemdraw-notes.md'),
    sceneHintsPath: path.resolve(renderDir, 'scene-hints.json'),
    agentSvgPath: path.resolve(renderDir, 'agent-layout.svg'),
    agentSvgNotesPath: path.resolve(renderDir, 'agent-layout-notes.md'),
    finalSummaryPath: path.resolve(reportsDir, 'final-summary.md'),
    manifestPath: path.resolve(reportsDir, 'manifest.json'),
    workflowStatePath: path.resolve(reportsDir, 'workflow-state.json'),
  };
}

async function prepareJobDirs(paths: JobPaths): Promise<void> {
  await Promise.all([
    paths.inputsDir,
    paths.planningDir,
    paths.designDir,
    paths.modulesDir,
    paths.verificationDir,
    paths.simulationDir,
    paths.finalSimulationDir,
    paths.renderDir,
    paths.reportsDir,
    paths.logsDir,
  ].map((directory) => mkdir(directory, { recursive: true })));
}

test('parseCliOptions parses value flags and approval policy', () => {
  const options = parseCliOptions([
    '--requirement',
    'Design an RC filter',
    '--approval-policy',
    'execution',
    '--job-name',
    'rc-demo',
    '--revision-base-job',
    'base-job',
    '--job-parent-dir',
    'custom-revisions',
    '--rerun-from-stage',
    'simulation-verifier',
    '--legacy-cli',
  ]);
  assert.equal(options.requirement, 'Design an RC filter');
  assert.equal(options.approvalPolicy, 'execution');
  assert.equal(options.jobName, 'rc-demo');
  assert.equal(options.revisionBaseJob, 'base-job');
  assert.equal(options.jobParentDir, 'custom-revisions');
  assert.equal(options.rerunFromStage, 'simulation-verifier');
  assert.equal(options.legacyCli, true);
  assert.equal(options.error, undefined);
});

test('parseCliOptions reports missing values and invalid policies', () => {
  assert.equal(parseCliOptions(['--requirement']).error, 'missing value for --requirement');
  assert.equal(
    parseCliOptions(['--approval-policy', 'sometimes']).error,
    '--approval-policy must be manual, execution, or all',
  );
  assert.equal(parseCliOptions(['--rerun-from-stage']).error, 'missing value for --rerun-from-stage');
});

test('parseTuiCommand distinguishes chat text from slash commands', () => {
  assert.equal(parseTuiCommand('设计一个 LDO'), null);
  assert.deepEqual(parseTuiCommand('/allow all'), {
    name: 'allow',
    args: 'all',
    raw: '/allow all',
  });
  assert.deepEqual(parseTuiCommand('/unknown value'), {
    name: 'unknown',
    args: 'value',
    raw: '/unknown value',
  });
});

test('classifyError uses structured categories', () => {
  assert.deepEqual(classifyError(new Error('stage timed out after 1000 ms')), {
    kind: 'timeout',
    retryable: true,
    message: 'stage timed out after 1000 ms',
  });
  assert.equal(classifyError(new Error('No Actoviq credential was found')).kind, 'credential');
  assert.equal(classifyError(new Error('Missing required Write field: file_path')).kind, 'file_tool');
});

test('SPICE scalar parsing and formatting handle common suffixes', () => {
  assert.equal(parseSpiceScalar('10k'), 10_000);
  assert.equal(parseSpiceScalar('1.5meg'), 1_500_000);
  assert.ok(Math.abs((parseSpiceScalar('2.2pF') ?? 0) - 2.2e-12) < 1e-24);
  assert.equal(formatCompactScalar(10_000), '10k');
  assert.equal(formatCompactScalar(2.2e-9), '2.2n');
});

test('ngspice measurement parser handles next-line values', () => {
  const metrics = parseMeasurementLines(['gain = 12.5', 'delay =', '  3.4e-6', 'bad = n/a'].join('\n'));
  assert.equal(metrics.gain, 12.5);
  assert.equal(metrics.delay, 3.4e-6);
  assert.equal(metrics.bad, undefined);
});

test('Write tool exposes canonical schema but tolerates raw wrapper input', async () => {
  const root = path.resolve(process.cwd(), '.tmp-unit-tests', `write-${Date.now()}`);
  await mkdir(root, { recursive: true });
  try {
    const tools = createWorkspaceFileTools({ cwd: root, allowedRoots: [root] });
    const write = tools.find((tool) => tool.name === 'Write');
    assert.ok(write);
    const context = createToolContext(root);
    const outputPath = path.resolve(root, 'raw-object.txt');
    await write.execute({ raw: { file_path: outputPath, content: 'object ok' } }, context);
    assert.equal(await readFile(outputPath, 'utf8'), 'object ok');

    const nestedOutputPath = path.resolve(root, 'nested-raw.cir');
    const nestedRaw = JSON.stringify({
      raw: JSON.stringify({
        raw: JSON.stringify({
          file_path: nestedOutputPath,
          content: '* nested raw write\nR1 in 0 1k\n.end\n',
        }),
      }),
    });
    await write.execute({ raw: nestedRaw }, context);
    assert.equal(await readFile(nestedOutputPath, 'utf8'), '* nested raw write\nR1 in 0 1k\n.end\n');

    await assert.rejects(
      () => write.execute({ raw: 'not json' }, context),
      /Missing required Write field: file_path/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stage registry exposes the expected workflow order and prompt constraints', () => {
  const root = path.resolve(process.cwd(), '.tmp-unit-tests', 'stage-registry');
  const paths = createTestJobPaths(root);
  const stages = createWorkflowStages(paths, '设计一个运放 RC 比较器链路');
  assert.deepEqual(stages.map((stage) => stage.key), [
    'solution-analyst',
    'doc-writer',
    'librarian',
    'architect',
    'netlist-designer',
    'simulation-verifier',
    'netlistsvg-renderer',
    'workflow-lead',
  ]);
  assert.equal(new Set(stages.map((stage) => stage.key)).size, stages.length);
  assert.equal(stages.find((stage) => stage.key === 'simulation-verifier')?.requiresConfirmation, false);

  const netlistPrompt = stages.find((stage) => stage.key === 'netlist-designer')?.buildPrompt(paths) ?? '';
  assert.match(netlistPrompt, /Primitive-only hard gate/);
  assert.match(netlistPrompt, /Forbidden instance prefixes: X, E, F, G, H, B, A, U/);

  const librarianPrompt = stages.find((stage) => stage.key === 'librarian')?.buildPrompt(paths) ?? '';
  assert.match(librarianPrompt, /bundled starter netlist|bundled assets/i);
  assert.doesNotMatch(librarianPrompt, /本地三个仓库|三个仓库/);
});

test('buildUniqueJobId avoids same-second collisions deterministically', async () => {
  const parent = path.resolve(process.cwd(), '.tmp-unit-tests', `job-id-${Date.now()}`);
  await mkdir(parent, { recursive: true });
  try {
    const fixed = new Date('2026-01-02T03:04:05');
    const base = buildJobId('collision-demo', fixed);
    await mkdir(path.resolve(parent, base), { recursive: true });
    assert.equal(await buildUniqueJobId('collision-demo', parent, fixed), `${base}-2`);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('TuiStateStore persists allow mode, active job, and transcript transitions', async () => {
  const sessionId = `unit-${Date.now()}`;
  const sessionRoot = path.resolve(process.cwd(), 'sessions', sessionId);
  await rm(sessionRoot, { recursive: true, force: true });
  try {
    const store = await TuiStateStore.load(sessionId);
    await store.setConversationSessionId('conversation-1');
    await store.setAllowMode('all');
    assert.equal(store.snapshot().allowMode, 'all');
    assert.equal(store.snapshot().conversationSessionId, undefined);

    await store.setActiveJob({
      jobId: 'job-1',
      jobRoot: 'workspace/job-1',
      finalSummaryPath: 'workspace/job-1/reports/final-summary.md',
      manifestPath: 'workspace/job-1/reports/manifest.json',
      workflowStatePath: 'workspace/job-1/reports/workflow-state.json',
    });
    assert.equal(store.snapshot().activeJobId, 'job-1');
    await store.clearActiveJob();
    assert.equal(store.snapshot().activeJobId, undefined);

    await store.appendTranscript({ role: 'user', content: 'hello' });
    await store.appendTranscript({ role: 'agent', content: 'hi' });
    assert.deepEqual((await store.recentTranscript(1)).map((entry) => entry.content), ['hi']);
  } finally {
    await rm(sessionRoot, { recursive: true, force: true });
  }
});

test('deterministic comparator fallback stays primitive-only', async () => {
  const root = path.resolve(process.cwd(), '.tmp-unit-tests', `comparator-${Date.now()}`);
  const paths = createTestJobPaths(root);
  await prepareJobDirs(paths);
  try {
    await writeFile(paths.specNormalizedPath, `${JSON.stringify({
      input_node: 'in',
      output_node: 'alarm_n',
      constraints: {
        topology: 'opamp + rc + comparator',
        output_logic: 'active_low',
        supply_v: 5,
      },
      targets: {
        closed_loop_gain: { min: 7, max: 9 },
        rc_cutoff_hz: { min: 1000, max: 2000 },
        comparator_threshold_v: { min: 2.4, max: 2.6 },
      },
    }, null, 2)}\n`, 'utf8');

    const result = await repairSignalChainComparatorNetlist(paths);
    assert.equal(result.applied, true);
    const netlist = await readFile(paths.designFinalPath, 'utf8');
    assert.doesNotMatch(netlist, /^\s*[EBFGHXAU][A-Za-z0-9_.$-]*\b/im);
    assert.match(netlist, /^Mcmp\b/m);
    assert.match(netlist, /^Rpull\b/m);

    const primitiveReport = JSON.parse(await readFile(paths.primitiveCheckPath, 'utf8')) as { ok?: boolean };
    assert.equal(primitiveReport.ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('module composition builds a flat primitive final netlist and manifest', async () => {
  const root = path.resolve(process.cwd(), '.tmp-unit-tests', `module-compose-${Date.now()}`);
  const paths = createTestJobPaths(root);
  await prepareJobDirs(paths);
  try {
    await writeFile(paths.specNormalizedPath, `${JSON.stringify({
      input_node: 'in',
      output_node: 'alarm_n',
      constraints: { topology: 'partitioned primitive chain' },
    }, null, 2)}\n`, 'utf8');
    await writeFile(paths.modulePlanPath, `${JSON.stringify({
      strategy: 'partitioned',
      shared_nets: ['vdd', '0'],
      modules: [
        {
          name: 'input_filter',
          file: 'design/modules/01_input_filter.cir',
          input_nets: ['in'],
          output_nets: ['mid'],
          component_names: ['Rin'],
        },
        {
          name: 'output_pull',
          file: 'design/modules/02_output_pull.cir',
          input_nets: ['mid'],
          output_nets: ['alarm_n'],
          component_names: ['Rload'],
        },
      ],
    }, null, 2)}\n`, 'utf8');
    await writeFile(path.resolve(paths.modulesDir, '01_input_filter.cir'), [
      '* MODULE 1: input_filter',
      'Rin in mid 1k',
      '.model DMOD D(IS=1e-15)',
      '.end',
      '',
    ].join('\n'), 'utf8');
    await writeFile(path.resolve(paths.modulesDir, '02_output_pull.cir'), [
      '* MODULE 2: output_pull',
      'Rload mid alarm_n 2k',
      'Cout alarm_n 0 1n',
      '.model DMOD D(IS=2e-15)',
      '.end',
      '',
    ].join('\n'), 'utf8');

    const result = await composeFinalNetlistFromModules(paths);
    assert.equal(result.applied, true);
    const netlist = await readFile(paths.designFinalPath, 'utf8');
    assert.match(netlist, /Rin in mid 1k/);
    assert.match(netlist, /Rload mid alarm_n 2k/);
    assert.equal((netlist.match(/^\.model DMOD\b/gim) ?? []).length, 1);

    const manifest = JSON.parse(await readFile(paths.moduleManifestPath, 'utf8')) as { modules?: unknown[] };
    assert.equal(manifest.modules?.length, 2);
    const primitiveReport = JSON.parse(await readFile(paths.primitiveCheckPath, 'utf8')) as { ok?: boolean };
    assert.equal(primitiveReport.ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('netlistsvg renderer keeps the partitioned timeout fallback path wired', async () => {
  const scriptPath = path.resolve(process.cwd(), 'embedded', 'circuit-design', 'scripts', 'render_netlistsvg.py');
  const script = await readFile(scriptPath, 'utf8');
  assert.match(script, /def render_partitioned_fallback_after_timeout/);
  assert.match(script, /except subprocess\.TimeoutExpired:[\s\S]*render_partitioned_fallback_after_timeout/);
  assert.match(script, /write_netlistsvg_reports\(/);
  assert.match(script, /check_geometry/);
});

test('grid renderer keeps BJT, diode, inductor, and supply rails visible', async () => {
  const root = path.resolve(process.cwd(), '.tmp-unit-tests', `grid-renderer-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const netlistPath = path.resolve(root, 'mixed-active.cir');
  const svgPath = path.resolve(root, 'mixed-active.svg');
  const scriptPath = path.resolve(
    process.cwd(),
    'skills',
    'circuit-design-ngspice',
    'scripts',
    'render_grid.py',
  );
  try {
    await writeFile(netlistPath, [
      '* mixed primitive schematic',
      '.model QNPN NPN(IS=1e-15 BF=120)',
      '.model DCL D(IS=1e-15)',
      'VCC vcc 0 DC 12',
      'VIN src 0 AC 1',
      'RSRC src in 50',
      'CIN in b 68p',
      'RB1 vcc b 22k',
      'RB2 b 0 4.7k',
      'Q1 c b e QNPN',
      'RE e 0 39',
      'CE e 0 4.7n',
      'RC vcc c 680',
      'DCLAMP b 0 DCL',
      'LLOAD c out 1u',
      'RLOAD out 0 50',
      '.end',
      '',
    ].join('\n'), 'utf8');
    const result = spawnSync('python', [scriptPath, '--netlist', netlistPath, '--svg-path', svgPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout.trim()) as Record<string, any>;
    assert.equal(payload.ok, true);
    assert.equal(payload.renderer, 'grid');
    assert.equal(payload.devices, 12);
    const svg = await readFile(svgPath, 'utf8');
    assert.match(svg, /Q1/);
    assert.match(svg, /DCLAMP/);
    assert.match(svg, /LLOAD/);
    assert.match(svg, /VCC/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('markdown fallback artifacts remain explicit placeholders, not silent success', async () => {
  const workflowPath = path.resolve(process.cwd(), 'src', 'workflow', 'circuitDesignWorkflow.ts');
  const workflowSource = await readFile(workflowPath, 'utf8');
  assert.match(workflowSource, /fallback-placeholder/);
  assert.match(workflowSource, /Semantic review is required/);
  assert.doesNotMatch(workflowSource, /This file was generated by workflow fallback because the stage agent did not persist/);
});

test('canvas project tool creates, revises, and compiles a modular project', async () => {
  const projectsRoot = path.resolve(process.cwd(), '.tmp-unit-tests', `canvas-project-${Date.now()}`);
  await mkdir(projectsRoot, { recursive: true });
  const script = path.resolve(
    process.cwd(),
    'skills',
    'circuit-design-ngspice',
    'scripts',
    'circuit_project.py',
  );
  const runTool = (args: string[]) => {
    const result = spawnSync('python', [script, ...args], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout.trim()) as Record<string, any>;
  };
  try {
    const created = runTool([
      'create-demo',
      '--projects-root', projectsRoot,
      '--name', 'Canvas Test',
    ]);
    const projectRoot = String(created.project_root);
    assert.equal(created.project.revision, 0);
    assert.equal(created.project.modules.length, 3);

    const command = {
      schema: 'actoviq.command.v1',
      command_id: 'test-value-change',
      actor: 'unit-test',
      project_id: created.project.project_id,
      base_revision: 0,
      message: 'Tune filter',
      operations: [{
        op: 'set_component_value',
        module_id: 'filter',
        component_id: 'c_filter',
        value: '22n',
      }, {
        op: 'set_module_note',
        module_id: 'filter',
        notes: 'Agent should reduce the cutoff frequency.',
      }, {
        op: 'set_module_preview',
        module_id: 'filter',
        enabled: false,
      }, {
        op: 'set_module_metadata',
        module_id: 'filter',
        function: 'Updated low-pass filter stage.',
        parameters: {
          Resistance: '10 kohm',
          Capacitance: '22 nF',
        },
      }, {
        op: 'resize_module',
        module_id: 'filter',
        width: 420,
        height: 310,
      }, {
        op: 'set_connection_network',
        connection_id: 'amplifier-to-filter',
        network: 'DAC#1',
      }],
    };
    const applied = runTool([
      'apply',
      '--project-root', projectRoot,
      '--command-json', JSON.stringify(command),
    ]);
    assert.equal(applied.revision, 1);
    assert.deepEqual(applied.changed_modules, ['filter']);
    const summary = runTool(['summary', '--project-root', projectRoot]);
    const filterRef = summary.project.modules.find((entry: { id: string }) => entry.id === 'filter');
    assert.equal(filterRef.notes, 'Agent should reduce the cutoff frequency.');
    assert.equal(filterRef.preview_enabled, false);
    assert.equal(filterRef.function, 'Updated low-pass filter stage.');
    assert.equal(filterRef.parameters.Capacitance, '22 nF');
    assert.deepEqual(filterRef.size, { width: 420, height: 310 });
    assert.equal(
      summary.project.connections.find(
        (connection: { id: string }) => connection.id === 'amplifier-to-filter',
      ).network,
      'DAC#1',
    );

    const sensorPorts = [
      { id: 'input', name: 'IN', direction: 'input', signal_type: 'analog', net: 'in' },
      { id: 'output', name: 'OUT', direction: 'output', signal_type: 'analog', net: 'out' },
      { id: 'gnd', name: 'GND', direction: 'bidirectional', signal_type: 'ground', net: '0' },
    ];
    const addModuleCommand = {
      schema: 'actoviq.command.v1',
      command_id: 'test-upsert-module',
      actor: 'unit-test',
      project_id: created.project.project_id,
      base_revision: 1,
      message: 'Add sensor module',
      operations: [{
        op: 'upsert_module',
        module_ref: {
          id: 'sensor',
          name: 'Sensor interface',
          kind: 'input',
          source: 'modules/sensor/module.circuit.json',
          position: { x: 20, y: 360 },
          size: { width: 180, height: 120 },
          ports: sensorPorts,
        },
        module: {
          schema: 'actoviq.module.v1',
          module_id: 'sensor',
          name: 'Sensor interface',
          revision: 0,
          ports: sensorPorts,
          components: [{
            id: 'r_sensor',
            type: 'R',
            name: 'Rsensor',
            value: '2k',
            position: { x: 80, y: 120 },
            rotation: 0,
            pins: [
              { id: 'a', name: '1', net: 'in' },
              { id: 'b', name: '2', net: 'out' },
            ],
          }],
          wires: [],
          annotations: [],
        },
      }],
    };
    const moduleApplied = runTool([
      'apply',
      '--project-root', projectRoot,
      '--command-json', JSON.stringify(addModuleCommand),
    ]);
    assert.equal(moduleApplied.revision, 2);
    assert.deepEqual(moduleApplied.changed_modules, ['sensor']);

    const compiled = runTool(['compile', '--project-root', projectRoot]);
    assert.equal(compiled.ok, true);
    const netlist = await readFile(String(compiled.netlist_path), 'utf8');
    assert.match(netlist, /Ramplifier_Rseries SIGNAL DAC_1 1k/);
    assert.match(netlist, /Rfilter_Rfilter DAC_1 out 10k/);
    assert.match(netlist, /Cfilter_Cfilter out 0 22n/);
    assert.match(netlist, /Rsensor_Rsensor sensor_input out_\d+ 2k/);
    const moduleCompiled = runTool([
      'compile-module',
      '--project-root', projectRoot,
      '--module-id', 'filter',
    ]);
    assert.equal(moduleCompiled.ok, true);
    assert.match(await readFile(String(moduleCompiled.netlist_path), 'utf8'), /Vtest_input in 0 DC 0 AC 1/);
    assert.equal(moduleCompiled.render.ok, true);
    const moduleSvg = await readFile(String(moduleCompiled.schematic_path), 'utf8');
    assert.match(moduleSvg, /<svg\b/);
    assert.doesNotMatch(moduleSvg, /Rload_/);
    const notebookPath = path.resolve(projectRoot, 'modules', 'filter', 'netlist-notebook.md');
    const notebookNetlist = await readFile(String(moduleCompiled.netlist_path), 'utf8');
    await writeFile(
      notebookPath,
      [
        '# Filter notebook',
        '',
        'Editable explanation outside the circuit code block.',
        '',
        '```spice',
        notebookNetlist.replace('Cfilter_Cfilter out 0 22n', 'Cfilter_Cfilter out 0 33n').trim(),
        '```',
        '',
        'Persistent review note.',
        '',
      ].join('\n'),
      'utf8',
    );
    const notebookCompiled = runTool([
      'compile-module',
      '--project-root', projectRoot,
      '--module-id', 'filter',
    ]);
    assert.equal(notebookCompiled.render.ok, true);
    assert.match(await readFile(String(notebookCompiled.netlist_path), 'utf8'), /Cfilter_Cfilter out 0 33n/);
    assert.equal(
      await readFile(path.resolve(projectRoot, 'revisions', '000001', 'metadata.json'), 'utf8')
        .then((value) => JSON.parse(value).base_revision),
      0,
    );
    const sensorNotebookPath = path.resolve(projectRoot, 'modules', 'sensor', 'netlist-notebook.md');
    await writeFile(
      sensorNotebookPath,
      [
        '# Active sensor notebook',
        '',
        '```spice',
        '.model NMTEST NMOS(LEVEL=1 VTO=0.8 KP=120u)',
        'VDD vdd 0 DC 5',
        'M1 out in 0 0 NMTEST W=10u L=1u',
        'RLOAD out 0 1k',
        '.end',
        '```',
        '',
      ].join('\n'),
      'utf8',
    );
    const activeCompiled = runTool([
      'compile-module',
      '--project-root', projectRoot,
      '--module-id', 'sensor',
    ]);
    assert.equal(activeCompiled.render.ok, true);
    assert.equal(activeCompiled.render.renderer, 'grid');
    const buildManifest = JSON.parse(await readFile(path.resolve(projectRoot, 'build', 'build-manifest.json'), 'utf8'));
    assert.equal(buildManifest.modules.sensor.renderer, 'grid');
  } finally {
    await rm(projectsRoot, { recursive: true, force: true });
  }
});

let failed = 0;
for (const testCase of tests) {
  try {
    await testCase.run();
    console.log(`ok - ${testCase.name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${testCase.name}`);
    console.error(error);
  }
}

if (failed > 0) {
  process.exitCode = 1;
}
