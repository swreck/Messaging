import { useState, useRef, useEffect } from 'react';
import { api } from '../api/client';
import { useMaria } from './MariaContext';
import { Spinner } from './Spinner';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  action?: string | null;
  actionResult?: string | null;
}

export function MariaAssistant() {
  const { pageContext, refreshPage } = useMaria();
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [sending, setSending] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-collapse after inactivity
  useEffect(() => {
    if (expanded && messages.length > 0) {
      resetCollapseTimer();
    }
    return () => { if (collapseTimer.current) clearTimeout(collapseTimer.current); };
  }, [expanded, messages]);

  function resetCollapseTimer() {
    if (collapseTimer.current) clearTimeout(collapseTimer.current);
    collapseTimer.current = setTimeout(() => {
      setExpanded(false);
    }, 8000);
  }

  function keepOpen() {
    if (collapseTimer.current) clearTimeout(collapseTimer.current);
  }

  async function send() {
    const text = input.trim();
    if (!text || sending) return;

    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: text }]);
    setExpanded(true);
    setSending(true);

    try {
      const result = await api.post<{
        response: string;
        action: { type: string; params: Record<string, any> } | null;
        actionResult: string | null;
        refreshNeeded: boolean;
      }>('/assistant/message', {
        message: text,
        context: pageContext,
      });

      setMessages(prev => [...prev, {
        role: 'assistant',
        content: result.response,
        action: result.action?.type,
        actionResult: result.actionResult,
      }]);

      if (result.refreshNeeded) {
        refreshPage();
      }

      resetCollapseTimer();
    } catch (err: any) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `Sorry, something went wrong: ${err.message}`,
      }]);
    } finally {
      setSending(false);
    }

    // Scroll to bottom
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 100);
  }

  return (
    <div className="maria-assistant">
      {/* Conversation area — expands above input */}
      {expanded && messages.length > 0 && (
        <div
          className="maria-conversation"
          onClick={keepOpen}
          onMouseEnter={keepOpen}
        >
          <div className="maria-conversation-inner">
            {messages.slice(-6).map((msg, i) => (
              <div key={i} className={`maria-msg maria-msg-${msg.role}`}>
                <span className="maria-msg-text">{msg.content}</span>
                {msg.actionResult && (
                  <span className="maria-action-badge">{msg.actionResult}</span>
                )}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
          <button className="maria-dismiss" onClick={(e) => { e.stopPropagation(); setExpanded(false); }}>&times;</button>
        </div>
      )}

      {/* Input bar */}
      <div className="maria-input-bar">
        <input
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') send(); }}
          onFocus={() => { if (messages.length > 0) setExpanded(true); }}
          placeholder="Ask Maria anything..."
          disabled={sending}
        />
        {sending ? (
          <Spinner size={14} />
        ) : (
          <button
            className="maria-send"
            onClick={send}
            disabled={!input.trim()}
          >
            &rarr;
          </button>
        )}
      </div>
    </div>
  );
}
