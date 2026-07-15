/**
 * Lightweight unit checks for chat history compression helpers.
 * Run: npx tsx scripts/chat-history-unit.ts
 */
import assert from 'node:assert/strict';
import {
  compressChatHistory,
  estimateConversationTokens,
  historyNeedsCompression,
  prepareChatHistory,
  splitHistoryForBudget,
  type CompressibleMessage,
} from '../electron/agent/modelTiers.ts';

function msg(role: 'user' | 'assistant', content: string): CompressibleMessage {
  return { role, content };
}

async function main(): Promise<void> {
  const shortHistory = [msg('user', 'hi'), msg('assistant', 'hello')];
  assert.equal(historyNeedsCompression(shortHistory, 'next', 200_000), false);

  const bulky = Array.from({ length: 40 }, (_, index) => (
    msg(index % 2 === 0 ? 'user' : 'assistant', 'x'.repeat(8_000))
  ));
  assert.equal(historyNeedsCompression(bulky, 'follow up', 8_000), true);

  const truncated = compressChatHistory(bulky, 8_000, 'follow up');
  assert.equal(truncated.mode, 'truncated');
  assert.ok(truncated.history.length < bulky.length);
  assert.ok(truncated.history[0]?.content.includes('compressed'));

  const { recent, older } = splitHistoryForBudget(bulky, 'follow up', 8_000);
  assert.ok(older.length > 0);
  assert.ok(recent.length > 0);

  const summarized = await prepareChatHistory({
    history: bulky,
    currentMessage: 'follow up',
    maxTokens: 8_000,
    summarizeOlder: async () => 'Prior turns covered an LDO design and load current.',
  });
  assert.equal(summarized.mode, 'summarized');
  assert.ok(summarized.history[0]?.content.includes('summarized'));
  assert.ok(summarized.history[0]?.content.includes('LDO'));

  const fallback = await prepareChatHistory({
    history: bulky,
    currentMessage: 'follow up',
    maxTokens: 8_000,
    summarizeOlder: async () => {
      throw new Error('provider down');
    },
  });
  assert.equal(fallback.mode, 'truncated');

  assert.ok(estimateConversationTokens(shortHistory, 'next') > 0);
  console.log(JSON.stringify({ ok: true, truncated: truncated.history.length, summarized: summarized.mode }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
