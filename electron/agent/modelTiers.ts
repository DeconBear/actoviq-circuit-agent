/** Model tier + context compression helpers for the Electron chat path. */

export type ChatModelTier = 'basic' | 'medium' | 'professional';

export const CONTEXT_TOKENS_DEFAULT = 200_000;
export const CONTEXT_TOKENS_1M = 1_000_000;
export const CONTEXT_RESPONSE_RESERVE_TOKENS = 12_000;

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

export function compressChatHistory(
  history: CompressibleMessage[],
  maxTokens: number,
): { history: CompressibleMessage[]; compressed: boolean; estimatedTokens: number } {
  const budget = Math.max(2_000, maxTokens - CONTEXT_RESPONSE_RESERVE_TOKENS);
  const kept: CompressibleMessage[] = [];
  let used = 0;

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (!message) continue;
    const cost = estimateTokens(message.content) + 8;
    if (kept.length > 0 && used + cost > budget) break;
    kept.unshift(message);
    used += cost;
  }

  const compressed = kept.length < history.length;
  if (compressed) {
    const dropped = history.length - kept.length;
    kept.unshift({
      role: 'assistant',
      content: `[Earlier conversation compressed: ${dropped} older message${dropped === 1 ? '' : 's'} omitted to stay within the ${maxTokens.toLocaleString()}-token context limit.]`,
    });
  }

  return {
    history: kept,
    compressed,
    estimatedTokens: kept.reduce((sum, message) => sum + estimateTokens(message.content) + 8, 0),
  };
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
