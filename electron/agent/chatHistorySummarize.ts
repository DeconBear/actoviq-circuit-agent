/** LLM summarization for over-budget chat history (uses Basic model). */

import path from 'node:path';
import { homedir } from 'node:os';
import { createAgentSdk } from 'actoviq-agent-sdk';
import {
  clipContent,
  type CompressibleMessage,
  CONTEXT_SUMMARY_RESERVE_TOKENS,
} from './modelTiers.js';

const SUMMARY_AGENT = 'desktop-chat-history-summarizer';
const MAX_TRANSCRIPT_CHARS = 120_000;

export interface ChatHistorySummarizeConfig {
  provider: 'anthropic' | 'openai';
  apiKey: string;
  baseURL: string;
  /** Prefer Basic / cheap model. */
  model: string;
  workDir?: string;
}

function formatTranscript(older: CompressibleMessage[]): string {
  const lines = older.map((message, index) => (
    `${index + 1}. ${message.role.toUpperCase()}: ${message.content}`
  ));
  let text = lines.join('\n\n');
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    text = `${text.slice(0, MAX_TRANSCRIPT_CHARS - 24)}\n…[truncated]`;
  }
  return text;
}

/**
 * Summarize older chat turns into a compact English briefing for the agent.
 * Throws on provider/SDK failure so callers can fall back to truncation.
 */
export async function summarizeOlderChatTurns(
  config: ChatHistorySummarizeConfig,
  older: CompressibleMessage[],
): Promise<string> {
  if (older.length === 0) return '';
  if (!config.model.trim()) {
    throw new Error('Basic model is required for chat history summarization.');
  }

  const transcript = formatTranscript(older);
  let sdk: Awaited<ReturnType<typeof createAgentSdk>> | null = null;
  try {
    sdk = await createAgentSdk({
      provider: config.provider,
      apiKey: config.apiKey,
      authToken: config.provider === 'anthropic' ? config.apiKey : undefined,
      baseURL: config.baseURL,
      model: config.model,
      maxTokens: 1_200,
      maxRetries: 0,
      runTimeoutMs: 45_000,
      workDir: path.resolve(config.workDir || process.cwd()),
      sessionDirectory: path.join(homedir(), '.actoviq', 'desktop-agent-sessions'),
      clientName: 'actoviq-circuit-agent-desktop-history-summarizer',
      tools: [],
      agents: [{
        name: SUMMARY_AGENT,
        description: 'Summarizes older desktop chat turns for context compression.',
        systemPrompt: [
          'You compress earlier conversation turns for a circuit-design desktop agent.',
          'Write a concise English summary that preserves goals, decisions, constraints,',
          'component/net names, open questions, and user preferences.',
          'Do not call tools. Do not ask questions. Output only the summary prose.',
        ].join(' '),
        tools: [],
        mcpServers: [],
        inheritDefaultTools: false,
        inheritDefaultMcpServers: false,
        allowNestedAgents: false,
        maxToolIterations: 0,
        source: 'custom',
      }],
      disableDefaultAgents: true,
      disableDefaultSkills: true,
      loadDefaultAgentDirectories: false,
      loadDefaultSkillDirectories: false,
      permissionMode: 'plan',
    });

    const result = await sdk.runWithAgent(
      SUMMARY_AGENT,
      `Summarize the following older conversation turns:\n\n${transcript}`,
      {
        maxTokens: 1_200,
        temperature: 0,
      },
    );
    const text = typeof result.text === 'string' ? result.text.trim() : '';
    if (!text) throw new Error('Empty summarization response.');
    return clipContent(text, CONTEXT_SUMMARY_RESERVE_TOKENS);
  } finally {
    await sdk?.close().catch(() => undefined);
  }
}
