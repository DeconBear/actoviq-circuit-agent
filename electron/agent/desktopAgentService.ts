import { createHash } from 'node:crypto';
import path from 'node:path';
import { homedir } from 'node:os';
import {
  createAgentSdk,
  type ActoviqAgentClient,
  type AgentEvent,
  type AgentSession,
} from 'actoviq-agent-sdk';
import { z } from 'zod';

const DESKTOP_AGENT_NAME = 'actoviq-circuit-desktop';
const REPORT_AGENT_NAME = 'actoviq-circuit-report-writer';
const MAX_INITIAL_HISTORY_MESSAGES = 20;
const MAX_CONTEXT_CHARS = 16_000;

const INTENT_SYSTEM_PROMPT = `You are Actoviq Circuit Agent, the built-in assistant in an electronic circuit design application.

You translate a user's request into a safe, revisioned project transaction. You do not call tools. The desktop host validates and applies every operation.

Rules:
1. Put the JSON field "text" first so the desktop can stream the natural-language response while the rest is generated.
2. For greetings, general questions, or requests that are not for a concrete circuit, set isDesignRequest and isRevisionRequest to false and answer briefly.
3. For a request to modify, tune, fix, optimize, rerun, or validate the selected design, set isRevisionRequest to true and include revisionRequest.
4. For a new circuit, set isDesignRequest to true and include formalizedRequirement.
5. Never set both request flags to true. Prefer revision when activeProject exists and the user refers to the current design.
6. Project transactions are the default design path. If enough information exists, include projectOperations using only operations listed in activeProject.transaction.allowed_operations. For a new design, prefer functional modules: several upsert_module_netlist ops (stimuli / stage cores / encode-load), then add_port and connect_ports for shared nets (vdd, vin, thresholds, etc.). Use a single upsert_module_netlist only for trivial paths (about ≤8 devices, one signal chain). For a revision, use stable IDs from activeProject. Honor project_kind: simulation stays primitive-only; pcb_schematic may use packaged parts and LCSC binding; analog_ic requires SPICE/PDK-aware transistor sizing and Virtuoso export. Honor activeProject.modularity guidance and oversized_module ERC warnings by splitting rather than packing more devices into one sheet.
7. Never include project_id, base_revision, generated SVG, or build files in projectOperations. Never claim a transaction or simulation succeeded; the host reports the result after validation.
8. Set compileAfterApply true after electrical changes. Set simulateAfterApply true only when the design includes a valid analysis and stimulus, and when project_kind requires or requests simulation (simulation kind: usually yes; pcb_schematic: optional).
9. If the request cannot be translated safely, return no projectOperations and ask one concise clarification question.
10. targetStage, when present, must be one of: solution-analyst, doc-writer, librarian, architect, netlist-designer, simulation-verifier, netlistsvg-renderer, workflow-lead.
11. For every new design, set projectKind to simulation, pcb_schematic, or analog_ic from the user's requested workflow. For pcb_schematic part selection, prefer bind_lcsc_part when LCSC tools are available in agent context. Do not invent LCSC C-numbers.
12. For analog_ic, never invent a PDK name, model-library path, corner, or foundry device. If they are missing, ask for them before returning electrical projectOperations. When supplied, include set_analog_ic_profile and reference the exact library/corner in SPICE.
13. Every analog_ic MOS primitive or MOS-like subcircuit must give explicit positive W and L with SPICE scale suffixes. Preserve M and NF as separate positive design variables; NF is an integer. State in text what is held fixed when proposing a channel-size change. Do not emit user-authored .control/.endc blocks.
14. Treat KiCad/JLCEDA pull as stable-ID layout/property handoff, not lossless connectivity co-editing. A canonical LCSC C-number carries catalog metadata but does not prove symbol/pin/footprint compatibility.
15. Prefer workspace reference_catalog assets (circuit_module / circuit_project / schematic_layout / layout_idiom) before inventing topology. Layout references are not electrical truth: only apply when connectivity_hash matches; otherwise use them as agent_context_only. Never treat layout_visual images as a source write path.
Return only one JSON object with this shape:
{
  "text": "Natural-language response",
  "isDesignRequest": boolean,
  "isRevisionRequest": boolean,
  "formalizedRequirement": "optional",
  "revisionRequest": "optional",
  "targetStage": "optional",
  "projectName": "optional",
  "projectKind": "simulation | pcb_schematic | analog_ic (required for a new design)",
  "projectOperations": [{"op": "supported operation"}],
  "compileAfterApply": boolean,
  "simulateAfterApply": boolean
}`;

