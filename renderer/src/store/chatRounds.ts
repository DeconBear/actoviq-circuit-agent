import type { ChatMessage } from '../types';

/**
 * Per-round assistant messages for desktop ReAct runs.
 *
 * The desktop agent emits one `assistant-round` event per completed ReAct text
 * round (plus a `rounds` array at completion). Each round maps to a stable
 * message id so streamed upserts and the final reconciliation dedupe by id.
 */

export interface ChatRoundStore {
  messages: ChatMessage[];
  conversationMessages: Record<string, ChatMessage[]>;
  addMessage: (msg: ChatMessage) => void;
  patchMessage: (id: string, patch: Partial<ChatMessage>) => void;
}

export function assistantRoundMessageId(runId: string | undefined, iteration: number): string {
  return `asst-${runId ?? 'run'}-r${iteration}`;
}

export function findAssistantRoundMessage(
  store: ChatRoundStore,
  conversationId: string,
  runId: string | undefined,
  iteration: number,
): ChatMessage | undefined {
  const id = assistantRoundMessageId(runId, iteration);
  return (store.conversationMessages[conversationId] ?? store.messages).find((msg) => msg.id === id);
}

export function upsertAssistantRoundMessage(
  store: ChatRoundStore,
  input: {
    conversationId: string;
    runId?: string;
    iteration: number;
    text: string;
    timestamp: number;
    meta?: Partial<ChatMessage>;
  },
): string {
  const id = assistantRoundMessageId(input.runId, input.iteration);
  const existing = findAssistantRoundMessage(store, input.conversationId, input.runId, input.iteration);
  if (existing) {
    const patch: Partial<ChatMessage> = { content: input.text, runId: input.runId, ...input.meta };
    // Streamed tool events may already hang off this message; never clobber them
    // with a run-wide fallback list.
    if (existing.tools && existing.tools.length > 0) delete patch.tools;
    store.patchMessage(id, patch);
    return id;
  }
  store.addMessage({
    id,
    role: 'assistant',
    content: input.text,
    timestamp: input.timestamp,
    conversationId: input.conversationId,
    runId: input.runId,
    ...input.meta,
  });
  return id;
}
