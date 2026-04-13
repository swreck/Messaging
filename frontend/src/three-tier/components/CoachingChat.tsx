import { useState, useRef, useEffect } from 'react';
import { api } from '../../api/client';
import { Spinner } from '../../shared/Spinner';

interface Message {
  role: 'user' | 'assistant' | 'extraction-note';
  content: string;
}

interface CoachingChatProps {
  draftId: string;
  step: number;
  initialPrompt: string;
  onExtractItem?: (text: string, driver?: string) => void;
}

export function CoachingChat({ draftId, step, initialPrompt, onExtractItem }: CoachingChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Load existing conversation on mount
  useEffect(() => {
    async function loadHistory() {
      try {
        const { messages: history } = await api.get<{ messages: Message[] }>(`/ai/conversation/${draftId}/${step}`);
        if (history.length > 0) {
          setMessages(history);
        } else {
          // Auto-start: send the initial prompt immediately
          await sendMessageDirect(initialPrompt);
        }
      } catch {
        // If endpoint fails, auto-start
        await sendMessageDirect(initialPrompt);
      } finally {
        setLoading(false);
      }
    }
    loadHistory();
  }, [draftId, step]);

  async function sendMessageDirect(text: string) {
    const userMsg: Message = { role: 'user', content: text };
    setMessages(prev => [...prev, userMsg]);
    setSending(true);

    try {
      const { response } = await api.post<{ response: string }>('/ai/coach', {
        draftId,
        step,
        message: text,
      });
      setMessages(prev => [...prev, { role: 'assistant', content: response }]);
      extractItems(response);
    } catch (err: any) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Something went wrong: ${err.message}` }]);
    } finally {
      setSending(false);
    }
  }

  function extractItems(response: string) {
    if (!onExtractItem) return;
    let extractedCount = 0;
    const lines = response.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('* ') || trimmed.startsWith('- ')) {
        const text = trimmed.replace(/^[*\-]\s*/, '');
        // Check for driver extraction: "[DRIVER] priority: driver text"
        const driverMatch = text.match(/^\[DRIVER\]\s*(.+?):\s*(.+)$/);
        if (driverMatch) {
          onExtractItem(driverMatch[1].trim(), driverMatch[2].trim());
        } else {
          onExtractItem(text);
        }
        extractedCount++;
      }
    }
    if (extractedCount > 0) {
      window.dispatchEvent(new CustomEvent('maria-extracted'));
      setMessages(prev => [...prev, { role: 'extraction-note' as const, content: '(Added to your list \u2192)' }]);
    }
  }

  function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!input.trim() || sending) return;
    setSending(true);
    const text = input.trim();
    setInput('');
    sendMessageDirect(text);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }

  function autoResize() {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 150) + 'px';
    }
  }

  if (loading) {
    return (
      <div className="coaching-chat" style={{ justifyContent: 'center', alignItems: 'center' }}>
        <Spinner size={24} />
      </div>
    );
  }

  return (
    <div className="coaching-chat">
      <div className="chat-messages">
        {messages.map((msg, i) => (
          msg.role === 'extraction-note' ? (
            <div key={i} className="chat-extraction-note">{msg.content}</div>
          ) : (
            <div key={i} className={`chat-message ${msg.role}`}>
              {msg.content}
            </div>
          )
        ))}
        {sending && (
          <div className="chat-message assistant">
            <Spinner size={16} />
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      <form className="chat-input-row" onSubmit={handleSubmit}>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={e => { setInput(e.target.value); autoResize(); }}
          onKeyDown={handleKeyDown}
          placeholder="Type your response..."
          disabled={sending}
          autoFocus
          rows={1}
          style={{ resize: 'none', minHeight: 38, maxHeight: 150 }}
        />
        <button className="btn btn-primary" type="submit" disabled={sending || !input.trim()} title="Send (Cmd+Enter)">
          Send
        </button>
      </form>
    </div>
  );
}