const REPORT_SYSTEM_PROMPT = `You are the built-in Actoviq circuit technical report writer.

Write a precise engineering report in Markdown from the supplied immutable project, ERC, build, and simulation evidence.

Required sections:
1. Executive summary
2. Requirements and assumptions
3. Circuit architecture and signal flow
4. Component and parameter rationale
5. ERC and connectivity status
6. Simulation setup
7. Results and specification assessment
8. Limitations and risks
9. Reproduction steps

Rules:
- Never invent a measurement, pass result, topology, model, or test that is absent from the evidence.
- Clearly label missing or stale evidence.
- Quote component IDs, net names, analysis directives, revision, and hashes when useful.
- Distinguish execution_status, measurement_status, and specification_status.
- Use concise tables for measurements and specifications when data exists.
- Do not call tools and do not wrap the report in a Markdown code fence.`;

const ProjectOperationSchema = z.object({
  op: z.string().min(1),
}).catchall(z.unknown());

const ChatResponseSchema = z.object({
  text: z.string().min(1),
  isDesignRequest: z.boolean().default(false),
  isRevisionRequest: z.boolean().default(false),
  formalizedRequirement: z.string().optional(),
  revisionRequest: z.string().optional(),
  targetStage: z.string().optional(),
  projectName: z.string().optional(),
  projectKind: z.enum(['simulation', 'pcb_schematic', 'analog_ic']).optional(),
  projectOperations: z.array(ProjectOperationSchema).optional(),
  compileAfterApply: z.boolean().optional(),
  simulateAfterApply: z.boolean().optional(),
}).passthrough().superRefine((value, context) => {
  if (
    value.isDesignRequest
    && !value.isRevisionRequest
    && (value.projectOperations?.length ?? 0) > 0
    && !value.projectKind
  ) {
    context.addIssue({
      code: 'custom',
      path: ['projectKind'],
      message: 'projectKind is required when creating a new project transaction',
    });
  }
});

export interface DesktopAgentConfig {
  provider: 'anthropic' | 'openai';
  apiKey: string;
  baseURL: string;
  model: string;
  workDir?: string;
  homeDir?: string;
}

export interface DesktopAgentContext {
  activeJobId?: string | null;
  activeProject?: Record<string, unknown> | null;
}

export interface DesktopAgentRunInput {
  conversationId: string;
  message: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  context?: DesktopAgentContext;
}

export interface DesktopAgentChatResponse {
  text: string;
  isDesignRequest: boolean;
  formalizedRequirement?: string;
  isRevisionRequest?: boolean;
  revisionRequest?: string;
  targetStage?: string;
  projectName?: string;
  projectKind?: 'simulation' | 'pcb_schematic' | 'analog_ic';
  projectOperations?: Array<Record<string, unknown>>;
  compileAfterApply?: boolean;
  simulateAfterApply?: boolean;
  isError?: boolean;
  runId?: string;
  sessionId?: string;
  model?: string;
  usage?: Record<string, unknown>;
}

export type DesktopAgentEventType =
  | 'run-started'
  | 'status'
  | 'text-progress'
  | 'thinking-delta'
  | 'tool-call'
  | 'tool-result'
  | 'compacted'
  | 'model-fallback'
  | 'retry'
  | 'usage'
  | 'completed'
  | 'cancelled'
  | 'error';

export interface DesktopAgentEvent {
  type: DesktopAgentEventType;
  conversationId: string;
  sequence: number;
  timestamp: number;
  runId?: string;
  sessionId?: string;
  model?: string;
  text?: string;
  delta?: string;
  label?: string;
  iteration?: number;
  toolName?: string;
  toolUseId?: string;
  usage?: Record<string, unknown>;
}

export interface DesktopAgentRunHandle {
  result: Promise<DesktopAgentChatResponse>;
  cancel: (reason?: string) => void;
}

interface CachedClient {
  signature: string;
  client: ActoviqAgentClient;
}

let cachedClient: CachedClient | null = null;
let clientTransition: Promise<void> = Promise.resolve();

function configSignature(config: DesktopAgentConfig): string {
  return createHash('sha256')
    .update(JSON.stringify({
      provider: config.provider,
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      model: config.model,
      workDir: config.workDir,
      homeDir: config.homeDir,
    }))
    .digest('hex');
}

