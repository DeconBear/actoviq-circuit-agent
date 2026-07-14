import type { ModelApi, ModelRequest } from 'actoviq-agent-sdk';

type ModelMessage = ModelRequest['messages'][number];
type MessageBlock = Exclude<ModelMessage['content'], string>[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isImageBlock(value: unknown): value is MessageBlock {
  return isRecord(value) && value.type === 'image' && isRecord(value.source);
}

/**
 * OpenAI chat-compatible APIs cannot carry image blocks inside a tool-result
 * message. Promote those images to the immediately following user message;
 * the original tool result retains its text metadata and call ID.
 */
export function promoteToolResultImages(messages: ModelRequest['messages']): ModelRequest['messages'] {
  return messages.flatMap((message) => {
    if (typeof message.content === 'string') return [message];

    const promotedImages: MessageBlock[] = [];
    const content = message.content.map((block) => {
      if (!isRecord(block) || block.type !== 'tool_result' || !Array.isArray(block.content)) {
        return block;
      }
      const images = block.content.filter(isImageBlock);
      if (images.length === 0) return block;

      promotedImages.push(...images);
      const retained = block.content.filter((entry) => !isImageBlock(entry));
      return {
        ...block,
        content: retained.length > 0 ? retained : '',
      } as MessageBlock;
    });

    if (promotedImages.length === 0) return [message];
    return [
      { ...message, content },
      { role: 'user' as const, content: promotedImages },
    ];
  });
}

function withPromotedImages(request: ModelRequest): ModelRequest {
  const messages = promoteToolResultImages(request.messages);
  return messages === request.messages ? request : { ...request, messages };
}

export function createOpenAiVisionModelApi(baseModelApi: ModelApi): ModelApi {
  return {
    createMessage: (request) => baseModelApi.createMessage(withPromotedImages(request)),
    streamMessage: (request) => baseModelApi.streamMessage(withPromotedImages(request)),
  };
}
