/**
 * Unit checks for per-round assistant chat messages (renderer/src/store/chatRounds.ts).
 * A desktop ReAct run produces several assistant text rounds; the transcript must
 * keep every round as its own message, deduped by (runId, iteration), with
 * streamed tools preserved when the final reconciliation patches content.
 *
 * Run: npx tsx scripts/chat-rounds-unit.ts
 */
import assert from 'node:assert/strict';
import {
  assistantRoundMessageId,
  findAssistantRoundMessage,
  upsertAssistantRoundMessage,
  type ChatRoundStore,
} from '../renderer/src/store/chatRounds';
import { createAssistantRoundTracker } from '../electron/agent/assistantRounds';
import type { ChatMessage } from '../renderer/src/types';

function makeStore(): ChatRoundStore & { messages: ChatMessage[] } {
  const store = {
    messages: [] as ChatMessage[],
    conversationMessages: {} as Record<string, ChatMessage[]>,
    addMessage(msg: ChatMessage) {
      store.messages.push(msg);
      const cid = msg.conversationId ?? 'default';
      store.conversationMessages[cid] = [...(store.conversationMessages[cid] ?? []), msg];
    },
    patchMessage(id: string, patch: Partial<ChatMessage>) {
      const apply = (msg: ChatMessage) => Object.assign(msg, patch);
      store.messages.forEach((msg) => { if (msg.id === id) apply(msg); });
      Object.values(store.conversationMessages).forEach((list) => {
        list.forEach((msg) => { if (msg.id === id) apply(msg); });
      });
    },
  };
  return store;
}

const cid = 'conv-1';
const runId = 'run-abc';

// --- Streaming phase: round 1 tools land first (empty draft), then round 1 text.
{
  const store = makeStore();
  const draftId = assistantRoundMessageId(runId, 1);
  store.addMessage({ id: draftId, role: 'assistant', content: '', timestamp: 1, conversationId: cid, runId, tools: [
    { id: 't1', name: 'create_circuit_project', status: 'done', label: 'Create project' },
  ] });
  upsertAssistantRoundMessage(store, { conversationId: cid, runId, iteration: 1, text: '先创建项目骨架。', timestamp: 2 });
  const round1 = findAssistantRoundMessage(store, cid, runId, 1);
  assert.equal(round1?.content, '先创建项目骨架。');
  assert.equal(round1?.tools?.length, 1, 'streamed tools must survive the text patch');
  assert.equal(store.messages.length, 1, 'round 1 stays a single message');
}

// --- Finalize phase: reconciliation upserts all rounds, metadata on the last.
{
  const store = makeStore();
  // Simulate streamed state: round 1 already persisted with tools.
  store.addMessage({ id: assistantRoundMessageId(runId, 1), role: 'assistant', content: '第一轮', timestamp: 1, conversationId: cid, runId, tools: [
    { id: 't1', name: 'apply_circuit_command', status: 'done' },
  ] });
  const rounds = [
    { iteration: 1, text: '第一轮（完成版）' },
    { iteration: 2, text: '第二轮：编译通过。' },
    { iteration: 3, text: '最终总结。' },
  ];
  rounds.forEach((round, index) => {
    upsertAssistantRoundMessage(store, {
      conversationId: cid,
      runId,
      iteration: round.iteration,
      text: round.text,
      timestamp: 10 + index,
      meta: index === rounds.length - 1 ? { sessionId: 'sess-1', model: 'model-x', usage: { tokens: 42 } } : undefined,
    });
  });
  assert.equal(store.messages.length, 3, 'each round becomes its own message');
  assert.equal(store.messages[0]?.content, '第一轮（完成版）', 'reconciliation refreshes streamed text');
  assert.equal(store.messages[0]?.tools?.length, 1, 'streamed tools preserved on patch');
  assert.equal(store.messages[1]?.content, '第二轮：编译通过。');
  assert.equal(store.messages[2]?.content, '最终总结。');
  assert.equal(store.messages[2]?.sessionId, 'sess-1', 'run metadata lands on the final round');
  assert.equal(store.messages[0]?.sessionId, undefined, 'earlier rounds carry no run metadata');
  // Chronological order is append order.
  assert.deepEqual(
    store.messages.map((msg) => msg.id),
    [1, 2, 3].map((iteration) => assistantRoundMessageId(runId, iteration)),
  );
  // Idempotent re-finalize (e.g. IPC retry) never duplicates.
  upsertAssistantRoundMessage(store, { conversationId: cid, runId, iteration: 2, text: '第二轮：编译通过。', timestamp: 99 });
  assert.equal(store.messages.length, 3, 're-upsert dedupes by id');
}

// --- No-runId fallback keeps ids stable between stream and finalize.
{
  const store = makeStore();
  upsertAssistantRoundMessage(store, { conversationId: cid, runId: undefined, iteration: 1, text: '流式轮次', timestamp: 1 });
  upsertAssistantRoundMessage(store, { conversationId: cid, runId: undefined, iteration: 1, text: '定稿轮次', timestamp: 2 });
  assert.equal(store.messages.length, 1);
  assert.equal(store.messages[0]?.content, '定稿轮次');
}

// --- Service-side tracker: request.started boundaries flush completed rounds.
{
  const tracker = createAssistantRoundTracker();
  assert.equal(tracker.flushRequestBoundary(), null, 'boundary before any text has nothing to flush');
  tracker.handleTextDelta(1, '分析需求', '');
  tracker.handleTextDelta(1, '分析需求并创建项目。', '');
  const flushed1 = tracker.flushRequestBoundary();
  assert.deepEqual(flushed1, { iteration: 1, text: '分析需求并创建项目。' });
  assert.equal(tracker.flushRequestBoundary(), null, 'a flushed round never emits twice');
  tracker.handleTextDelta(2, '编译通过。', '');
  const flushed2 = tracker.flushRequestBoundary();
  assert.deepEqual(flushed2, { iteration: 2, text: '编译通过。' });
  tracker.handleTextDelta(3, '最终总结。', '');
  // Finalize prefers authoritative request summaries when present.
  const rounds = tracker.finalize([
    { iteration: 1, text: '分析需求并创建项目。' },
    { iteration: 2, text: '编译通过。' },
    { iteration: 3, text: '最终总结。' },
  ], '最终总结。');
  assert.deepEqual(rounds.map((round) => round.iteration), [1, 2, 3]);
}

// --- Tracker fallback: without summaries, streamed rounds + unflushed tail survive.
{
  const tracker = createAssistantRoundTracker();
  tracker.handleTextDelta(1, '第一轮。', '');
  tracker.flushRequestBoundary();
  tracker.handleTextDelta(2, '最后一轮。', '');
  const rounds = tracker.finalize(undefined, '最后一轮。');
  assert.deepEqual(rounds, [
    { iteration: 1, text: '第一轮。' },
    { iteration: 2, text: '最后一轮。' },
  ]);
  // Tool-only runs (no visible text anywhere) produce an empty round list.
  const silent = createAssistantRoundTracker();
  silent.flushRequestBoundary();
  assert.deepEqual(silent.finalize(undefined, ''), []);
}

console.log(JSON.stringify({ ok: true, checks: 5 }, null, 2));
