import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.resolve(root, 'output', 'playwright');
const runRoot = path.resolve(outputRoot, '.workspace', `agent-flow-${process.pid}-${Date.now()}`);
const workspaceRoot = path.resolve(runRoot, 'workspace');
const projectsRoot = path.resolve(workspaceRoot, 'projects');
const userDataDir = path.resolve(runRoot, 'electron-user-data');
const homeDir = path.resolve(runRoot, 'home');
const vitePort = await allocatePort();
const viteUrl = `http://127.0.0.1:${vitePort}`;
const fakeApiKey = `sk-mock-agent-flow-${Date.now().toString(36)}`;
const designMarker = 'ACTOVIQ_AGENT_FLOW_DESIGN_REQUEST';
const reportMarker = 'ACTOVIQ_AGENT_FLOW_TECHNICAL_REPORT';
const projectName = `Agent Flow RC ${Date.now()}`;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert(address && typeof address === 'object');
      server.close(() => resolve(address.port));
    });
  });
}

async function canFetch(url) {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

async function startVite() {
  const viteBin = path.resolve(root, 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(process.execPath, [
    viteBin,
    '--host', '127.0.0.1',
    '--port', String(vitePort),
    '--strictPort',
  ], {
    cwd: root,
    env: { ...process.env, BROWSER: 'none' },
    stdio: 'ignore',
    windowsHide: true,
  });
  let exit = null;
  child.once('exit', (code, signal) => { exit = { code, signal }; });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (exit) throw new Error(`Vite exited before startup: ${JSON.stringify(exit)}`);
    if (await canFetch(viteUrl)) {
      await fetch(`${viteUrl}/src/main.tsx`).catch(() => null);
      await delay(750);
      return child;
    }
    await delay(200);
  }
  child.kill();
  throw new Error(`Timed out waiting for ${viteUrl}`);
}

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function openAiChunk(id, model, content, finishReason = null) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      delta: content ? { content } : {},
      finish_reason: finishReason,
    }],
  };
}

function sendStreamingText(response, content) {
  const id = `chatcmpl-agent-flow-${Date.now()}`;
  const model = 'mock-deepseek';
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  response.write(`data: ${JSON.stringify({
    ...openAiChunk(id, model, ''),
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  })}\n\n`);
  for (let offset = 0; offset < content.length; offset += 11) {
    response.write(`data: ${JSON.stringify(openAiChunk(id, model, content.slice(offset, offset + 11)))}\n\n`);
  }
  response.write(`data: ${JSON.stringify({
    ...openAiChunk(id, model, '', 'stop'),
    usage: { prompt_tokens: 71, completion_tokens: 53, total_tokens: 124 },
  })}\n\n`);
  response.write('data: [DONE]\n\n');
  response.end();
}

