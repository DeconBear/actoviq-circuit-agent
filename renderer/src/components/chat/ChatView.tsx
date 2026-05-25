import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../store/appStore';
import { createSafeMarkdownParser, escapeHtml } from '../../utils/markdown';

interface Props {
  onSend: (text: string) => void;
  isPending?: boolean;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const chatMarkdown = createSafeMarkdownParser({
  codeBlockClassName: 'code-block',
  showLanguageLabel: true,
});

function renderMarkdown(content: string): string {
  try {
    return chatMarkdown.parse(content) as string;
  } catch {
    return escapeHtml(content);
  }
}

function BubbleContent({ msg }: { msg: { role: string; content: string; isError?: boolean } }) {
  const html = useMemo(() => {
    if (msg.role === 'user') {
      return escapeHtml(msg.content).replace(/\n/g, '<br/>');
    }
    return renderMarkdown(msg.content);
  }, [msg.content, msg.role]);

  if (msg.role === 'user') {
    return <div style={s.bubbleContent} dangerouslySetInnerHTML={{ __html: html }} />;
  }

  return (
    <div
      className="markdown-content chat-markdown"
      style={s.bubbleContent}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function ChatView({ onSend, isPending = false }: Props) {
  const [input, setInput] = useState('');
  const messages = useAppStore((s) => s.messages);
  const outputText = useAppStore((s) => s.outputText);
  const isRunning = useAppStore((s) => s.isRunning);
  const conversationId = useAppStore((s) => s.conversationId);
  const conversations = useAppStore((s) => s.conversations);
  const currentConv = conversations.find((c) => c.id === conversationId);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, outputText]);

  const handleSend = () => {
    const trimmed = input.trim();
    if (trimmed) {
      onSend(trimmed);
      setInput('');
    }
  };

  const handleNewConversation = () => {
    useAppStore.getState().newConversation();
  };

  return (
    <div style={s.container}>
      <div style={s.convHeader}>
        <div style={s.convInfo}>
          <span style={s.convTitle}>
            {currentConv ? currentConv.title : (messages[0]?.content.slice(0, 40) ?? 'New Conversation')}
          </span>
          {currentConv && (
            <span style={s.convMeta}>
              {currentConv.messageCount} messages · {new Date(currentConv.updatedAt).toLocaleTimeString()}
            </span>
          )}
        </div>
        <button onClick={handleNewConversation} style={s.newConvBtn} title="New conversation">
          + New
        </button>
      </div>

      <div style={s.messages}>
        {messages.length === 0 && !outputText && (
          <div style={s.emptyState}>
            <div style={s.emptyIcon}>⚡</div>
            <div style={s.emptyTitle}>Actoviq Circuit Agent</div>
            <div style={s.emptyDesc}>
              Describe your circuit design requirement below.<br />
              The agent will analyze your request and start a design workflow.
            </div>
          </div>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            style={{
              ...s.bubble,
              ...(msg.role === 'user' ? s.userBubble : s.systemBubble),
              ...(msg.isError ? s.errorBubble : {}),
            }}
          >
            <div style={s.bubbleHeader}>
              <span style={s.bubbleRole}>{msg.role === 'user' ? 'You' : 'Agent'}</span>
              <span style={s.bubbleTime}>{formatTime(msg.timestamp)}</span>
            </div>
            <BubbleContent msg={msg} />
          </div>
        ))}
        {outputText && (
          <div style={{ ...s.bubble, ...s.outputBubble }}>
            <div style={s.bubbleHeader}>
              <span style={s.bubbleRole}>Output</span>
            </div>
            <pre style={s.outputPre}>{outputText}</pre>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div style={s.inputBar}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder={
            isPending
              ? 'Waiting for assistant response...'
              : isRunning
              ? 'Workflow running — type to continue the conversation...'
              : 'Describe your circuit (e.g. Design a 1 kHz RC low-pass filter)'
          }
          style={s.input}
          disabled={isPending}
        />
        <button
          onClick={handleSend}
          style={{
            ...s.sendBtn,
            ...(!input.trim() || isPending ? s.sendBtnDisabled : {}),
          }}
          disabled={!input.trim() || isPending}
        >
          {isPending ? 'Sending...' : 'Send'}
        </button>
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', height: '100%' },
  convHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '10px 18px',
    backgroundColor: '#0d1b36',
    borderBottom: '1px solid #0f3460',
    minHeight: 42,
  },
  convInfo: { display: 'flex', flexDirection: 'column', gap: 1 },
  convTitle: { fontSize: 13, fontWeight: 600, color: '#e0e0e0' },
  convMeta: { fontSize: 10, color: '#606080' },
  newConvBtn: {
    padding: '4px 14px',
    backgroundColor: '#1a1a2e',
    color: '#a0a0b0',
    border: '1px solid #0f3460',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
  },
  messages: {
    flex: 1,
    overflowY: 'auto',
    padding: '20px 24px',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  bubble: {
    padding: '10px 16px',
    borderRadius: 10,
    maxWidth: '82%',
    fontSize: 13,
    lineHeight: 1.6,
    boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
  },
  userBubble: {
    alignSelf: 'flex-end',
    backgroundColor: '#0f3460',
    color: '#e0e0e0',
    borderBottomRightRadius: 4,
  },
  systemBubble: {
    alignSelf: 'flex-start',
    backgroundColor: '#1a1d2e',
    color: '#c9d1d9',
    borderBottomLeftRadius: 4,
    border: '1px solid #1f2235',
  },
  errorBubble: {
    backgroundColor: '#3d1a1a',
    borderLeft: '3px solid #e94560',
    borderBottomLeftRadius: 3,
  },
  outputBubble: {
    alignSelf: 'stretch',
    maxWidth: '100%',
    backgroundColor: '#0d1117',
    border: '1px solid #1a1d2e',
    borderRadius: 8,
  },
  bubbleHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  bubbleRole: { fontSize: 11, fontWeight: 700, color: '#e94560' },
  bubbleTime: { fontSize: 10, color: '#606080' },
  bubbleContent: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  outputPre: {
    fontSize: 12,
    fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
    whiteSpace: 'pre-wrap',
    color: '#8b949e',
    margin: 0,
  },
  emptyState: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#606070',
    gap: 8,
  },
  emptyIcon: { fontSize: 40, opacity: 0.5 },
  emptyTitle: { fontSize: 16, fontWeight: 600, color: '#808090' },
  emptyDesc: { fontSize: 13, color: '#505060', textAlign: 'center', lineHeight: 1.6 },
  inputBar: {
    display: 'flex',
    padding: '10px 20px',
    borderTop: '1px solid #0f3460',
    backgroundColor: '#16213e',
    gap: 8,
  },
  input: {
    flex: 1,
    padding: '10px 16px',
    borderRadius: 8,
    border: '1px solid #0f3460',
    backgroundColor: '#1a1a2e',
    color: '#e0e0e0',
    fontSize: 14,
    outline: 'none',
    transition: 'border-color 0.2s',
  },
  sendBtn: {
    padding: '10px 22px',
    backgroundColor: '#e94560',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: 600,
    transition: 'opacity 0.15s',
    opacity: 1,
  },
  sendBtnDisabled: {
    cursor: 'not-allowed',
    opacity: 0.55,
  },
};
