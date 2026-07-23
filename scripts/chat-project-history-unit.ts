/**
 * Unit checks for per-project chat history visibility / legacy claim.
 * Run: npx tsx scripts/chat-project-history-unit.ts
 */
import assert from 'node:assert/strict';
import {
  claimLegacyConversationsForProject,
  conversationHasContent,
  conversationsForProject,
} from '../renderer/src/store/chatHistoryPersistence.ts';
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

console.log(JSON.stringify({ ok: true, visible: visible.length }));