function sendCompletionText(response, content) {
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({
    id: `chatcmpl-agent-flow-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'mock-deepseek',
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 71, completion_tokens: 53, total_tokens: 124 },
  }));
}

function sendProviderText(response, body, content) {
  if (body.stream === true) sendStreamingText(response, content);
  else sendCompletionText(response, content);
}

async function startMockProvider() {
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
        response.writeHead(404).end();
        return;
      }
      const body = await readRequestJson(request);
      const messages = JSON.stringify(body.messages ?? []);
      const authorized = request.headers.authorization === `Bearer ${fakeApiKey}`;
      const scenario = messages.includes('Reply with exactly: OK')
        ? 'provider-check'
        : messages.includes('Verified evidence JSON:')
          ? 'technical-report'
          : messages.includes(designMarker)
            ? 'circuit-design'
            : 'unknown';
      requests.push({
        scenario,
        authorized,
        model: body.model,
        stream: body.stream,
        tools: Array.isArray(body.tools) ? body.tools.length : 0,
      });

      if (!authorized) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'mock authorization rejected' } }));
        return;
      }
      if (scenario === 'provider-check') {
        sendProviderText(response, body, 'OK');
        return;
      }
      if (scenario === 'circuit-design') {
        const notebook = [
          '# Agent-generated RC low-pass filter',
          '',
          '```spice',
          '* First-order low-pass filter with AC verification',
          'V1 in 0 DC 0 AC 1',
          'R1 in out 1k',
          'C1 out 0 100n',
          '.ac dec 30 10 1meg',
          '.meas ac output_1khz_db FIND vdb(out) AT=1k',
          '.end',
          '```',
        ].join('\n');
        sendProviderText(response, body, JSON.stringify({
          text: 'I prepared a revisioned RC low-pass design and will compile, simulate, and document it.',
          isDesignRequest: true,
          isRevisionRequest: false,
          formalizedRequirement: 'Create and verify a first-order RC low-pass filter.',
          projectName,
          projectOperations: [{
            op: 'upsert_module_netlist',
            module_id: 'filter',
            name: 'RC low-pass filter',
            kind: 'filter',
            function: 'First-order low-pass response with a nominal 1.59 kHz cutoff.',
            netlist_notebook: notebook,
          }],
          compileAfterApply: true,
          simulateAfterApply: true,
        }));
        return;
      }
      if (scenario === 'technical-report') {
        sendProviderText(response, body, [
          '# RC Low-Pass Filter Technical Report',
          '',
          `Verification marker: ${reportMarker}`,
          '',
          '## Executive summary',
          'The immutable project evidence describes a first-order RC low-pass filter. This report records only the supplied revision, ERC, build, and simulation evidence.',
          '',
          '## Requirements and assumptions',
          'The requested design uses a 1 kΩ series resistor, a 100 nF shunt capacitor, and an AC source with unit small-signal magnitude.',
          '',
          '## Circuit architecture and signal flow',
          'V1 drives net `in`; R1 connects `in` to `out`; C1 connects `out` to ground. The topology is a passive single-pole low-pass network.',
          '',
          '## Component and parameter rationale',
          'The nominal pole is determined by 1/(2πRC). Component IDs and values are quoted from the generated netlist rather than inferred.',
          '',
          '## ERC and connectivity status',
          'The report relies on the persisted ERC artifact. No connectivity result is invented beyond that evidence.',
          '',
          '## Simulation setup',
          'The netlist requests an AC decade sweep from 10 Hz to 1 MHz and measures `output_1khz_db` at 1 kHz.',
          '',
          '## Results and specification assessment',
          'Execution, measurement, and specification status are reported independently by the simulation artifact.',
          '',
          '## Limitations and risks',
          'Ideal component models omit tolerance, parasitics, source impedance, and load variation.',
          '',
          '## Reproduction steps',
          'Open the generated project revision, compile the system netlist, and run the recorded AC analysis with ngspice.',
        ].join('\n'));
        return;
      }

      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'unknown mock request' } }));
    } catch (error) {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      if (!response.writableEnded) {
        response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
      }
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

async function findNgspiceBinary() {
  const configuredPaths = [];
  if (process.env.NGSPICE_BIN?.trim()) configuredPaths.push(process.env.NGSPICE_BIN.trim());
  for (const configPath of [
    path.resolve(root, 'skills', 'circuit-design-ngspice', 'tool_paths.json'),
    path.resolve(root, 'embedded', 'circuit-design', 'tool_paths.json'),
  ]) {
    try {
      const config = JSON.parse(await readFile(configPath, 'utf8'));
      if (typeof config.ngspice_bin === 'string' && config.ngspice_bin.trim()) {
        configuredPaths.push(config.ngspice_bin.trim());
      }
    } catch {
      // An optional local tool-path file may be absent.
    }
  }
  for (const candidate of configuredPaths) {
    try {
      await access(candidate);
      return path.resolve(candidate);
    } catch {
      // Try the next configured path.
    }
  }
  throw new Error('A real ngspice binary is required for the agent-flow E2E test. Set NGSPICE_BIN or configure skills/circuit-design-ngspice/tool_paths.json.');
}

function settingsField(dialog, label) {
  return dialog.getByText(label, { exact: true }).locator('..').locator('input');
}

async function findProjectByName(name) {
  const entries = await readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectRoot = path.resolve(projectsRoot, entry.name);
    try {
      const project = JSON.parse(await readFile(path.resolve(projectRoot, 'project.circuit.json'), 'utf8'));
      if (project.name === name) return { projectRoot, project };
    } catch {
      // Ignore non-project folders.
    }
  }
  throw new Error(`Project not found: ${name}`);
}

