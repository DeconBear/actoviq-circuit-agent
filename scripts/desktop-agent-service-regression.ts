import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  closeDesktopAgentService,
  generateDesktopTechnicalReport,
  startDesktopAgentRun,
  type DesktopAgentChatResponse,
  type DesktopAgentConfig,
  type DesktopAgentEvent,
} from '../electron/agent/desktopAgentService.ts';

interface RecordedRequest {
  scenario: string;
  authorized: boolean;
  body: Record<string, unknown>;
}

interface MockServer {
  baseURL: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

const DESIGN_MARKER = 'DESIGN_SCENARIO';
const FOLLOWUP_MARKER = 'FOLLOWUP_SCENARIO';
const REPAIR_MARKER = 'REPAIR_SCENARIO';
const CANCEL_MARKER = 'CANCEL_SCENARIO';
const LEAK_MARKER = 'LEAK_SCENARIO';
const REPORT_MARKER = 'ACTOVIQ_REPORT_REGRESSION_MARKER';

function openAiChunk(id: string, model: string, content: string, finishReason: string | null = null) {
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

function writeEvent(response: ServerResponse, payload: unknown): void {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function readRequestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

function serializedMessages(body: Record<string, unknown>): string {
  return JSON.stringify(body.messages ?? []);
}

function sendStreamingJson(response: ServerResponse, value: Record<string, unknown>): void {
  const id = `chatcmpl_mock_${Date.now()}`;
  const model = 'mock-circuit-v1';
  const content = JSON.stringify(value);
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  writeEvent(response, {
    ...openAiChunk(id, model, ''),
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  });
  for (let offset = 0; offset < content.length; offset += 9) {
    writeEvent(response, openAiChunk(id, model, content.slice(offset, offset + 9)));
  }
  writeEvent(response, {
    ...openAiChunk(id, model, '', 'stop'),
    usage: { prompt_tokens: 31, completion_tokens: 17, total_tokens: 48 },
  });
  response.write('data: [DONE]\n\n');
  response.end();
}

function sendStreamingText(response: ServerResponse, content: string): void {
  const id = `chatcmpl_mock_${Date.now()}`;
  const model = 'mock-circuit-v1';
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  writeEvent(response, {
    ...openAiChunk(id, model, ''),
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  });
  for (let offset = 0; offset < content.length; offset += 17) {
    writeEvent(response, openAiChunk(id, model, content.slice(offset, offset + 17)));
  }
  writeEvent(response, {
    ...openAiChunk(id, model, '', 'stop'),
    usage: { prompt_tokens: 61, completion_tokens: 43, total_tokens: 104 },
  });
  response.write('data: [DONE]\n\n');
  response.end();
}

function sendCompletionText(response: ServerResponse, content: string): void {
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({
    id: `chatcmpl_mock_${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'mock-circuit-v1',
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 61, completion_tokens: 43, total_tokens: 104 },
  }));
}

async function sendCancellableStream(response: ServerResponse): Promise<void> {
  const id = `chatcmpl_cancel_${Date.now()}`;
  const model = 'mock-circuit-v1';
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  writeEvent(response, {
    ...openAiChunk(id, model, ''),
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  });
  writeEvent(response, openAiChunk(id, model, '{"text":"Waiting for cancellation'));

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      if (!response.destroyed) {
        writeEvent(response, openAiChunk(id, model, ' timed out","isDesignRequest":false}', 'stop'));
        response.write('data: [DONE]\n\n');
        response.end();
      }
      finish();
    }, 5_000);
    response.once('close', finish);
  });
}

async function startMockServer(expectedToken: string): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404).end();
        return;
      }
      const body = await readRequestJson(request);
      const messages = serializedMessages(body);
      const authorized = request.headers.authorization === `Bearer ${expectedToken}`;
      let scenario = 'unknown';

      if (messages.includes('previous answer did not match the required JSON schema')) {
        scenario = 'repair-corrected';
      } else if (messages.includes(CANCEL_MARKER)) {
        scenario = 'cancel';
      } else if (messages.includes(LEAK_MARKER)) {
        scenario = 'leak-error';
      } else if (messages.includes(FOLLOWUP_MARKER)) {
        scenario = 'followup';
      } else if (messages.includes(REPAIR_MARKER)) {
        scenario = 'repair-invalid';
      } else if (messages.includes('Verified evidence JSON:')) {
        scenario = 'technical-report';
      } else if (messages.includes(DESIGN_MARKER)) {
        scenario = 'design';
      }
      requests.push({ scenario, authorized, body });

      if (!authorized) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'missing mock authorization' } }));
        return;
      }
      if (scenario === 'leak-error') {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          error: { message: `Rejected api_key=${expectedToken}; bearer ${expectedToken}` },
        }));
        return;
      }
      if (scenario === 'cancel') {
        await sendCancellableStream(response);
        return;
      }
      if (scenario === 'repair-invalid') {
        sendStreamingJson(response, { text: 17, projectOperations: 'invalid' });
        return;
      }
      if (scenario === 'repair-corrected') {
        sendStreamingJson(response, {
          text: 'The structured circuit transaction was repaired.',
          isDesignRequest: true,
          isRevisionRequest: false,
          formalizedRequirement: 'Create a mock current limiter.',
          projectKind: 'simulation',
          projectOperations: [{
            op: 'upsert_module_netlist',
            module_id: 'current-limiter',
            notebook: '```spice\nR1 IN OUT 100\n.end\n```',
          }],
          compileAfterApply: true,
          simulateAfterApply: false,
        });
        return;
      }
      if (scenario === 'technical-report') {
        const report = [
          '# RC Low-Pass Filter Technical Report',
          '',
          `Evidence marker: ${REPORT_MARKER}`,
          '',
          '## Executive summary',
          'The supplied revision describes an RC low-pass filter and the report is limited to the immutable evidence.',
          '',
          '## Requirements and assumptions',
          'The evidence requests a first-order low-pass response. No unstated performance result is claimed.',
          '',
          '## Circuit architecture and signal flow',
          'R1 drives OUT from IN and C1 shunts OUT to ground.',
          '',
          '## ERC and connectivity status',
          'The supplied ERC evidence reports no blocking errors.',
          '',
          '## Simulation setup and results',
          'The supplied evidence contains the AC analysis directive; numeric results must come from the recorded simulation artifact.',
          '',
          '## Limitations and risks',
          'No result beyond the supplied revision and hash is inferred.',
          '',
          '## Reproduction steps',
          'Compile the recorded revision, run its declared analysis, and compare the resulting hash.',
        ].join('\n');
        if (body.stream === true) sendStreamingText(response, report);
        else sendCompletionText(response, report);
        return;
      }
      if (scenario === 'followup') {
        sendStreamingJson(response, {
          text: 'Prepared a revision that changes the resistor value.',
          isDesignRequest: false,
          isRevisionRequest: true,
          revisionRequest: 'Change R1 from 1k to 2k.',
          projectOperations: [{
            op: 'set_module_component_value',
            module_id: 'rc-filter',
            component_id: 'R1',
            value: '2k',
          }],
          compileAfterApply: true,
          simulateAfterApply: true,
        });
        return;
      }
      if (scenario === 'design') {
        sendStreamingJson(response, {
          text: 'Created a validated RC low-pass transaction.',
          isDesignRequest: true,
          isRevisionRequest: false,
          formalizedRequirement: 'Create an RC low-pass filter.',
          projectName: 'Mock RC',
          projectKind: 'simulation',
          projectOperations: [{
            op: 'upsert_module_netlist',
            module_id: 'rc-filter',
            notebook: '```spice\nR1 IN OUT 1k\nC1 OUT 0 1u\n.end\n```',
          }],
          compileAfterApply: true,
          simulateAfterApply: false,
        });
        return;
      }

      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'unknown mock scenario' } }));
    } catch {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      if (!response.writableEnded) response.end(JSON.stringify({ error: { message: 'mock server failure' } }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

function startRun(
  config: DesktopAgentConfig,
  conversationId: string,
  message: string,
): { events: DesktopAgentEvent[]; handle: ReturnType<typeof startDesktopAgentRun> } {
  const events: DesktopAgentEvent[] = [];
  const handle = startDesktopAgentRun(
    config,
    { conversationId, message, context: { activeJobId: null, activeProject: null } },
    (event) => events.push(event),
  );
  return { events, handle };
}

function assertOrderedEvents(events: DesktopAgentEvent[], conversationId: string): void {
  assert(events.length > 0, 'the desktop agent must emit typed events');
  for (let index = 0; index < events.length; index += 1) {
    assert.equal(events[index]?.conversationId, conversationId);
    assert.equal(events[index]?.sequence, index + 1);
    assert.equal(typeof events[index]?.timestamp, 'number');
  }
}

async function waitForEvent(
  events: DesktopAgentEvent[],
  type: DesktopAgentEvent['type'],
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (events.some((event) => event.type === type)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${type}`);
}

async function listFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile()) result.push(entryPath);
    }
  };
  await visit(root);
  return result;
}

