/**
 * Unit checks: chat transcript must keep every turn when `messages` desyncs
 * from `conversationMessages` (the wipe-then-append bug).
 *
 * Run: npx tsx scripts/chat-transcript-desync-unit.ts
 */
import assert from 'node:assert/strict';
import { useAppStore } from '../renderer/src/store/appStore.ts';
import { mergeChatTranscript } from '../renderer/src/store/chatHistoryPersistence.ts';
import type { ChatMessage } from '../renderer/src/types.ts';

function msg(
  partial: Pick<ChatMessage, 'id' | 'role' | 'content'> & Partial<ChatMessage>,
): ChatMessage {
  return {
    timestamp: Date.now(),
    ...partial,
  };
}

function resetStore(): void {
  useAppStore.setState({
    conversationId: '',
    conversations: [],
    conversationMessages: {},
    activeConversationByProject: {},
    messages: [],
    activeProjectId: null,
  });
}

function main(): void {
  resetStore();
  const cid = useAppStore.getState().newConversation('proj-buck');
  const store = useAppStore.getState();

  store.addMessage(msg({
    id: 'u1',
    role: 'user',
    content: 'Design a synchronous buck DC-DC converter',
    conversationId: cid,
  }));
  store.addMessage(msg({
    id: 'a1',
    role: 'assistant',
    content: 'Created project and ran tools.',
    conversationId: cid,
    tools: [{ id: 't1', name: 'create_circuit_project', status: 'done', label: 'Creating circuit project' }],
  }));

  assert.equal(useAppStore.getState().messages.length, 2);
  assert.equal(useAppStore.getState().conversationMessages[cid]?.length, 2);

  // Reproduce the historical bug: live `messages` wiped while stored history remains.
  useAppStore.setState({ messages: [] });
  assert.equal(useAppStore.getState().messages.length, 0);
  assert.equal(useAppStore.getState().conversationMessages[cid]?.length, 2);

  useAppStore.getState().addMessage(msg({
    id: 'u2',
    role: 'user',
    content: 'Confirm L and Cout in this same conversation',
    conversationId: cid,
  }));

  const after = useAppStore.getState();
  assert.equal(after.conversationMessages[cid]?.length, 3, 'stored history must keep turn 1');
  assert.equal(after.messages.length, 3, 'live messages must heal from stored history');
  assert.equal(after.messages[0]?.id, 'u1');
  assert.equal(after.messages[1]?.id, 'a1');
  assert.equal(after.messages[2]?.id, 'u2');

  after.addMessage(msg({
    id: 'a2',
    role: 'assistant',
    content: 'L=22uH, Cout=100uF',
    conversationId: cid,
  }));
  const finalState = useAppStore.getState();
  assert.equal(finalState.messages.length, 4);
  assert.equal(finalState.conversationMessages[cid]?.length, 4);
  assert.ok(finalState.messages.some((entry) => entry.content.includes('synchronous buck')));
  assert.ok(finalState.messages.some((entry) => entry.content.includes('Confirm L and Cout')));
  assert.ok(finalState.messages.some((entry) => entry.content.includes('22uH')));

  // patchMessage should keep the active transcript mirrored to the longer canonical list.
  useAppStore.setState({ messages: finalState.messages.slice(-1) });
  useAppStore.getState().patchMessage('a2', { content: 'L=22uH, Cout=100uF (patched)' });
  const patched = useAppStore.getState();
  assert.equal(patched.messages.length, 4);
  assert.match(patched.messages.find((entry) => entry.id === 'a2')?.content ?? '', /patched/);

  // healActiveTranscript restores a wiped live buffer without appending.
  useAppStore.setState({ messages: [] });
  useAppStore.getState().healActiveTranscript();
  assert.equal(useAppStore.getState().messages.length, 4);

  // merge by id keeps both sides when each has unique turns.
  const merged = mergeChatTranscript(
    [msg({ id: 'u1', role: 'user', content: 'old' }), msg({ id: 'a1', role: 'assistant', content: 'reply' })],
    [msg({ id: 'a1', role: 'assistant', content: 'reply patched' }), msg({ id: 'u2', role: 'user', content: 'next' })],
  );
  assert.equal(merged.length, 3);
  assert.equal(merged.find((entry) => entry.id === 'a1')?.content, 'reply patched');
  assert.ok(merged.some((entry) => entry.id === 'u2'));

  // resetWorkflow must not orphan-wipe the live transcript.
  useAppStore.getState().resetWorkflow();
  assert.equal(useAppStore.getState().messages.length, 4, 'resetWorkflow should heal, not wipe history');

  console.log(JSON.stringify({
    ok: true,
    conversationId: cid,
    messageCount: useAppStore.getState().messages.length,
  }));
}

main();
