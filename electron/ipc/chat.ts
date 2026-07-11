import { IpcMain } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';

interface ChatResponse {
  text: string;
  isDesignRequest: boolean;
  formalizedRequirement?: string;
  isRevisionRequest?: boolean;
  revisionRequest?: string;
  targetStage?: string;
  projectName?: string;
  projectOperations?: Array<Record<string, unknown>>;
  compileAfterApply?: boolean;
  simulateAfterApply?: boolean;
  isError?: boolean;
}

interface ChatContext {
  activeJobId?: string | null;
  activeProject?: Record<string, unknown> | null;
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const MAX_CONTEXT_MESSAGES = 20;
const MAX_CONTEXT_CHARS = 16000;

const INTENT_SYSTEM_PROMPT = `You are Actoviq Circuit Agent, an AI assistant specialized in electronic circuit design.

Rules:
1. If the user's message is a simple greeting, casual chat, question about your capabilities, or anything NOT related to designing a specific circuit, respond naturally and briefly as a helpful assistant. Set isDesignRequest and isRevisionRequest to false.
2. If the user asks to modify, revise, tune, fix, optimize, rerun, or validate the currently selected/existing design, set isRevisionRequest to true. Also provide a concise revisionRequest.
3. If they mention a workflow step, artifact, netlist, simulation, schematic, rendering, report, or summary, include targetStage with the closest stage key: solution-analyst, doc-writer, librarian, architect, netlist-designer, simulation-verifier, netlistsvg-renderer, workflow-lead.
4. If the user describes a brand-new circuit they want designed, set isDesignRequest to true and provide formalizedRequirement - a detailed requirement suitable for the design workflow.
5. Never set both isDesignRequest and isRevisionRequest to true. Prefer isRevisionRequest when desktop context has activeProject and the user refers to changing "this", "current", "existing", or "the design".
6. Project transactions are the default design path. When enough information exists, include projectOperations using only operations listed in activeProject.transaction.allowed_operations. For a new design, use one or more upsert_module_netlist operations whose netlist_notebook contains a fenced spice block. For an existing design, use stable IDs from activeProject and do not invent IDs for items being modified.
7. Do not include project_id, base_revision, generated SVG, or build files inside projectOperations; the application wraps operations in the current revisioned transaction. Set compileAfterApply true after electrical changes. Set simulateAfterApply true only when the netlist contains a valid analysis and stimulus.
8. If an existing project request cannot be translated safely from the supplied context, return no projectOperations and ask one concise clarification question. Never silently route a Project edit to a legacy job.
9. Be conversational and helpful. Keep text concise because the structured transaction carries the implementation.

Respond ONLY with valid JSON in this exact format:
{
  "isDesignRequest": boolean,
  "isRevisionRequest": boolean,
  "text": "Your natural language response to the user",
  "formalizedRequirement": "Only include if isDesignRequest is true: a detailed circuit design requirement",
  "revisionRequest": "Only include if isRevisionRequest is true: a detailed change request for the selected existing job",
  "targetStage": "Optional legacy workflow stage key",
  "projectName": "For a new project transaction only",
  "projectOperations": [{"op": "A supported project transaction operation"}],
  "compileAfterApply": boolean,
  "simulateAfterApply": boolean
}`;

function buildContextMessages(
  history: Array<{ role: string; content: string }>,
  currentMessage: string,
  context?: ChatContext,
): Array<{ role: string; content: string }> {
  const recent = history.slice(-MAX_CONTEXT_MESSAGES);
  const result: Array<{ role: string; content: string }> = [];
  let totalChars = 0;

  for (let i = recent.length - 1; i >= 0 && totalChars < MAX_CONTEXT_CHARS; i--) {
    const msg = recent[i];
    if (!msg) continue;
    result.unshift(msg);
    totalChars += msg.content.length;
  }

  if (result.length < recent.length) {
    result.unshift({
      role: 'assistant',
      content: `[Earlier conversation summary: ${recent.length - result.length} messages omitted due to context limits.]`,
    });
  }

  result.push({
    role: 'user',
    content: [
      'Desktop context:',
      `- activeJobId: ${context?.activeJobId ?? '(none)'}`,
      `- activeProject: ${context?.activeProject
        ? JSON.stringify(context.activeProject).slice(0, MAX_CONTEXT_CHARS)
        : '(none)'}`,
      '',
      'User message:',
      currentMessage,
    ].join('\n'),
  });

  return result;
}

async function loadSettings(): Promise<{
  actoviqBaseUrl: string;
  actoviqAuthToken: string;
  sonnetModel: string;
  haikuModel: string;
}> {
  const settingsPath = path.join(homedir(), '.actoviq', 'actoviq-circuit-agent-desktop.json');
  try {
    const raw = await readFile(settingsPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {
      actoviqBaseUrl: DEFAULT_BASE_URL,
      actoviqAuthToken: '',
      sonnetModel: 'claude-sonnet-4-6',
      haikuModel: DEFAULT_MODEL,
    };
  }
}

async function callLLM(
  baseUrl: string,
  authToken: string,
  model: string,
  systemPrompt: string,
  messages: Array<{ role: string; content: string }>,
): Promise<string> {
  const url = `${baseUrl.replace(/\/$/, '')}/v1/messages`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': authToken,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`API error ${response.status}: ${errorText}`);
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text?: string }>;
  };

  const textContent = data.content?.find((c) => c.type === 'text');
  return textContent?.text ?? '';
}

export function registerChatHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('chat:send', async (
    _event,
    message: string,
    history?: Array<{ role: string; content: string }>,
    context?: ChatContext,
  ): Promise<ChatResponse> => {
    const settings = await loadSettings();
    const baseUrl = settings.actoviqBaseUrl || DEFAULT_BASE_URL;
    const authToken = settings.actoviqAuthToken;

    if (!authToken) {
      return {
        text: 'Please configure your API token in Settings before chatting.',
        isDesignRequest: false,
        isRevisionRequest: false,
        isError: true,
      };
    }

    try {
      const messages = buildContextMessages(history ?? [], message, context);
      const rawResponse = await callLLM(
        baseUrl,
        authToken,
        settings.haikuModel || DEFAULT_MODEL,
        INTENT_SYSTEM_PROMPT,
        messages,
      );

      const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as ChatResponse;
        const isRevisionRequest = Boolean(parsed.isRevisionRequest);
        const isDesignRequest = !isRevisionRequest && Boolean(parsed.isDesignRequest);
        return {
          text: parsed.text || rawResponse,
          isDesignRequest,
          formalizedRequirement: parsed.formalizedRequirement,
          isRevisionRequest,
          revisionRequest: parsed.revisionRequest,
          targetStage: parsed.targetStage,
          projectName: parsed.projectName,
          projectOperations: Array.isArray(parsed.projectOperations) ? parsed.projectOperations : undefined,
          compileAfterApply: parsed.compileAfterApply,
          simulateAfterApply: parsed.simulateAfterApply,
        };
      }

      return {
        text: rawResponse,
        isDesignRequest: false,
        isRevisionRequest: false,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        text: `Chat error: ${errorMessage}`,
        isDesignRequest: false,
        isRevisionRequest: false,
        isError: true,
      };
    }
  });
}
