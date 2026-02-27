import { useState, useRef, useEffect } from 'react';
import { api } from '../../api/client';
import { Spinner } from '../../shared/Spinner';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface CoachingChatProps {
  draftId: string;
  step: number;
  initialPrompt: string;
  onExtractItem?: (text: string) => void;
}

export function CoachingChat({ draftId, step, initialPrompt, onExtractItem }: CoachingChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [started, setStarted] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function startChat() {
    setStarted(true);
    await sendMessage(initialPrompt);
  }

  async function sendMessage(text: string) {
    const userMsg: Message = { role: 'user', content: text };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setSending(true);

    try {
      const { response } = await api.post<{ response: string }>('/ai/coach', {
        draftId,
        step,
        message: text,
      });
      setMessages(prev => [...prev, { role: 'assistant', content: response }]);

      // Extract items prefixed with "• " from the response
      if (onExtractItem) {
        const lines = response.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('• ') || trimmed.startsWith('- ')) {
            onExtractItem(trimmed.replace(/^[•\-]\s*/, ''));
          }
        }
      }
    } catch (err: any) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${err.message}` }]);
    } finally {
      setSending(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || sending) return;
    sendMessage(input.trim());
  }

  if (!started) {
    return (
      <div className="coaching-chat" style={{ justifyContent: 'center', alignItems: 'center' }}>
        <button className="btn btn-primary" onClick={startChat}>
          Start Coaching Session
        </button>
      </div>
    );
  }

  return (
    <div className="coaching-chat">
      <div className="chat-messages">
        {messages.map((msg, i) => (
          <div key={i} className={`chat-message ${msg.role}`}>
            {msg.content}
          </div>
        ))}
        {sending && (
          <div className="chat-message assistant">
            <Spinner size={16} />
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      <form className="chat-input-row" onSubmit={handleSubmit}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Type your response..."
          disabled={sending}
          autoFocus
        />
        <button className="btn btn-primary" type="submit" disabled={sending || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
