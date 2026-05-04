import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/appStore';

interface Props {
  onSend: (text: string) => void;
}

export function ChatView({ onSend }: Props) {
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
    <div style={styles.container}>
      <div style={styles.convHeader}>
        <div style={styles.convInfo}>
          <span style={styles.convTitle}>
            {currentConv ? currentConv.title : (messages.length > 0 ? messages[0].content.slice(0, 40) : 'New Conversation')}
          </span>
          {currentConv && (
            <span style={styles.convMeta}>
              {currentConv.messageCount} messages · {new Date(currentConv.updatedAt).toLocaleTimeString()}
            </span>
          )}
        </div>
        <button onClick={handleNewConversation} style={styles.newConvBtn} title="New conversation">
          + New
        </button>
      </div>
      <div style={styles.messages}>
        {messages.map((msg) => (
          <div
            key={msg.id}
            style={{
              ...styles.bubble,
              ...(msg.role === 'user' ? styles.userBubble : styles.systemBubble),
              ...(msg.isError ? styles.errorBubble : {}),
            }}
          >
            <div style={styles.bubbleHeader}>
              {msg.role === 'user' ? 'You' : 'Agent'}
            </div>
            <div style={styles.bubbleContent}>{msg.content}</div>
          </div>
        ))}
        {outputText && (
          <div style={{ ...styles.bubble, ...styles.outputBubble }}>
            <pre style={styles.outputPre}>{outputText}</pre>
          </div>
        )}
        {messages.length === 0 && !outputText && (
          <div style={styles.emptyState}>
            <p>Type a circuit requirement below to start designing.</p>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div style={styles.inputBar}>
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
            isRunning
              ? 'Workflow running — type to continue the conversation...'
              : 'Describe your circuit (e.g. Design a 1 kHz RC low-pass filter)'
          }
          style={styles.input}
        />
        <button
          onClick={handleSend}
          style={styles.sendBtn}
          disabled={!input.trim()}
        >
          Send
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', height: '100%' },
  convHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 16px',
    backgroundColor: '#0f3460',
    borderBottom: '1px solid #16213e',
    minHeight: 40,
  },
  convInfo: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  convTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: '#e0e0e0',
  },
  convMeta: {
    fontSize: 10,
    color: '#808090',
  },
  newConvBtn: {
    padding: '4px 14px',
    backgroundColor: '#1a1a2e',
    color: '#e0e0e0',
    border: '1px solid #e94560',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
  },
  messages: {
    flex: 1,
    overflowY: 'auto',
    padding: '16px 24px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  bubble: {
    padding: '8px 14px',
    borderRadius: 8,
    maxWidth: '80%',
    fontSize: 13,
    lineHeight: 1.5,
  },
  userBubble: {
    alignSelf: 'flex-end',
    backgroundColor: '#0f3460',
    color: '#e0e0e0',
  },
  systemBubble: {
    alignSelf: 'flex-start',
    backgroundColor: '#16213e',
    color: '#c0c0d0',
  },
  errorBubble: {
    backgroundColor: '#4a1a1a',
    borderLeft: '3px solid #e94560',
  },
  outputBubble: {
    alignSelf: 'stretch',
    maxWidth: '100%',
    backgroundColor: '#0d1117',
    border: '1px solid #16213e',
  },
  bubbleHeader: { fontSize: 11, color: '#e94560', marginBottom: 4, fontWeight: 600 },
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
    alignItems: 'center',
    justifyContent: 'center',
    color: '#606070',
  },
  inputBar: {
    display: 'flex',
    padding: '10px 20px',
    borderTop: '1px solid #0f3460',
    backgroundColor: '#16213e',
    gap: 8,
  },
  input: {
    flex: 1,
    padding: '8px 14px',
    borderRadius: 6,
    border: '1px solid #0f3460',
    backgroundColor: '#1a1a2e',
    color: '#e0e0e0',
    fontSize: 14,
    outline: 'none',
  },
  sendBtn: {
    padding: '8px 20px',
    backgroundColor: '#e94560',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: 600,
  },
};
