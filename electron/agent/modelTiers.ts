/** Model tier + context compression helpers for the Electron chat path. */

export type ChatModelTier = 'basic' | 'medium' | 'professional';

export const CONTEXT_TOKENS_DEFAULT = 200_000;
export const CONTEXT_TOKENS_1M = 1_000_000;
export const CONTEXT_RESPONSE_RESERVE_TOKENS = 12_000;
/** Reserved for the summary assistant message when older turns are condensed. */
export const CONTEXT_SUMMARY_RESERVE_TOKENS = 2_500;
/** Hard cap for any single message before summarization / truncation. */
export const CONTEXT_MAX_MESSAGE_TOKENS = 24_000;

export function contextLimitForTier(supports1M: boolean): number {
  return supports1M ? CONTEXT_TOKENS_1M : CONTEXT_TOKENS_DEFAULT;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export interface CompressibleMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type ChatHistoryPrepMode = 'none' | 'summarized' | 'truncated';

export interface PreparedChatHistory {
  history: CompressibleMessage[];
  compressed: boolean;
  mode: ChatHistoryPrepMode;
  estimatedTokens: number;
}

export function estimateMessageTokens(message: CompressibleMessage): number {
  return estimateTokens(message.content) + 8;
}

export function clipContent(content: string, maxTokens: number): string {
  const maxChars = Math.max(64, maxTokens * 4);
  if (content.length <= maxChars) return content;
  return `${content.slice(0, Math.max(0, maxChars - 24))}\n…[truncated]`;
}

export function clipHistoryMessages(
  history: CompressibleMessage[],
  maxMessageTokens = CONTEXT_MAX_MESSAGE_TOKENS,
): CompressibleMessage[] {
  return history.map((message) => ({
    ...message,
    content: clipContent(message.content, maxMessageTokens),
  }));
}

export function contextBudget(maxTokens: number): number {
  return Math.max(2_000, maxTokens - CONTEXT_RESPONSE_RESERVE_TOKENS);
}

export function estimateConversationTokens(
  history: CompressibleMessage[],
  currentMessage = '',
): number {
  return estimateTokens(currentMessage) + (currentMessage ? 8 : 0)
    + history.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

export function historyNeedsCompression(
  history: CompressibleMessage[],
  currentMessage: string,
  maxTokens: number,
): boolean {
  return estimateConversationTokens(history, currentMessage) > contextBudget(maxTokens);
}

/**
 * Keep the newest turns that fit under the remaining budget after reserving
 * room for the current user message and an optional summary prefix.
 */
export function splitHistoryForBudget(
  history: CompressibleMessage[],
  currentMessage: string,
  maxTokens: number,
  summaryReserveTokens = CONTEXT_SUMMARY_RESERVE_TOKENS,
): { recent: CompressibleMessage[]; older: CompressibleMessage[] } {
  const budget = contextBudget(maxTokens);
  const currentCost = estimateTokens(currentMessage) + (currentMessage ? 8 : 0);
  const available = Math.max(500, budget - currentCost - Math.max(0, summaryReserveTokens));
  const recent: CompressibleMessage[] = [];
  let used = 0;

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (!message) continue;
    const cost = estimateMessageTokens(message);
    if (recent.length > 0 && used + cost > available) break;
    if (recent.length === 0 && cost > available) {
      recent.unshift({
        ...message,
        content: clipContent(message.content, Math.max(256, available - 8)),
      });
      break;
    }
    recent.unshift(message);
    used += cost;
  }

  const older = history.slice(0, Math.max(0, history.length - recent.length));
  return { recent, older };
}

export function compressChatHistory(
  history: CompressibleMessage[],
  maxTokens: number,
  currentMessage = '',
): PreparedChatHistory {
  const clipped = clipHistoryMessages(history);
  const { recent, older } = splitHistoryForBudget(clipped, currentMessage, maxTokens, 0);
  const compressed = older.length > 0;
  const kept = [...recent];
  if (compressed) {
    kept.unshift({
      role: 'assistant',
      content: `[Earlier conversation compressed: ${older.length} older message${older.length === 1 ? '' : 's'} omitted to stay within the ${maxTokens.toLocaleString()}-token context limit.]`,
    });
  }
  return {
    history: kept,
    compressed,
    mode: compressed ? 'truncated' : 'none',
    estimatedTokens: estimateConversationTokens(kept, currentMessage),
  };
}

export function buildSummarizedHistory(
  summaryText: string,
  recent: CompressibleMessage[],
  olderCount: number,
  maxTokens: number,
  currentMessage = '',
): PreparedChatHistory {
  const summary = clipContent(summaryText.trim(), CONTEXT_SUMMARY_RESERVE_TOKENS);
  const preface: CompressibleMessage = {
    role: 'assistant',
    content: [
      `[Earlier conversation summarized (${olderCount} older message${olderCount === 1 ? '' : 's'}) to fit the ${maxTokens.toLocaleString()}-token context limit.]`,
      summary,
    ].join('\n\n'),
  };
  const history = [preface, ...recent];
  return {
    history,
    compressed: true,
    mode: 'summarized',
    estimatedTokens: estimateConversationTokens(history, currentMessage),
  };
}

/**
 * Prepare history for the agent. When over budget, call `summarizeOlder`
 * (typically an LLM). Failures fall back to truncation.
 */
export async function prepareChatHistory(options: {
  history: CompressibleMessage[];
  currentMessage: string;
  maxTokens: number;
  summarizeOlder: (older: CompressibleMessage[]) => Promise<string>;
}): Promise<PreparedChatHistory> {
  const clipped = clipHistoryMessages(options.history);
  if (!historyNeedsCompression(clipped, options.currentMessage, options.maxTokens)) {
    return {
      history: clipped,
      compressed: false,
      mode: 'none',
      estimatedTokens: estimateConversationTokens(clipped, options.currentMessage),
    };
  }

  const { recent, older } = splitHistoryForBudget(
    clipped,
    options.currentMessage,
    options.maxTokens,
    CONTEXT_SUMMARY_RESERVE_TOKENS,
  );

  if (older.length === 0) {
    return compressChatHistory(clipped, options.maxTokens, options.currentMessage);
  }

  try {
    const summary = await options.summarizeOlder(older);
    if (!summary.trim()) {
      return compressChatHistory(clipped, options.maxTokens, options.currentMessage);
    }
    const prepared = buildSummarizedHistory(
      summary,
      recent,
      older.length,
      options.maxTokens,
      options.currentMessage,
    );
    if (historyNeedsCompression(prepared.history, options.currentMessage, options.maxTokens)) {
      return compressChatHistory(
        [prepared.history[0]!, ...recent],
        options.maxTokens,
        options.currentMessage,
      );
    }
    return prepared;
  } catch {
    return compressChatHistory(clipped, options.maxTokens, options.currentMessage);
  }
}

export function resolveTierModel(
  settings: {
    basicModel: string;
    mediumModel: string;
    professionalModel: string;
    chatModel: string;
    reasoningModel: string;
  },
  tier: ChatModelTier,
): string {
  if (tier === 'basic') return settings.basicModel.trim() || settings.chatModel.trim();
  if (tier === 'professional') return settings.professionalModel.trim() || settings.reasoningModel.trim();
  return settings.mediumModel.trim() || settings.chatModel.trim();
}

export function resolveTierContext1M(
  settings: {
    basicContext1M: boolean;
    mediumContext1M: boolean;
    professionalContext1M: boolean;
  },
  tier: ChatModelTier,
): boolean {
  if (tier === 'basic') return settings.basicContext1M;
  if (tier === 'professional') return settings.professionalContext1M;
  return settings.mediumContext1M;
}