function filteredPageErrors(errors) {
  return errors.filter((entry) => !(
    entry.includes('ERR_NETWORK_ACCESS_DENIED')
    || entry.includes('ERR_CONNECTION_CLOSED')
    || entry.includes('Monaco initialization')
    || entry === 'pageerror: Event'
  ));
}

await mkdir(outputRoot, { recursive: true });
await mkdir(workspaceRoot, { recursive: true });
await mkdir(userDataDir, { recursive: true });
await mkdir(homeDir, { recursive: true });

const ngspiceBinary = await findNgspiceBinary();
const mock = await startMockProvider();
const viteProcess = await startVite();
const electronDistDir = path.resolve(root, 'node_modules', 'electron', 'dist');
const electronApp = await electron.launch({
  args: [
    `--user-data-dir=${userDataDir}`,
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests',
    '--allow-file-access-from-files',
    '.',
  ],
  cwd: root,
  env: {
    ...process.env,
    ACTOVIQ_E2E: '1',
    ACTOVIQ_E2E_WORKSPACE_ROOT: workspaceRoot,
    ACTOVIQ_RENDERER_URL: viteUrl,
    HOME: homeDir,
    USERPROFILE: homeDir,
    PATH: `${electronDistDir}${path.delimiter}${process.env.PATH ?? ''}`,
  },
  slowMo: 25,
});

