import React, { useState, useRef, useEffect, useCallback } from 'react';

interface Message {
  id: string;
  agentId: string;
  role: string;
  content: string;
  timestamp: number;
}

interface ChatMsg {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: number;
  agentName?: string;
  agentRole?: string;
  msgType?: string;
}

interface Props {
  messages: Message[];
  onSend: (text: string) => void;
  onStop?: () => void;
  onClear?: () => void;
  loading?: boolean;
  title?: string;
  formatMessage?: (msg: ChatMsg) => { sender: string; content: string; isUser: boolean };
  allMessages?: ChatMsg[];
}

export function ChatPanel({ messages, onSend, onStop, onClear, loading, title, formatMessage, allMessages }: Props) {
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true); // Track if user is near bottom
  const initialLoadRef = useRef(true); // Track initial load
  const AUTO_SCROLL_THRESHOLD = 120; // px from bottom to trigger auto-scroll

  // Handle scroll to track user position
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    isNearBottomRef.current = distanceFromBottom <= AUTO_SCROLL_THRESHOLD;
  }, []);

  // Prefer allMessages (already filtered by App) if available
  const rawDisplay: any[] = allMessages && allMessages.length >= 0 ? allMessages as any[] : messages as any[];
  const displayMessages = rawDisplay;

  // Reset initialLoadRef when title changes or messages are cleared
  useEffect(() => {
    initialLoadRef.current = true;
  }, [title]);

  useEffect(() => {
    if (displayMessages.length === 0) {
      initialLoadRef.current = true;
    }
  }, [displayMessages.length]);

  // Auto-scroll logic: scroll to bottom on initial load or when near bottom and new messages arrive
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    if (initialLoadRef.current) {
      // Initial load: always scroll to bottom immediately
      el.scrollTop = el.scrollHeight;
      initialLoadRef.current = false;
      isNearBottomRef.current = true;
    } else if (isNearBottomRef.current) {
      // User is near bottom: auto-scroll to new content smoothly
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
    // If user scrolled up (isNearBottomRef.current === false), don't auto-scroll
  }, [messages, allMessages]);

  const handleSend = () => {
    if (!input.trim()) return;
    onSend(input.trim());
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    } else if (e.key === 'Escape') {
      if (e.repeat) {
        e.preventDefault();
        return;
      }
      // Only trigger stop if agent is actively working/loading
      if (loading && onStop) {
        onStop();
      }
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid #333',
        background: '#1a1a1a',
        fontSize: 14,
        fontWeight: 600,
        color: '#e0e0e0',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center'
      }}>
        <span>{title || 'Orchestrator'}</span>
        {onClear && (
          <button
            onClick={onClear}
            style={{
              background: '#333',
              color: '#ef4444',
              border: '1px solid #444',
              borderRadius: 4,
              padding: '4px 8px',
              fontSize: 12,
              cursor: 'pointer',
              fontWeight: 600
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.background = '#444';
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.background = '#333';
            }}
          >
            Clear Chat
          </button>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollRef} onScroll={handleScroll} style={{ flex: 1, overflow: 'auto', padding: 20 }}>
        {displayMessages.length === 0 ? (
          <div style={{
            textAlign: 'center',
            color: '#555',
            marginTop: 100,
            fontSize: 14
          }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🤖</div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>AgentForge</div>
            <div style={{ marginTop: 8 }}>Spawn agents and start chatting</div>
          </div>
        ) : (
          displayMessages.map((msg: any) => {
            const isUser = msg.from === 'user';
            let sender = msg.from;
            let senderColor = '#888';

            // Resolve sender name with ID
            if (msg.from === 'orchestrator') { sender = 'Orchestrator (orchestrator)'; senderColor = '#f59e0b'; }
            else if (msg.from === 'user') { sender = 'You'; senderColor = '#3b82f6'; }
            else if (msg.from === 'system') { sender = 'System'; senderColor = '#ef4444'; }
            else if (msg.agentName) { sender = `${msg.agentName} (${msg.agentRole}) [${msg.from}]`; senderColor = '#4ade80'; }
            else { sender = `${msg.from} [${msg.from}]`; senderColor = '#4ade80'; }

            // Parse [TO: xxx] prefix — tách lời thoại xuống 1 hàng riêng
            const rawContent: string = msg.content || '';
            const toMatch = rawContent.match(/^\s*\[TO:\s*([^\]]+)\]\s*/i);
            const toTag = toMatch ? toMatch[1].trim() : null;
            const body = toMatch ? rawContent.slice(toMatch[0].length) : rawContent;
            // Nếu msg.to đã có thì ưu tiên msg.to, ngược lại dùng toTag
            const effectiveTo = msg.to && msg.to !== 'user' ? msg.to : toTag;

            return (
              <div
                key={msg.id}
                style={{
                  marginBottom: 14,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: isUser ? 'flex-end' : 'flex-start'
                }}
              >
                {/* Sender label — hàng 1 */}
                <div style={{
                  fontSize: 11,
                  color: senderColor,
                  marginBottom: 4,
                  fontWeight: 600,
                  paddingLeft: isUser ? 0 : 4,
                  paddingRight: isUser ? 4 : 0
                }}>
                  {sender}
                  {effectiveTo && (
                    <span style={{ color: '#666', fontWeight: 400 }}> → {effectiveTo}</span>
                  )}
                </div>
                {/* Nếu có [TO:] thì hiện tag nhỏ riêng 1 hàng */}
                {toTag && (
                  <div style={{
                    fontSize: 10,
                    color: '#888',
                    background: '#1f1f1f',
                    border: '1px solid #2a2a2a',
                    borderRadius: 4,
                    padding: '2px 6px',
                    marginBottom: 6,
                    marginLeft: isUser ? 0 : 4,
                    fontFamily: 'monospace'
                  }}>
                    [TO: {toTag}]
                  </div>
                )}
                {/* Message content — hàng tiếp theo, nguyên văn */}
                <div style={{
                  background: isUser ? '#3b82f6' : '#252525',
                  color: isUser ? 'white' : '#e0e0e0',
                  padding: '10px 14px',
                  borderRadius: 12,
                  maxWidth: '85%',
                  fontSize: 13,
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                  fontFamily: 'monospace',
                  border: isUser ? 'none' : '1px solid #333',
                  wordBreak: 'break-word'
                }}>
                  {body}
                </div>
              </div>
            );
          })
        )}
        {loading && (
          <div style={{ color: '#888', fontSize: 12, marginTop: 8 }}>
            🤔 Thinking...
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{
        padding: 16,
        borderTop: '1px solid #333',
        background: '#1a1a1a'
      }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={loading ? "Type to queue next message... (Enter to send)" : "Type a message... (Enter to send)"}
            style={{
              flex: 1,
              background: '#252525',
              color: '#e0e0e0',
              border: '1px solid #333',
              borderRadius: 8,
              padding: '10px 12px',
              fontSize: 13,
              resize: 'none',
              minHeight: 40,
              maxHeight: 120,
              fontFamily: 'inherit'
            }}
            rows={1}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim()}
            style={{
              background: input.trim() ? '#3b82f6' : '#333',
              color: 'white',
              border: 'none',
              borderRadius: 8,
              padding: '10px 16px',
              fontSize: 13,
              cursor: input.trim() ? 'pointer' : 'not-allowed',
              fontWeight: 600
            }}
          >
            {loading ? 'Queue' : 'Send'}
          </button>
          {loading && (
            <button
              onClick={onStop}
              title="Stop agent (Esc)"
              style={{
                background: '#dc2626',
                color: 'white',
                border: 'none',
                borderRadius: 8,
                padding: '10px 14px',
                fontSize: 13,
                cursor: 'pointer',
                fontWeight: 600
              }}
            >
              ⏹ Stop
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