async function getClient(config: DesktopAgentConfig): Promise<ActoviqAgentClient> {
  const signature = configSignature(config);
  if (cachedClient?.signature === signature) return cachedClient.client;

  let resolved: ActoviqAgentClient | null = null;
  clientTransition = clientTransition.then(async () => {
    if (cachedClient?.signature === signature) {
      resolved = cachedClient.client;
      return;
    }
    if (cachedClient) {
      await cachedClient.client.close().catch(() => undefined);
      cachedClient = null;
    }
    const workDir = path.resolve(config.workDir || process.cwd());
    const homeDir = path.resolve(config.homeDir || path.join(homedir(), '.actoviq'));
    const client = await createAgentSdk({
      provider: config.provider,
      apiKey: config.apiKey,
      authToken: config.provider === 'anthropic' ? config.apiKey : undefined,
      baseURL: config.baseURL,
      model: config.model,
      workDir,
      homeDir,
      sessionDirectory: path.join(homeDir, 'circuit-agent-desktop', 'sessions'),
      clientName: 'actoviq-circuit-agent-desktop',
      clientVersion: '0.1.11',
      tools: [],
      mcpServers: [],
      disableDefaultAgents: true,
      loadDefaultAgentDirectories: false,
      disableDefaultSkills: true,
      loadDefaultSkillDirectories: false,
      permissionMode: 'default',
      maxToolIterations: 0,
      agents: [{
        name: DESKTOP_AGENT_NAME,
        description: 'Built-in circuit intent and revision transaction agent.',
        systemPrompt: INTENT_SYSTEM_PROMPT,
        model: config.model,
        tools: [],
        mcpServers: [],
        inheritDefaultTools: false,
        inheritDefaultMcpServers: false,
        allowNestedAgents: false,
        maxToolIterations: 0,
        source: 'custom',
      }, {
        name: REPORT_AGENT_NAME,
        description: 'Writes a revision-bound technical report from verified circuit artifacts.',
        systemPrompt: REPORT_SYSTEM_PROMPT,
        model: config.model,
        tools: [],
        mcpServers: [],
        inheritDefaultTools: false,
        inheritDefaultMcpServers: false,
        allowNestedAgents: false,
        maxToolIterations: 0,
        source: 'custom',
      }],
    });
    cachedClient = { signature, client };
    resolved = client;
  });
  await clientTransition;
  if (!resolved) throw new Error('Unable to initialize the desktop agent runtime.');
  return resolved;
}

function normalizeSessionId(conversationId: string): string {
  const readable = conversationId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 72) || 'conversation';
  const suffix = createHash('sha256').update(conversationId).digest('hex').slice(0, 12);
  return `circuit-${readable}-${suffix}`;
}

async function getSession(
  client: ActoviqAgentClient,
  config: DesktopAgentConfig,
  input: DesktopAgentRunInput,
): Promise<AgentSession> {
  const sessionId = normalizeSessionId(input.conversationId);
  try {
    const session = await client.sessions.get(sessionId);
    if (session.model !== config.model) await session.setModel(config.model);
    return session;
  } catch {
    const initialMessages = (input.history ?? [])
      .slice(-MAX_INITIAL_HISTORY_MESSAGES)
      .map((message) => ({ role: message.role, content: message.content }));
    return client.createAgentSession(DESKTOP_AGENT_NAME, {
      id: sessionId,
      title: input.message.slice(0, 80),
      model: config.model,
      initialMessages,
      tags: ['desktop', 'circuit-design'],
      metadata: { desktopConversationId: input.conversationId },
    });
  }
}

function buildPrompt(input: DesktopAgentRunInput): string {
  const activeProject = input.context?.activeProject
    ? JSON.stringify(input.context.activeProject).slice(0, MAX_CONTEXT_CHARS)
    : '(none)';
  return [
    'Desktop context:',
    `- activeJobId: ${input.context?.activeJobId ?? '(none)'}`,
    `- activeProject: ${activeProject}`,
    '',
    'User message:',
    input.message,
  ].join('\n');
}

function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return raw.slice(start, index + 1);
    }
  }
  return null;
}

function decodePartialJsonString(raw: string): string {
  let result = '';
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char !== '\\') {
      result += char;
      continue;
    }
    const next = raw[index + 1];
    if (next === undefined) break;
    const escapes: Record<string, string> = {
      '"': '"',
      '\\': '\\',
      '/': '/',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
    };
    if (next === 'u') {
      const hex = raw.slice(index + 2, index + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
      result += String.fromCharCode(Number.parseInt(hex, 16));
      index += 5;
    } else {
      result += escapes[next] ?? next;
      index += 1;
    }
  }
  return result;
}

function extractStreamingText(snapshot: string): string {
  const key = /"text"\s*:\s*"/.exec(snapshot);
  if (!key || key.index === undefined) return '';
  const start = key.index + key[0].length;
  let escaped = false;
  let raw = '';
  for (let index = start; index < snapshot.length; index += 1) {
    const char = snapshot[index];
    if (!escaped && char === '"') break;
    raw += char;
    if (escaped) escaped = false;
    else if (char === '\\') escaped = true;
  }
  return decodePartialJsonString(raw);
}

