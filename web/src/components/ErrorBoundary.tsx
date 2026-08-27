import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[ErrorBoundary caught error]:', error, errorInfo);
  }

  private handleReload = () => {
    window.location.reload();
  };

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: '100vh',
          backgroundColor: '#121212',
          color: '#e0e0e0',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
        }}>
          <div style={{
            maxWidth: 540,
            width: '100%',
            backgroundColor: '#1e1e1e',
            border: '1px solid #333',
            borderRadius: 8,
            padding: 24,
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)'
          }}>
            <h2 style={{ margin: '0 0 12px 0', color: '#ef4444', fontSize: 18 }}>
              UI Error Encountered
            </h2>
            <p style={{ margin: '0 0 16px 0', color: '#aaa', fontSize: 14, lineHeight: 1.5 }}>
              The application encountered an unexpected runtime error. You can try refreshing or continuing.
            </p>
            {this.state.error && (
              <pre style={{
                backgroundColor: '#141414',
                border: '1px solid #2a2a2a',
                borderRadius: 4,
                padding: 12,
                color: '#f87171',
                fontSize: 12,
                overflowX: 'auto',
                marginBottom: 20
              }}>
                {this.state.error.message || String(this.state.error)}
              </pre>
            )}
            <div style={{ display: 'flex', gap: 12 }}>
              <button
                onClick={this.handleReset}
                style={{
                  padding: '8px 16px',
                  backgroundColor: '#2563eb',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 500
                }}
              >
                Try Again
              </button>
              <button
                onClick={this.handleReload}
                style={{
                  padding: '8px 16px',
                  backgroundColor: '#374151',
                  color: '#e5e7eb',
                  border: 'none',
                  borderRadius: 6,
                  cursor: 'pointer',
                  fontSize: 13
                }}
              >
                Reload Page
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
