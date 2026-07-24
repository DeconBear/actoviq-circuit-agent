/**
 * Unit checks for per-project chat history visibility / legacy claim /
 * always-follow-active-project session switching.
 * Run: npx tsx scripts/chat-project-history-unit.ts
 */
import assert from 'node:assert/strict';
import {
  claimLegacyConversationsForProject,
  conversationBelongsToProjectScope,
  conversationHasContent,
  conversationsForProject,
  shouldPreserveChatOnProjectLoad,
} from '../renderer/src/store/chatHistoryPersistence.ts';
import { useAppStore } from '../renderer/src/store/appStore.ts';
import type { ConversationSummary } from '../renderer/src/types.ts';

function conv(partial: Partial<ConversationSummary> & { id: string }): ConversationSummary {
  return {
    title: 'New conversation',
    lastMessage: '',
    messageCount: 0,
    updatedAt: Date.now(),
    ...partial,
  };
}

const legacy = conv({
  id: 'legacy-1',
  title: '8-bit DAC',
  lastMessage: 'design a dac',
  messageCount: 4,
  updatedAt: 200,
  projectId: null,
});
const emptyScoped = conv({
  id: 'empty-1',
  title: 'New conversation',
  projectId: 'proj-a',
  updatedAt: 300,
});
const scoped = conv({
  id: 'scoped-1',
  title: 'LDO',
  lastMessage: 'simulate',
  messageCount: 2,
  updatedAt: 100,
  projectId: 'proj-a',
});

assert.equal(conversationHasContent(legacy), true);
assert.equal(conversationHasContent(emptyScoped), false);

const visible = conversationsForProject([legacy, emptyScoped], 'proj-a');
assert.deepEqual(visible.map((entry) => entry.id).sort(), ['empty-1', 'legacy-1']);

const claimed = claimLegacyConversationsForProject([legacy, emptyScoped], 'proj-a');
assert.equal(claimed.find((entry) => entry.id === 'legacy-1')?.projectId, 'proj-a');

const noClaimWhenScopedContent = claimLegacyConversationsForProject(
  [legacy, scoped],
  'proj-a',
);
assert.equal(noClaimWhenScopedContent.find((entry) => entry.id === 'legacy-1')?.projectId, null);

// --- preserveChat decision: user project switch never keeps prior session ---
assert.equal(
  shouldPreserveChatOnProjectLoad({
    previousProjectId: 'proj-a',
    nextProjectId: 'proj-b',
    chatInFlight: true,
    conversationAlreadyOnTarget: false,
  }),
  false,
  'in-flight chat must not block user A→B session switch',
);

assert.equal(
  shouldPreserveChatOnProjectLoad({
    explicitPreserve: true,
    previousProjectId: 'proj-a',
    nextProjectId: 'proj-b',
    chatInFlight: true,
  }),
  true,
  'agent explicit preserveChat keeps thread across project change',
);

assert.equal(
  shouldPreserveChatOnProjectLoad({
    previousProjectId: 'proj-a',
    nextProjectId: 'proj-a',
    chatInFlight: true,
  }),
  true,
  'same-project reload keeps in-flight chat',
);

assert.equal(
  shouldPreserveChatOnProjectLoad({
    previousProjectId: 'proj-a',
    nextProjectId: 'proj-a',
    conversationAlreadyOnTarget: true,
  }),
  true,
  'same-project reload keeps already-scoped conversation',
);

assert.equal(
  conversationBelongsToProjectScope(scoped, 'proj-a'),
  true,
);
assert.equal(
  conversationBelongsToProjectScope(scoped, 'proj-b'),
  false,
  'foreign project conversation must not appear in History',
);
assert.equal(
  conversationBelongsToProjectScope(legacy, 'proj-a'),
  true,
  'unscoped legacy stays visible under a project',
);
assert.equal(
  conversationBelongsToProjectScope(scoped, null),
  false,
  'project-scoped conversation is hidden in workspace chat',
);

// --- switchProjectChatContext A→B changes active conversation to B's scope ---
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

resetStore();
const store = useAppStore.getState();
const convA = store.newConversation('proj-a');
store.addMessage({
  id: 'a-u1',
  role: 'user',
  content: 'design amp for project A',
  timestamp: 1,
  conversationId: convA,
});
useAppStore.setState({ activeProjectId: 'proj-a' });
assert.equal(useAppStore.getState().conversationId, convA);

const convB = useAppStore.getState().newConversation('proj-b');
useAppStore.getState().addMessage({
  id: 'b-u1',
  role: 'user',
  content: 'design LDO for project B',
  timestamp: 2,
  conversationId: convB,
});
// Simulate being on A with A's conversation active, then switching to B.
useAppStore.setState({
  activeProjectId: 'proj-a',
  conversationId: convA,
  messages: useAppStore.getState().conversationMessages[convA] ?? [],
  activeConversationByProject: {
    'proj-a': convA,
    'proj-b': convB,
  },
});

const switched = useAppStore.getState().switchProjectChatContext('proj-b');
const afterSwitch = useAppStore.getState();
assert.equal(switched, convB, 'A→B must restore B remembered conversation');
assert.equal(afterSwitch.conversationId, convB);
assert.equal(afterSwitch.messages[0]?.content, 'design LDO for project B');
assert.equal(
  afterSwitch.conversations.find((entry) => entry.id === afterSwitch.conversationId)?.projectId,
  'proj-b',
);

const backToA = useAppStore.getState().switchProjectChatContext('proj-a');
assert.equal(backToA, convA, 'B→A must restore A conversation');
assert.equal(useAppStore.getState().messages[0]?.content, 'design amp for project A');

console.log(JSON.stringify({
  ok: true,
  visible: visible.length,
  switchAtoB: switched,
  switchBtoA: backToA,
}));
