import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useMaria } from './MariaContext';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  actionResult?: string | null;
}

interface ReturnContext {
  draftId: string;
  offeringName: string;
  audienceName: string;
  currentStep: number;
  hasStories: boolean;
  unblendedMedium?: string;
}

type IntroPhase = 'intro' | 'capabilities' | 'context' | 'done';

export function MariaPartner() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { pageContext, refreshPage } = useMaria();

  // Panel state
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Intro state
  const [introduced, setIntroduced] = useState<boolean | null>(null);
  const [introPhase, setIntroPhase] = useState<IntroPhase>('intro');
  const [introReminder, setIntroReminder] = useState(false);
  // displayName stored for backend partner prompt — not rendered in UI
  const displayNameRef = useRef('');
  const setDisplayName = (name: string) => { displayNameRef.current = name; };
  const [customName, setCustomName] = useState('');
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [suggestedName, setSuggestedName] = useState('');

  // Return context — for Phase 3 (intro) and glow (returning users)
  const [returnContext, setReturnContext] = useState<ReturnContext | null>(null);
  const [showReturnCard, setShowReturnCard] = useState(false);

  // Bubble indicators
  const [showDot, setShowDot] = useState(false);
  const [showGlow, setShowGlow] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Load status on mount
  useEffect(() => {
    api.get<{ username: string; displayName?: string; introduced: boolean; returnContext?: ReturnContext | null }>('/partner/status')
      .then(status => {
        setIntroduced(status.introduced);
        setDisplayName(status.displayName || '');
        setSuggestedName(
          status.username.charAt(0).toUpperCase() + status.username.slice(1)
        );

        if (status.returnContext) {
          setReturnContext(status.returnContext);
        }

        if (!status.introduced) {
          // First time — show dot to draw attention to intro
          setShowDot(true);
        } else if (status.returnContext) {
          // Returning user with context — subtle glow, not a dot
          setShowGlow(true);
        }
      })
      .catch(() => {
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
          // If returning user has context, show the return card
          if (returnContext) {
            setShowReturnCard(true);
            setShowGlow(false);
          }
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

  // Listen for keyboard shortcut events
  useEffect(() => {
    function onToggle(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (detail?.open) {
        setOpen(true);
        setShowDot(false);
        setShowGlow(false);
      } else {
        setOpen(false);
      }
    }
    document.addEventListener('maria-toggle', onToggle);
    return () => document.removeEventListener('maria-toggle', onToggle);
  }, []);

  // Global keyboard shortcuts: Cmd+Shift+M to toggle, Escape to close
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        setOpen(prev => {
          if (!prev) { setShowDot(false); setShowGlow(false); }
          return !prev;
        });
      }
      if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const handleOpen = useCallback(() => {
    setOpen(true);
    setShowDot(false);
    setShowGlow(false);
  }, []);

  const handleClose = useCallback(() => {
    setOpen(false);
  }, []);

  // Send a message (with optional page content for retry)
  const send = useCallback(async (overrideText?: string, pageContent?: string) => {
    const text = overrideText || input.trim();
    if (!text || sending) return;

    // Dismiss return card once user starts talking
    setShowReturnCard(false);

    if (!overrideText) {
      setInput('');
      setMessages(prev => [...prev, { role: 'user', content: text }]);
    }
    setSending(true);

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

      if (result.needsPageContent) {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: 'Let me take a look...',
        }]);

        try {
          const { content: pc } = await api.post<{ content: string }>('/partner/page-content', {
            context: pageContext,
          });
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

      // Check for navigation directive in action result
      if (result.actionResult) {
        const navMatch = result.actionResult.match(/\[NAVIGATE:([^\]]+)\]/);
        if (navMatch) {
          setTimeout(() => navigate(navMatch[1]), 1200);
        }
      }

      if (result.refreshNeeded) {
        refreshPage();
      }
    } catch {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: 'Sorry, I had trouble with that. Try again?',
      }]);
    } finally {
      setSending(false);
    }
  }, [input, sending, pageContext, refreshPage]);

  // Confirm name — marks intro as done on backend, advances to Phase 2
  const confirmName = useCallback(async (name: string) => {
    try {
      await api.put<{ success: boolean }>('/partner/name', { displayName: name });
      setDisplayName(name);
      setIntroduced(true);
      setIntroPhase('capabilities');
      setIntroReminder(false);
    } catch {
      setIntroduced(true);
      setIntroPhase('capabilities');
    }
  }, []);

  // Build Phase 3 message from return context or new-user prompt
  function getContextMessage(): string {
    if (returnContext) {
      const { offeringName, audienceName, currentStep } = returnContext;
      if (currentStep < 5) {
        return `You were last building a message for ${offeringName} for ${audienceName}. Want to go there or start something else?`;
      }
      if (returnContext.unblendedMedium) {
        return `You were working on a ${returnContext.unblendedMedium} for ${offeringName} → ${audienceName}. The chapters are written but not blended yet. Want to finish that or start something else?`;
      }
      if (!returnContext.hasStories) {
        return `Your Three Tier for ${offeringName} → ${audienceName} is done. Want to turn it into something — an email, a pitch, a blog post? Or start something new?`;
      }
      return `Your ${offeringName} work is in good shape. Want to revisit it or start something new?`;
    }
    // New user — no work yet
    return `What are you working on? Tell me about the product or service you want to build messaging for, and who needs to hear about it.`;
  }

  // Render the three-phase intro flow
  function renderIntro() {
    // ─── Phase 1: Introduction ─────────────────────────
    if (introPhase === 'intro') {
      if (introReminder) {
        return (
          <div className="partner-intro">
            <div className="partner-intro-message">
              <p>I'm your messaging partner. I know the Three Tier and Five Chapter methodologies, and I can help you build messaging for any product and audience. I work alongside the app — anything you can do in the UI, you can ask me to do instead.</p>
            </div>
            <div className="partner-intro-actions">
              <button className="btn btn-primary" onClick={() => { setIntroReminder(false); setIntroPhase('intro'); }}>
                Got it — interested
              </button>
              <button className="btn btn-ghost" onClick={() => { setIntroPhase('done'); setOpen(false); setLoaded(false); }}>
                Dismiss
              </button>
            </div>
          </div>
        );
      }

      return (
        <div className="partner-intro">
          <div className="partner-intro-message">
            <p>Hi — I'm Maria. I've been here before, but I've gotten better.</p>
            <p>Interested in what I can do?</p>
          </div>
          <div className="partner-intro-actions">
            {!showCustomInput ? (
              <>
                <button className="btn btn-primary" onClick={() => setIntroPhase('capabilities')}>
                  Yes
                </button>
                <button className="btn btn-secondary" onClick={() => setIntroReminder(true)}>
                  Remind me
                </button>
                <button className="btn btn-ghost" onClick={() => { setIntroPhase('done'); setOpen(false); setLoaded(false); }}>
                  Dismiss
                </button>
              </>
            ) : null}
          </div>
          {/* Name capture — fold it in naturally */}
          <div style={{ marginTop: 16, borderTop: '1px solid var(--border-light, #e5e5ea)', paddingTop: 12 }}>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 8px' }}>
              Can I call you {suggestedName}?
            </p>
            {!showCustomInput ? (
              <div className="partner-intro-actions">
                <button className="btn btn-primary btn-sm" onClick={() => confirmName(suggestedName)}>
                  That's me
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => setShowCustomInput(true)}>
                  Call me something else
                </button>
              </div>
            ) : (
              <div className="partner-name-input">
                <input
                  type="text"
                  value={customName}
                  onChange={e => setCustomName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Escape') setShowCustomInput(false);
                    if (e.key === 'Enter' && customName.trim()) confirmName(customName.trim());
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

    // ─── Phase 2: Capabilities ─────────────────────────
    if (introPhase === 'capabilities') {
      if (introReminder) {
        return (
          <div className="partner-intro">
            <div className="partner-intro-message">
              <p>For example: "Create an audience called Hospital CFOs," or "Add a priority about cost reduction," or "Review my Three Tier and suggest improvements." I can create, edit, and generate — just tell me what you need.</p>
            </div>
            <div className="partner-intro-actions">
              <button className="btn btn-primary" onClick={() => { setIntroReminder(false); setIntroPhase('context'); }}>
                Got it
              </button>
              <button className="btn btn-ghost" onClick={() => { setIntroPhase('done'); setOpen(false); setLoaded(false); }}>
                Dismiss
              </button>
            </div>
          </div>
        );
      }

      return (
        <div className="partner-intro">
          <div className="partner-intro-message">
            <p>I can do most anything the UI can do, so you can tell me and I'll try.</p>
          </div>
          <div className="partner-intro-actions">
            <button className="btn btn-primary" onClick={() => setIntroPhase('context')}>
              Continue
            </button>
            <button className="btn btn-secondary" onClick={() => setIntroReminder(true)}>
              Remind me
            </button>
            <button className="btn btn-ghost" onClick={() => { setIntroPhase('done'); setOpen(false); setLoaded(false); }}>
              Dismiss
            </button>
          </div>
        </div>
      );
    }

    // ─── Phase 3: Context ──────────────────────────────
    if (introPhase === 'context') {
      const contextMsg = getContextMessage();
      const hasDraft = returnContext?.draftId;

      return (
        <div className="partner-intro">
          <div className="partner-intro-message">
            <p>{contextMsg}</p>
          </div>
          <div className="partner-intro-actions">
            {hasDraft && (
              <button className="btn btn-primary" onClick={() => {
                setIntroPhase('done');
                setLoaded(false);
                navigate(`/three-tier/${returnContext!.draftId}`);
              }}>
                Go there
              </button>
            )}
            <button className={hasDraft ? 'btn btn-secondary' : 'btn btn-primary'} onClick={() => {
              setIntroPhase('done');
              setLoaded(false);
            }}>
              {hasDraft ? 'Start something else' : 'Let\u2019s go'}
            </button>
          </div>
        </div>
      );
    }

    return null;
  }

  // Format message text with paragraph breaks, line breaks, and basic markdown
  function formatLine(line: string, key: number) {
    const parts: React.ReactNode[] = [];
    let remaining = line;
    let partKey = 0;
    while (remaining.length > 0) {
      const boldMatch = remaining.match(/\*\*(.+?)\*\*/);
      const italicMatch = remaining.match(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/);

      const match = boldMatch && italicMatch
        ? (boldMatch.index! <= italicMatch.index! ? boldMatch : italicMatch)
        : boldMatch || italicMatch;

      if (!match || match.index === undefined) {
        parts.push(<span key={partKey++}>{remaining}</span>);
        break;
      }

      if (match.index > 0) {
        parts.push(<span key={partKey++}>{remaining.slice(0, match.index)}</span>);
      }

      if (match[0].startsWith('**')) {
        parts.push(<strong key={partKey++}>{match[1]}</strong>);
      } else {
        parts.push(<em key={partKey++}>{match[1]}</em>);
      }

      remaining = remaining.slice(match.index + match[0].length);
    }
    return <span key={key}>{parts}</span>;
  }

  function formatContent(text: string) {
    const cleaned = text.replace(/\n\n\[.+\]$/, '');
    const paragraphs = cleaned.split(/\n\n+/);
    return paragraphs.map((p, i) => {
      const lines = p.split(/\n/);
      return (
        <span key={i}>
          {i > 0 && <><br /><br /></>}
          {lines.map((line, j) => (
            <span key={j}>
              {j > 0 && <br />}
              {formatLine(line, j)}
            </span>
          ))}
        </span>
      );
    });
  }

  if (!user) return null;

  return (
    <>
      {/* Floating bubble */}
      {!open && (
        <button
          className={`partner-bubble ${showGlow ? 'partner-glow' : ''}`}
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

            {introduced && introPhase !== 'done' && renderIntro()}

            {introduced && introPhase === 'done' && (
              <>
                {/* Messages */}
                <div className="partner-messages">
                  {/* Return context card for returning users */}
                  {showReturnCard && returnContext && (
                    <div className="partner-return-card" style={{
                      padding: '12px 16px',
                      marginBottom: 8,
                      background: 'var(--bg-secondary, #f8f8fa)',
                      borderRadius: 'var(--radius-sm, 6px)',
                      border: '1px solid var(--border-light, #e5e5ea)',
                    }}>
                      <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 8px', lineHeight: 1.5 }}>
                        {getContextMessage()}
                      </p>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="btn btn-primary btn-sm" onClick={() => {
                          setShowReturnCard(false);
                          navigate(`/three-tier/${returnContext.draftId}`);
                        }}>
                          Go there
                        </button>
                        <button className="btn btn-ghost btn-sm" onClick={() => setShowReturnCard(false)}>
                          Dismiss
                        </button>
                      </div>
                    </div>
                  )}

                  {messages.length === 0 && loaded && !showReturnCard && (
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
