import { IpcMain } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';

interface ChatResponse {
  text: string;
  isDesignRequest: boolean;
  formalizedRequirement?: string;
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const MAX_CONTEXT_MESSAGES = 20;
const MAX_CONTEXT_CHARS = 8000;

const INTENT_SYSTEM_PROMPT = `You are Actoviq Circuit Agent, an AI assistant specialized in electronic circuit design. Your job is to help users design circuits.

Rules:
1. If the user's message is a simple greeting, casual chat, question about your capabilities, or anything NOT related to designing a specific circuit, respond naturally and briefly as a helpful assistant. Set isDesignRequest to false.
2. If the user describes a circuit they want designed (e.g., "Design a low-pass filter", "I need an amplifier", "Create an oscillator circuit"), acknowledge the request enthusiastically, briefly summarize what you understood, and set isDesignRequest to true. Also provide a formalizedRequirement — a re-stated, detailed version of the circuit requirement suitable for the design workflow.
3. Be conversational and helpful. If the request is ambiguous, ask clarifying questions rather than guessing.
4. Pay attention to the conversation history — your responses should be coherent with the ongoing discussion. If the user refers to something mentioned earlier, use that context.

Respond ONLY with valid JSON in this exact format:
{
  "isDesignRequest": boolean,
  "text": "Your natural language response to the user",
  "formalizedRequirement": "Only include if isDesignRequest is true: a detailed circuit design requirement"
}`;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function buildContextMessages(
  history: Array<{ role: string; content: string }>,
  currentMessage: string,
): Array<{ role: string; content: string }> {
  const recent = history.slice(-MAX_CONTEXT_MESSAGES);
  const result: Array<{ role: string; content: string }> = [];
  let totalChars = 0;
  let truncated = false;

  // Build from recent to oldest, respecting char limit
  for (let i = recent.length - 1; i >= 0 && totalChars < MAX_CONTEXT_CHARS; i--) {
    const msg = recent[i];
    if (!msg) continue;
    result.unshift(msg);
    totalChars += msg.content.length;
  }

  // If some messages were dropped, add a context summary
  if (result.length < recent.length) {
    truncated = true;
  }

  if (truncated && result.length > 0) {
    const summaryMsg = {
      role: 'assistant' as const,
      content: `[Earlier conversation summary: ${recent.length - result.length} messages omitted due to context limits. The following is the most recent part of the conversation.]`,
    };
    result.unshift(summaryMsg);
  }

  // Add current message
  result.push({ role: 'user', content: currentMessage });

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
      max_tokens: 1024,
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
  ipcMain.handle('chat:send', async (_event, message: string, history?: Array<{ role: string; content: string }>): Promise<ChatResponse> => {
    const settings = await loadSettings();
    const baseUrl = settings.actoviqBaseUrl || DEFAULT_BASE_URL;
    const authToken = settings.actoviqAuthToken;

    if (!authToken) {
      return {
        text: 'Please configure your API token in Settings (⚙) before chatting.',
        isDesignRequest: false,
      };
    }

    try {
      const messages = history && history.length > 0
        ? buildContextMessages(history, message)
        : [{ role: 'user' as const, content: message }];

      const rawResponse = await callLLM(
        baseUrl,
        authToken,
        settings.haikuModel || DEFAULT_MODEL,
        INTENT_SYSTEM_PROMPT,
        messages,
      );

      // Parse the JSON response from the LLM
      const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as ChatResponse;
        return {
          text: parsed.text || rawResponse,
          isDesignRequest: Boolean(parsed.isDesignRequest),
          formalizedRequirement: parsed.formalizedRequirement,
        };
      }

      // Fallback: treat as non-design chat
      return {
        text: rawResponse,
        isDesignRequest: false,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        text: `Chat error: ${errorMessage}`,
        isDesignRequest: false,
      };
    }
  });
}