let page;
const pageErrors = [];
try {
  page = await electronApp.firstWindow();
  page.setDefaultTimeout(45_000);
  page.setDefaultNavigationTimeout(45_000);
  page.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`);
  });
  await page.getByTestId('circuit-empty-state').waitFor({ timeout: 30_000 });

  await page.getByTestId('topbar-settings').click();
  const settings = page.getByTestId('settings-dialog');
  await settings.waitFor();
  await settings.getByTestId('settings-provider-preset').selectOption('deepseek');
  await settingsField(settings, 'Base URL').fill(mock.baseUrl);
  await settingsField(settings, 'API key').fill(fakeApiKey);
  await settingsField(settings, 'Chat model').fill('mock-deepseek-chat');
  await settingsField(settings, 'Reasoning model').fill('mock-deepseek-reasoner');
  await settingsField(settings, 'ngspice Binary').fill(ngspiceBinary);
  await settings.getByTestId('settings-test-provider').click();
  await settings.getByTestId('settings-provider-test-result').getByText(/Connected to mock-deepseek-chat/).waitFor({ timeout: 30_000 });
  await page.screenshot({ path: path.resolve(outputRoot, 'agent-flow-settings.png') });
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await settings.getByRole('button', { name: /Saved/ }).waitFor();
  await settings.getByTestId('settings-dialog-close').click();
  await settings.waitFor({ state: 'detached' });

  await page.getByTestId('topbar-chat').click();
  await page.getByTestId('chat-composer').fill(`${designMarker}: design, compile, simulate, and document a 1.6 kHz RC low-pass filter.`);
  await page.getByTestId('chat-send').click();
  await page.getByTestId('chat-streaming-message').waitFor({ timeout: 30_000 });
  await page.getByText(/Technical report generated for revision 1/).waitFor({ timeout: 120_000 });
  await page.getByText(/Applied 1 project operation at revision 1/).waitFor({ timeout: 30_000 });
  await page.screenshot({ path: path.resolve(outputRoot, 'agent-flow-chat.png') });

  const { projectRoot, project } = await findProjectByName(projectName);
  assert.equal(project.revision, 1);
  assert.equal(project.modules.length, 1);
  const module = JSON.parse(await readFile(path.resolve(projectRoot, 'modules', 'filter', 'module.circuit.json'), 'utf8'));
  assert.match(module.spice.source, /\.ac dec 30 10 1meg/i);
  assert(module.components.some((component) => component.type === 'R'));
  assert(module.components.some((component) => component.type === 'C'));

  const erc = JSON.parse(await readFile(path.resolve(projectRoot, 'build', 'erc.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.resolve(projectRoot, 'build', 'build-manifest.json'), 'utf8'));
  const simulation = JSON.parse(await readFile(path.resolve(projectRoot, 'build', 'system', 'simulation', 'result.json'), 'utf8'));
  const technicalReport = await readFile(path.resolve(projectRoot, 'build', 'system', 'technical-report.md'), 'utf8');
  const technicalReportMetadata = JSON.parse(await readFile(path.resolve(projectRoot, 'build', 'system', 'technical-report.json'), 'utf8'));
  assert.equal(erc.blocking, false);
  assert.equal(erc.summary.errors, 0);
  assert.equal(manifest.status, 'simulated');
  assert.equal(Number(manifest.source_revision), 1);
  assert.equal(simulation.ok, true);
  assert.equal(simulation.execution_status, 'success');
  assert.equal(Number(simulation.source_revision), 1);
  assert.match(technicalReport, new RegExp(reportMarker));
  assert.equal(technicalReportMetadata.schema, 'actoviq.technical-report.v1');
  assert.equal(technicalReportMetadata.source_revision, 1);
  assert.equal(technicalReportMetadata.model, 'mock-deepseek-reasoner');

  await page.getByTestId('topbar-tab-simulation').click();
  await page.getByTestId('project-simulation').waitFor({ timeout: 30_000 });
  await page.getByRole('cell', { name: 'output_1khz_db', exact: true }).waitFor({ timeout: 30_000 });
  await page.screenshot({ path: path.resolve(outputRoot, 'agent-flow-simulation.png') });

  await page.getByTestId('topbar-tab-report').click();
  const report = page.getByTestId('project-report');
  await report.waitFor();
  await report.getByText(reportMarker, { exact: false }).waitFor();
  await page.screenshot({ path: path.resolve(outputRoot, 'agent-flow-report.png') });

  assert.deepEqual(mock.requests.map((request) => request.scenario), [
    'provider-check',
    'circuit-design',
    'technical-report',
  ]);
  assert(mock.requests.every((request) => request.authorized));
  assert.equal(mock.requests[0]?.stream, false);
  assert.equal(mock.requests[1]?.stream, true);
  assert.equal(mock.requests[2]?.stream, false);
  assert(mock.requests.every((request) => request.tools === 0));
  assert.deepEqual(filteredPageErrors(pageErrors), []);

  const result = {
    ok: true,
    projectId: project.project_id,
    projectRevision: project.revision,
    ercErrors: erc.summary.errors,
    buildStatus: manifest.status,
    simulationExecutionStatus: simulation.execution_status,
    reportSchema: technicalReportMetadata.schema,
    providerScenarios: mock.requests.map((request) => request.scenario),
    screenshots: [
      'output/playwright/agent-flow-settings.png',
      'output/playwright/agent-flow-chat.png',
      'output/playwright/agent-flow-simulation.png',
      'output/playwright/agent-flow-report.png',
    ],
  };
  await writeFile(path.resolve(outputRoot, 'agent-flow-result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.resolve(outputRoot, 'agent-flow-failure.png') }).catch(() => undefined);
    console.error(JSON.stringify({
      title: await page.title().catch(() => ''),
      text: (await page.locator('body').innerText().catch(() => '')).slice(0, 4000),
      pageErrors: filteredPageErrors(pageErrors),
    }, null, 2));
  }
  throw error;
} finally {
  await electronApp.close().catch(() => undefined);
  viteProcess.kill();
  await mock.close().catch(() => undefined);
  await rm(runRoot, { recursive: true, force: true });
}
