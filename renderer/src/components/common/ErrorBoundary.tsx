import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={styles.container}>
          <div style={styles.card}>
            <h2 style={styles.title}>Something went wrong</h2>
            <pre style={styles.message}>{this.state.error?.message ?? 'Unknown error'}</pre>
            <p style={styles.hint}>
              This error occurred in the renderer process. Try reloading the window.
            </p>
            <div style={styles.actions}>
              <button onClick={this.handleReset} style={styles.retryBtn}>
                Try Again
              </button>
              <button onClick={() => location.reload()} style={styles.reloadBtn}>
                Reload Window
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100vh',
    backgroundColor: '#1a1a2e',
  },
  card: {
    backgroundColor: '#16213e',
    border: '1px solid #0f3460',
    borderRadius: 12,
    padding: '32px 40px',
    maxWidth: 500,
    textAlign: 'center',
  },
  title: { color: '#e94560', fontSize: 20, marginBottom: 12 },
  message: {
    backgroundColor: '#4a1a1a',
    color: '#e0e0e0',
    padding: '10px 14px',
    borderRadius: 6,
    fontSize: 13,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    textAlign: 'left',
    marginBottom: 12,
  },
  hint: { color: '#808090', fontSize: 12, marginBottom: 20 },
  actions: { display: 'flex', gap: 12, justifyContent: 'center' },
  retryBtn: {
    padding: '8px 20px',
    backgroundColor: '#e94560',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: 600,
  },
  reloadBtn: {
    padding: '8px 20px',
    backgroundColor: 'transparent',
    color: '#a0a0b0',
    border: '1px solid #0f3460',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 14,
  },
};