async function assertSecretAbsentFromFiles(root: string, secret: string): Promise<void> {
  const needle = Buffer.from(secret, 'utf8');
  for (const filePath of await listFiles(root)) {
    const contents = await readFile(filePath);
    assert.equal(contents.includes(needle), false, `credential leaked into ${path.relative(root, filePath)}`);
  }
}

function assertSecretAbsentFromValues(secret: string, values: unknown[]): void {
  const serialized = JSON.stringify(values);
  assert.equal(serialized.includes(secret), false, 'credential leaked into an event or result');
}

async function runMockRegression(): Promise<void> {
  const secret = ['sk', 'mock', 'desktop-agent', Date.now().toString(36)].join('-');
  const homeDir = await mkdtemp(path.join(tmpdir(), 'actoviq-desktop-agent-test-'));
  const mock = await startMockServer(secret);
  const config: DesktopAgentConfig = {
    provider: 'openai',
    apiKey: secret,
    baseURL: mock.baseURL,
    model: 'mock-circuit',
    homeDir,
    workDir: process.cwd(),
  };
  const allEvents: DesktopAgentEvent[] = [];
  const allResults: DesktopAgentChatResponse[] = [];

  try {
    const first = startRun(config, 'conversation-persistent', `${DESIGN_MARKER}: design an RC filter.`);
    const firstResult = await first.handle.result;
    allEvents.push(...first.events);
    allResults.push(firstResult);
    assert.equal(firstResult.isError, undefined);
    assert.equal(firstResult.isDesignRequest, true);
    assert.equal(firstResult.projectKind, 'simulation');
    assert.equal(firstResult.projectOperations?.[0]?.op, 'upsert_module_netlist');
    assert(first.events.some((event) => event.type === 'run-started'));
    assert(first.events.some((event) => event.type === 'status'));
    assert(first.events.filter((event) => event.type === 'text-progress').length >= 2);
    assert(first.events.some((event) => event.type === 'usage'));
    assert.equal(first.events.at(-1)?.type, 'completed');
    assertOrderedEvents(first.events, 'conversation-persistent');

    const second = startRun(config, 'conversation-persistent', `${FOLLOWUP_MARKER}: change R1 to 2k.`);
    const secondResult = await second.handle.result;
    allEvents.push(...second.events);
    allResults.push(secondResult);
    assert.equal(secondResult.isRevisionRequest, true);
    assert.equal(secondResult.projectOperations?.[0]?.op, 'set_module_component_value');
    assert.equal(secondResult.sessionId, firstResult.sessionId, 'a conversation must reuse its SDK session');
    assertOrderedEvents(second.events, 'conversation-persistent');

    const designRequest = mock.requests.find((request) => request.scenario === 'design');
    const followupRequest = mock.requests.find((request) => request.scenario === 'followup');
    assert(designRequest && followupRequest);
    const firstMessages = designRequest.body.messages as unknown[];
    const secondMessages = followupRequest.body.messages as unknown[];
    assert(Array.isArray(firstMessages) && Array.isArray(secondMessages));
    assert(secondMessages.length > firstMessages.length, 'the second request must include persisted session history');
    assert(serializedMessages(followupRequest.body).includes('Created a validated RC low-pass transaction.'));
    assert.equal(Array.isArray(designRequest.body.tools) && designRequest.body.tools.length > 0, false);

    const repair = startRun(config, 'conversation-repair', `${REPAIR_MARKER}: create a current limiter.`);
    const repairResult = await repair.handle.result;
    allEvents.push(...repair.events);
    allResults.push(repairResult);
    assert.equal(repairResult.isError, undefined);
    assert.equal(repairResult.projectOperations?.[0]?.op, 'upsert_module_netlist');
    assert(repair.events.some((event) => event.type === 'retry'));
    assert.equal(mock.requests.filter((request) => request.scenario === 'repair-invalid').length, 1);
    assert.equal(mock.requests.filter((request) => request.scenario === 'repair-corrected').length, 1);
    assertOrderedEvents(repair.events, 'conversation-repair');

    const cancellable = startRun(config, 'conversation-cancel', `${CANCEL_MARKER}: wait until stopped.`);
    await waitForEvent(cancellable.events, 'text-progress');
    cancellable.handle.cancel('Stopped by regression test');
    const cancelledResult = await Promise.race([
      cancellable.handle.result,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('cancel did not settle')), 2_000)),
    ]);
    allEvents.push(...cancellable.events);
    allResults.push(cancelledResult);
    assert.equal(cancelledResult.isError, true);
    assert(cancellable.events.some((event) => event.type === 'cancelled'));
    assert.equal(cancellable.events.some((event) => event.type === 'completed'), false);
    assertOrderedEvents(cancellable.events, 'conversation-cancel');

    const leakingError = startRun(config, 'conversation-error', `${LEAK_MARKER}: return an authentication error.`);
    const leakingResult = await leakingError.handle.result;
    allEvents.push(...leakingError.events);
    allResults.push(leakingResult);
    assert.equal(leakingResult.isError, true);
    assert(leakingError.events.some((event) => event.type === 'error'));
    assertOrderedEvents(leakingError.events, 'conversation-error');

    const reportResult = await generateDesktopTechnicalReport(config, {
      projectId: 'mock-rc-project',
      sourceRevision: 2,
      documentHash: 'sha256:mock-document',
      evidence: {
        erc: { blocking: false, errors: [] },
        netlist: 'R1 IN OUT 1k\nC1 OUT 0 1u\n.ac dec 20 10 1meg\n.end',
        simulation: { execution_status: 'success', source_revision: 2 },
      },
    });
    assert.match(reportResult.report, new RegExp(REPORT_MARKER));
    assert.equal(reportResult.model, config.model);
    const reportRequest = mock.requests.find((request) => request.scenario === 'technical-report');
    assert(reportRequest);
    assert.equal(Array.isArray(reportRequest.body.tools) && reportRequest.body.tools.length > 0, false);
    assertSecretAbsentFromValues(secret, [reportResult]);

    assert(mock.requests.every((request) => request.authorized));
    assertSecretAbsentFromValues(secret, [...allEvents, ...allResults]);
    await closeDesktopAgentService();
    await assertSecretAbsentFromFiles(homeDir, secret);
  } finally {
    await closeDesktopAgentService();
    await mock.close();
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function runLiveDeepSeekSmoke(): Promise<'passed' | 'skipped'> {
  if (process.env.ACTOVIQ_LIVE_DEEPSEEK !== '1') return 'skipped';
  const apiKey = process.env.ACTOVIQ_API_KEY?.trim();
  assert(apiKey, 'ACTOVIQ_API_KEY is required when ACTOVIQ_LIVE_DEEPSEEK=1');
  const homeDir = await mkdtemp(path.join(tmpdir(), 'actoviq-live-agent-test-'));
  const events: DesktopAgentEvent[] = [];
  let result: DesktopAgentChatResponse | undefined;
  try {
    const handle = startDesktopAgentRun({
      provider: 'openai',
      apiKey,
      baseURL: process.env.ACTOVIQ_BASE_URL?.trim() || 'https://api.deepseek.com',
      model: process.env.ACTOVIQ_MODEL?.trim() || 'deepseek-chat',
      homeDir,
      workDir: process.cwd(),
    }, {
      conversationId: `live-smoke-${Date.now()}`,
      message: 'Reply briefly that the built-in circuit assistant is ready. Do not create a design.',
      context: { activeJobId: null, activeProject: null },
    }, (event) => events.push(event));
    result = await handle.result;
    assert.equal(result.isError, undefined, 'the live provider returned an agent error');
    assert(events.some((event) => event.type === 'text-progress'));
    assert(events.some((event) => event.type === 'completed'));
    assertSecretAbsentFromValues(apiKey, [...events, result]);
    await closeDesktopAgentService();
    await assertSecretAbsentFromFiles(homeDir, apiKey);
    return 'passed';
  } finally {
    await closeDesktopAgentService();
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await runMockRegression();
  const liveStatus = await runLiveDeepSeekSmoke();
  console.log(`desktop agent SDK regression: passed (live DeepSeek: ${liveStatus})`);
}

main().catch((error) => {
  const raw = error instanceof Error ? error.stack || error.message : String(error);
  const apiKey = process.env.ACTOVIQ_API_KEY;
  const safe = apiKey ? raw.replaceAll(apiKey, '[redacted]') : raw;
  console.error(safe);
  process.exitCode = 1;
});