function parseChatResponse(raw: string): DesktopAgentChatResponse {
  const json = extractJsonObject(raw);
  if (!json) throw new Error('The model response did not contain a JSON object.');
  const parsed = ChatResponseSchema.parse(JSON.parse(json));
  const isRevisionRequest = Boolean(parsed.isRevisionRequest);
  return {
    text: parsed.text,
    isRevisionRequest,
    isDesignRequest: !isRevisionRequest && Boolean(parsed.isDesignRequest),
    formalizedRequirement: parsed.formalizedRequirement,
    revisionRequest: parsed.revisionRequest,
    targetStage: parsed.targetStage,
    projectName: parsed.projectName,
    projectKind: parsed.projectKind,
    projectOperations: parsed.projectOperations,
    compileAfterApply: parsed.compileAfterApply,
    simulateAfterApply: parsed.simulateAfterApply,
  };
}

export function sanitizeAgentError(error: unknown): string {
  const source = error instanceof Error ? error.message : String(error);
  return source
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/(bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[redacted]')
    .replace(/((?:api[_ -]?key|auth[_ -]?token)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .slice(0, 1200);
}

export function startDesktopAgentRun(
  config: DesktopAgentConfig,
  input: DesktopAgentRunInput,
  onEvent: (event: DesktopAgentEvent) => void,
): DesktopAgentRunHandle {
  const abortController = new AbortController();
  let activeStream: { cancel: (reason?: string) => void } | null = null;
  let sequence = 0;
  let lastRunId: string | undefined;
  let lastSessionId: string | undefined;
  let lastModel = config.model;

  const emit = (event: Omit<DesktopAgentEvent, 'conversationId' | 'sequence' | 'timestamp'>): void => {
    onEvent({
      ...event,
      conversationId: input.conversationId,
      sequence: sequence += 1,
      timestamp: Date.now(),
    });
  };

  const runAttempt = async (session: AgentSession, prompt: string, attempt: number): Promise<{
    raw: string;
    runId?: string;
    sessionId?: string;
    model: string;
    usage?: Record<string, unknown>;
  }> => {
    let raw = '';
    let visibleText = '';
    let usage: Record<string, unknown> | undefined;
    const stream = session.stream(prompt, {
      signal: abortController.signal,
      maxTokens: 4096,
      temperature: 0.1,
      metadata: { surface: 'desktop', attempt },
    });
    activeStream = stream;
    for await (const event of stream) {
      const sdkEvent = event as AgentEvent;
      lastRunId = sdkEvent.runId;
      switch (sdkEvent.type) {
        case 'run.started':
          lastSessionId = sdkEvent.sessionId;
          lastModel = sdkEvent.model;
          emit({ type: 'run-started', runId: sdkEvent.runId, sessionId: sdkEvent.sessionId, model: sdkEvent.model });
          break;
        case 'request.started':
          emit({
            type: 'status',
            runId: sdkEvent.runId,
            iteration: sdkEvent.iteration,
            label: attempt === 1 ? 'Generating circuit response' : 'Repairing structured response',
          });
          break;
        case 'response.text.delta': {
          raw = sdkEvent.snapshot;
          const nextText = extractStreamingText(sdkEvent.snapshot);
          if (nextText !== visibleText) {
            const delta = nextText.startsWith(visibleText) ? nextText.slice(visibleText.length) : nextText;
            visibleText = nextText;
            emit({ type: 'text-progress', runId: sdkEvent.runId, text: nextText, delta });
          }
          break;
        }
        case 'response.thinking.delta':
          emit({ type: 'thinking-delta', runId: sdkEvent.runId, delta: sdkEvent.delta });
          break;
        case 'tool.call':
          emit({
            type: 'tool-call',
            runId: sdkEvent.runId,
            toolName: sdkEvent.call.name,
            toolUseId: sdkEvent.call.id,
            label: 'Unexpected tool request blocked by the desktop agent profile',
          });
          break;
        case 'tool.result':
          emit({
            type: 'tool-result',
            runId: sdkEvent.runId,
            toolName: sdkEvent.result.name,
            toolUseId: sdkEvent.result.id,
          });
          break;
        case 'session.compacted':
        case 'conversation.compacted':
          emit({ type: 'compacted', runId: sdkEvent.runId, label: 'Conversation context compacted' });
          break;
        case 'model.fallback':
          lastModel = sdkEvent.toModel;
          emit({
            type: 'model-fallback',
            runId: sdkEvent.runId,
            model: sdkEvent.toModel,
            label: `${sdkEvent.fromModel} → ${sdkEvent.toModel}`,
          });
          break;
        case 'response.completed':
          raw = sdkEvent.result.text;
          usage = sdkEvent.result.usage as unknown as Record<string, unknown> | undefined;
          if (usage) emit({ type: 'usage', runId: sdkEvent.runId, usage });
          break;
        case 'error':
          throw new Error(sanitizeAgentError(sdkEvent.error.message));
        default:
          break;
      }
    }
    const result = await stream.result;
    activeStream = null;
    return {
      raw: result.text || raw,
      runId: result.runId,
      sessionId: result.sessionId,
      model: result.model,
      usage: (result.usage as unknown as Record<string, unknown> | undefined) ?? usage,
    };
  };

  const result = (async (): Promise<DesktopAgentChatResponse> => {
    try {
      const client = await getClient(config);
      const session = await getSession(client, config, input);
      const first = await runAttempt(session, buildPrompt(input), 1);
      let parsed: DesktopAgentChatResponse;
      try {
        parsed = parseChatResponse(first.raw);
      } catch (firstError) {
        emit({
          type: 'retry',
          runId: first.runId,
          label: `Structured response validation failed: ${sanitizeAgentError(firstError)}`,
        });
        const repaired = await runAttempt(
          session,
          'Your previous answer did not match the required JSON schema. Return a corrected JSON object only. Put the "text" field first and preserve the original user intent.',
          2,
        );
        parsed = parseChatResponse(repaired.raw);
        Object.assign(first, repaired);
      }
      const completed: DesktopAgentChatResponse = {
        ...parsed,
        runId: first.runId,
        sessionId: first.sessionId ?? session.id,
        model: first.model,
        usage: first.usage,
      };
      emit({
        type: 'completed',
        runId: completed.runId,
        sessionId: completed.sessionId,
        model: completed.model,
        text: completed.text,
        usage: completed.usage,
      });
      return completed;
    } catch (error) {
      const message = sanitizeAgentError(error);
      if (abortController.signal.aborted) {
        emit({ type: 'cancelled', runId: lastRunId, sessionId: lastSessionId, model: lastModel, label: message || 'Cancelled' });
        return {
          text: 'The request was stopped.',
          isDesignRequest: false,
          isRevisionRequest: false,
          isError: true,
          runId: lastRunId,
          sessionId: lastSessionId,
          model: lastModel,
        };
      }
      emit({ type: 'error', runId: lastRunId, sessionId: lastSessionId, model: lastModel, label: message });
      return {
        text: `Agent error: ${message}`,
        isDesignRequest: false,
        isRevisionRequest: false,
        isError: true,
        runId: lastRunId,
        sessionId: lastSessionId,
        model: lastModel,
      };
    } finally {
      activeStream = null;
    }
  })();

  return {
    result,
    cancel: (reason = 'Stopped by user') => {
      abortController.abort(reason);
      activeStream?.cancel(reason);
    },
  };
}

export async function closeDesktopAgentService(): Promise<void> {
  await clientTransition;
  if (!cachedClient) return;
  const client = cachedClient.client;
  cachedClient = null;
  await client.close().catch(() => undefined);
}

export interface TechnicalReportInput {
  projectId: string;
  sourceRevision: number;
  documentHash?: string;
  evidence: Record<string, unknown>;
}

export interface TechnicalReportResult {
  report: string;
  model: string;
  runId: string;
  usage?: Record<string, unknown>;
}

export async function generateDesktopTechnicalReport(
  config: DesktopAgentConfig,
  input: TechnicalReportInput,
): Promise<TechnicalReportResult> {
  const client = await getClient(config);
  const evidence = JSON.stringify(input.evidence).slice(0, 120_000);
  const result = await client.runWithAgent(REPORT_AGENT_NAME, [
    `Project: ${input.projectId}`,
    `Source revision: ${input.sourceRevision}`,
    `Document hash: ${input.documentHash ?? '(unavailable)'}`,
    '',
    'Verified evidence JSON:',
    evidence,
  ].join('\n'), {
    model: config.model,
    maxTokens: 7000,
    temperature: 0.1,
    metadata: {
      surface: 'desktop-technical-report',
      projectId: input.projectId,
      sourceRevision: input.sourceRevision,
    },
  });
  const report = result.text.trim();
  if (!report || report.length < 200) {
    throw new Error('The report agent returned an incomplete technical report.');
  }
  return {
    report,
    model: result.model,
    runId: result.runId,
    usage: result.usage as unknown as Record<string, unknown> | undefined,
  };
}
