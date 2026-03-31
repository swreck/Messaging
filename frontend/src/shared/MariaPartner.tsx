import { useState, useRef, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useMaria } from './MariaContext';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  actionResult?: string | null;
}

type IntroPhase = 'name' | 'capabilities' | 'done';

export function MariaPartner() {
  const { user } = useAuth();
  const { pageContext, refreshPage } = useMaria();

  // Panel state
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Intro state
  const [introduced, setIntroduced] = useState<boolean | null>(null);
  const [introPhase, setIntroPhase] = useState<IntroPhase>('name');
  const [displayName, setDisplayName] = useState('');
  const [customName, setCustomName] = useState('');
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [suggestedName, setSuggestedName] = useState('');

  // Notification dot — show once until first open
  const [showDot, setShowDot] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Don't render if not logged in
  if (!user) return null;

  // Load status on mount
  useEffect(() => {
    api.get<{ username: string; displayName?: string; introduced: boolean }>('/partner/status')
      .then(status => {
        setIntroduced(status.introduced);
        setDisplayName(status.displayName || '');
        setSuggestedName(
          status.username.charAt(0).toUpperCase() + status.username.slice(1)
        );
        // Show dot if not yet introduced
        if (!status.introduced) {
          setShowDot(true);
        }
      })
      .catch(() => {
        // Silently fail — partner feature is additive
        setIntroduced(false);
      });
  }, []);

  // Load conversation history when panel first opens
  useEffect(() => {
    if (open && !loaded && introduced) {
      api.get<{ messages: Message[] }>('/partner/history')
        .then(({ messages: history }) => {
          setMessages(history);
          setLoaded(true);
        })
        .catch(() => setLoaded(true));
    }
  }, [open, loaded, introduced]);

  // Scroll to bottom when messages change
  useEffect(() => {
    if (open) {
      setTimeout(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 50);
    }
  }, [messages, open]);

  // Focus textarea when panel opens
  useEffect(() => {
    if (open && introduced && introPhase === 'done') {
      setTimeout(() => textareaRef.current?.focus(), 100);
    }
  }, [open, introduced, introPhase]);

  const handleOpen = useCallback(() => {
    setOpen(true);
    setShowDot(false);
  }, []);

  const handleClose = useCallback(() => {
    setOpen(false);
  }, []);

  // Send a message (with optional page content for retry)
  const send = useCallback(async (overrideText?: string, pageContent?: string) => {
    const text = overrideText || input.trim();
    if (!text || sending) return;

    if (!overrideText) {
      setInput('');
      setMessages(prev => [...prev, { role: 'user', content: text }]);
    }
    setSending(true);

    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    try {
      const result = await api.post<{
        response: string;
        actionResult: string | null;
        refreshNeeded: boolean;
        needsPageContent?: boolean;
      }>('/partner/message', {
        message: pageContent ? `[PAGE CONTENT]\n${pageContent}\n\n[USER QUESTION]\n${text}` : text,
        context: pageContext,
      });

      // If Maria needs to read the page, fetch content and retry
      if (result.needsPageContent) {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: 'Let me take a look...',
        }]);

        try {
          const { content: pc } = await api.post<{ content: string }>('/partner/page-content', {
            context: pageContext,
          });
          // Remove the "reading" message and retry with page content
          setMessages(prev => prev.slice(0, -1));
          setSending(false);
          send(text, pc);
          return;
        } catch {
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
        actionResult: result.actionResult,
      }]);

      if (result.refreshNeeded) {
        refreshPage();
      }
    } catch (err: any) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: 'Sorry, I had trouble with that. Try again?',
      }]);
    } finally {
      setSending(false);
    }
  }, [input, sending, pageContext, refreshPage]);

  // Confirm name
  const confirmName = useCallback(async (name: string) => {
    try {
      await api.put<{ success: boolean }>('/partner/name', { displayName: name });
      setDisplayName(name);
      setIntroduced(true);
      setIntroPhase('capabilities');
    } catch {
      // Silently continue
      setIntroduced(true);
      setIntroPhase('capabilities');
    }
  }, []);

  // Render the intro flow
  function renderIntro() {
    if (introPhase === 'name') {
      return (
        <div className="partner-intro">
          <div className="partner-intro-message">
            <p>Hi — I'm Maria. I've been here before, but I've been working on being more helpful.</p>
            <p>So I'm here whenever you want to think through your messaging together. I can see your work across the app, so you don't need to catch me up.</p>
            <p>Can I call you {suggestedName}?</p>
          </div>
          <div className="partner-intro-actions">
            {!showCustomInput ? (
              <>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => confirmName(suggestedName)}
                >
                  That's me
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => setShowCustomInput(true)}
                >
                  Call me something else
                </button>
              </>
            ) : (
              <div className="partner-name-input">
                <input
                  type="text"
                  value={customName}
                  onChange={e => setCustomName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Escape') setShowCustomInput(false);
                    if (e.key === 'Enter' && customName.trim()) {
                      confirmName(customName.trim());
                    }
                  }}
                  placeholder="What should I call you?"
                  autoFocus
                />
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => customName.trim() && confirmName(customName.trim())}
                  disabled={!customName.trim()}
                >
                  That's it
                </button>
              </div>
            )}
          </div>
        </div>
      );
    }

    if (introPhase === 'capabilities') {
      return (
        <div className="partner-intro">
          <div className="partner-intro-message">
            <p>Great to meet you, {displayName}.</p>
            <p>I can help you think through positioning, voice, audience priorities, competitive examples — anything related to your messaging. And if you ask me to make changes — add a priority, tweak a story, create an audience — I can do that too.</p>
            <p>You'll see my icon on every screen. Come find me whenever.</p>
          </div>
          <div className="partner-intro-actions">
            <button
              className="btn btn-primary btn-sm"
              onClick={() => {
                setIntroPhase('done');
                setLoaded(false); // trigger history load
              }}
            >
              Sounds good
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setIntroPhase('done');
                setOpen(false);
                setLoaded(false);
              }}
            >
              Dismiss for now
            </button>
          </div>
        </div>
      );
    }

    return null;
  }

  // Format message text with paragraph and line breaks
  function formatContent(text: string) {
    const paragraphs = text.split(/\n\n+/);
    return paragraphs.map((p, i) => {
      const lines = p.split(/\n/);
      return (
        <span key={i}>
          {i > 0 && <><br /><br /></>}
          {lines.map((line, j) => (
            <span key={j}>
              {j > 0 && <br />}
              {line}
            </span>
          ))}
        </span>
      );
    });
  }

  return (
    <>
      {/* Floating bubble */}
      {!open && (
        <button
          className="partner-bubble"
          onClick={handleOpen}
          aria-label="Talk to Maria"
          title="Talk to Maria"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
          </svg>
          {showDot && <span className="partner-dot" />}
        </button>
      )}

      {/* Chat panel */}
      {open && (
        <div className="partner-panel" ref={panelRef}>
          {/* Header */}
          <div className="partner-header">
            <span className="partner-header-name">Maria</span>
            <button
              className="partner-close"
              onClick={handleClose}
              aria-label="Close"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Body */}
          <div className="partner-body">
            {introduced === false && renderIntro()}

            {introduced && (
              <>
                {/* Messages */}
                <div className="partner-messages">
                  {messages.length === 0 && loaded && (
                    <div className="partner-empty">
                      What's on your mind?
                    </div>
                  )}
                  {messages.map((msg, i) => (
                    <div key={i} className={`partner-msg partner-msg-${msg.role}`}>
                      {formatContent(msg.content)}
                      {msg.actionResult && (
                        <span className="partner-action-badge">{msg.actionResult}</span>
                      )}
                    </div>
                  ))}
                  {sending && (
                    <div className="partner-msg partner-msg-assistant partner-typing">
                      <span /><span /><span />
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>

                {/* Input */}
                <div className="partner-input-area">
                  <textarea
                    ref={textareaRef}
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        send();
                      }
                    }}
                    onInput={e => {
                      const el = e.currentTarget;
                      el.style.height = 'auto';
                      el.style.height = Math.min(el.scrollHeight, 100) + 'px';
                    }}
                    placeholder="Talk to Maria..."
                    disabled={sending}
                    rows={1}
                  />
                  <button
                    className="partner-send"
                    onClick={() => send()}
                    disabled={!input.trim() || sending}
                    aria-label="Send"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                    </svg>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
