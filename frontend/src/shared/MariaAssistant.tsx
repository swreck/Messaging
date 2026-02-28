import { useState, useRef, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import { useMaria, pageKey } from './MariaContext';
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
  const [reading, setReading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);

  // Per-page message storage
  const pageMessagesRef = useRef<Map<string, Message[]>>(new Map());
  const prevPageKeyRef = useRef<string>(pageKey(pageContext));

  // When page context changes, save current messages and load messages for the new page
  useEffect(() => {
    const newKey = pageKey(pageContext);
    const oldKey = prevPageKeyRef.current;

    if (newKey !== oldKey) {
      // Save current page's messages
      pageMessagesRef.current.set(oldKey, messages);

      // Load new page's messages (empty if first visit)
      const restored = pageMessagesRef.current.get(newKey) || [];
      setMessages(restored);
      setExpanded(restored.length > 0);
      prevPageKeyRef.current = newKey;
    }
  }, [pageContext]);

  // Scroll to bottom when messages change
  useEffect(() => {
    if (expanded) {
      setTimeout(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 50);
    }
  }, [messages, expanded]);

  const send = useCallback(async (overrideText?: string, pageContent?: string) => {
    const text = overrideText || input.trim();
    if (!text || sending) return;

    if (!overrideText) {
      setInput('');
      setMessages(prev => [...prev, { role: 'user', content: text }]);
    }
    setExpanded(true);
    setSending(true);

    try {
      const result = await api.post<{
        response: string;
        action: { type: string; params: Record<string, any> } | null;
        actionResult: string | null;
        refreshNeeded: boolean;
        needsPageContent?: boolean;
      }>('/assistant/message', {
        message: pageContent ? `[PAGE CONTENT]\n${pageContent}\n\n[USER QUESTION]\n${text}` : text,
        context: pageContext,
        history: messages.slice(-8).map(m => ({ role: m.role, content: m.content })),
      });

      // If Maria needs to read the page, fetch content and retry
      if (result.needsPageContent) {
        setReading(true);
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: 'Let me read the page...',
        }]);

        try {
          const { content: pc } = await api.post<{ content: string }>('/assistant/page-content', {
            context: pageContext,
          });
          setReading(false);
          // Remove the "reading" message and retry with page content
          setMessages(prev => prev.slice(0, -1));
          setSending(false);
          send(text, pc);
          return;
        } catch {
          setReading(false);
          setMessages(prev => {
            const updated = [...prev];
            updated[updated.length - 1] = {
              role: 'assistant',
              content: "I wasn't able to read the page content. Could you tell me what you're looking at?",
            };
            return updated;
          });
          setSending(false);
          return;
        }
      }

      setMessages(prev => [...prev, {
        role: 'assistant',
        content: result.response,
        action: result.action?.type,
        actionResult: result.actionResult,
      }]);

      if (result.refreshNeeded) {
        refreshPage();
      }
    } catch (err: any) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `Sorry, something went wrong: ${err.message}`,
      }]);
    } finally {
      setSending(false);
    }
  }, [input, sending, pageContext, messages, refreshPage]);

  return (
    <div className="maria-assistant">
      {/* Conversation area — scrollable, all messages */}
      {expanded && messages.length > 0 && (
        <div
          className="maria-conversation"
          ref={conversationRef}
        >
          <div className="maria-conversation-inner">
            {messages.map((msg, i) => (
              <div key={i} className={`maria-msg maria-msg-${msg.role}`}>
                <span className="maria-msg-text">{msg.content}</span>
                {msg.actionResult && (
                  <span className="maria-action-badge">{msg.actionResult}</span>
                )}
              </div>
            ))}
            {reading && (
              <div className="maria-msg maria-msg-assistant maria-reading">
                <Spinner size={12} />
                <span className="maria-msg-text">Reading the page...</span>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
          <button
            className="maria-dismiss"
            onClick={(e) => { e.stopPropagation(); setExpanded(false); }}
          >
            &times;
          </button>
        </div>
      )}

      {/* Input bar */}
      <div className="maria-input-bar">
        {!expanded && messages.length > 0 && (
          <button
            className="maria-history-hint"
            onClick={() => setExpanded(true)}
          >
            {messages.length} message{messages.length !== 1 ? 's' : ''}
          </button>
        )}
        <input
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
            onClick={() => send()}
            disabled={!input.trim()}
          >
            &rarr;
          </button>
        )}
      </div>
    </div>
  );
}
