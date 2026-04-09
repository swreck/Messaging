import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
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

// Intro steps: 0=name, 1=phase1, 2=phase2, 3=phase3, 4=done
const INTRO_DONE = 4;

export function MariaPartner() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { pageContext, refreshPage } = useMaria();
  const isAuthPage = ['/login', '/register'].some(p => location.pathname.startsWith(p)) || location.pathname.startsWith('/join/');

  // Panel state
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Intro state — persisted on backend as introStep (0-4)
  const [introStep, setIntroStep] = useState<number>(0);
  const [introduced, setIntroduced] = useState<boolean | null>(null);
  const [customName, setCustomName] = useState('');
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [suggestedName, setSuggestedName] = useState('');

  // Return context and proactive offers
  const [returnContext, setReturnContext] = useState<ReturnContext | null>(null);
  const [showReturnCard, setShowReturnCard] = useState(false);
  const [proactiveOffer, setProactiveOffer] = useState<string | null>(null);
  const [showProactiveCard, setShowProactiveCard] = useState(false);

  // Bubble indicators
  const [showDot, setShowDot] = useState(false);
  const [showGlow, setShowGlow] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const followUpRef = useRef(false);

  // Load status on mount — only if logged in
  useEffect(() => {
    if (!user) return;
    api.get<{ username: string; displayName?: string; introduced: boolean; introStep?: number; returnContext?: ReturnContext | null; proactiveOffer?: string | null }>('/partner/status')
      .then(status => {
        setIntroduced(status.introduced);
        setIntroStep(status.introStep ?? 0);
        setSuggestedName(
          status.username.charAt(0).toUpperCase() + status.username.slice(1)
        );

        if (status.returnContext) {
          setReturnContext(status.returnContext);
        }
        if (status.proactiveOffer) {
          setProactiveOffer(status.proactiveOffer);
        }

        if (!status.introduced) {
          setShowDot(true);
        } else if (status.returnContext || status.proactiveOffer) {
          setShowGlow(true);
        }
      })
      .catch(() => {
        setIntroduced(false);
      });
  }, [user]);

  // Load conversation history when panel first opens and intro is done
  useEffect(() => {
    if (open && !loaded && introduced && introStep >= INTRO_DONE) {
      api.get<{ messages: Message[] }>('/partner/history')
        .then(({ messages: history }) => {
          setMessages(history);
          setLoaded(true);
          if (returnContext) {
            setShowReturnCard(true);
            setShowGlow(false);
          } else if (proactiveOffer) {
            setShowProactiveCard(true);
            setShowGlow(false);
          }
        })
        .catch(() => setLoaded(true));
    }
  }, [open, loaded, introduced, introStep]);

  // Scroll to bottom
  useEffect(() => {
    if (open) {
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    }
  }, [messages, open, sending]);

  // Focus textarea
  useEffect(() => {
    if (open && introStep >= INTRO_DONE) {
      setTimeout(() => textareaRef.current?.focus(), 100);
    }
  }, [open, introStep]);

  // Keyboard shortcut events
  // Ref to hold a pending auto-send message (set by maria-toggle with message detail)
  const pendingMessageRef = useRef<string | null>(null);
  const interviewQuestionRef = useRef(0); // Tracks which interview question we're on (1-6, 0 = not interviewing)
  // Restore counter from profile on mount in case HMR reset it
  useEffect(() => {
    api.get<{ profile: { interviewStep: number; observations: any[] } }>('/personalize/profile')
      .then(({ profile }) => {
        if (profile.interviewStep > 0 && profile.interviewStep < 7 && profile.observations.length === 0) {
          interviewQuestionRef.current = profile.interviewStep;
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    function onToggle(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (detail?.open) {
        setOpen(true);
        setShowDot(false);
        setShowGlow(false);
        if (detail.message) {
          pendingMessageRef.current = detail.message;
          // Suppress proactive offer when a pending message is queued
          setShowProactiveCard(false);
          setShowReturnCard(false);
        }
      }
      else setOpen(false);
    }
    document.addEventListener('maria-toggle', onToggle);
    return () => document.removeEventListener('maria-toggle', onToggle);
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        setOpen(prev => { if (!prev) { setShowDot(false); setShowGlow(false); } return !prev; });
      }
      if (e.key === 'Escape' && open) setOpen(false);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const handleOpen = useCallback(() => { setOpen(true); setShowDot(false); setShowGlow(false); }, []);
  const handleClose = useCallback(() => setOpen(false), []);

  // ─── Intro helpers ──────────────────────────────────

  async function advanceIntro(step: number) {
    setIntroStep(step);
    if (step >= INTRO_DONE) {
      setIntroduced(true);
      setLoaded(false); // trigger history load
    }
    try {
      await api.put('/partner/intro-step', { step });
    } catch { /* non-critical */ }
  }

  async function dismissIntro() {
    setIntroStep(INTRO_DONE);
    setIntroduced(true);
    setOpen(false);
    setLoaded(false);
    try {
      await api.put('/partner/intro-step', { dismiss: true });
    } catch { /* non-critical */ }
  }

  function remindLater() {
    // Just close the panel — introStep stays where it is, so same phase shows next time
    setOpen(false);
  }

  async function confirmName(name: string) {
    try {
      await api.put('/partner/name', { displayName: name });
    } catch { /* non-critical */ }
    setIntroStep(1); // advance past name to Phase 1
  }

  // ─── Send message ───────────────────────────────────

  const send = useCallback(async (overrideText?: string, pageContent?: string) => {
    const text = overrideText || input.trim();
    if (!text || sending) return;

    setShowReturnCard(false);
    setShowProactiveCard(false);

    if (!overrideText) {
      setInput('');
      setMessages(prev => [...prev, { role: 'user', content: text }]);
    }
    setSending(true);

    if (textareaRef.current) textareaRef.current.style.height = 'auto';

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
        setMessages(prev => [...prev, { role: 'assistant', content: 'Let me take a look...' }]);
        try {
          const { content: pc } = await api.post<{ content: string }>('/partner/page-content', { context: pageContext });
          setMessages(prev => prev.slice(0, -1));
          // Recursive send — don't let our finally kill the dots
          followUpRef.current = true;
          send(text, pc);
          return;
        } catch {
          setMessages(prev => {
            const updated = [...prev];
            updated[updated.length - 1] = { role: 'assistant', content: "I wasn't able to read the page content. Could you tell me what you're looking at?" };
            return updated;
          });
          setSending(false);
          return;
        }
      }

      // Interview question injection — frontend controls all questions, Maria only acknowledges
      const INTERVIEW_QUESTIONS = [
        "How would you describe your communication style to someone who's never heard you speak?",
        "If your team got an email from you with no name on it, what would tip them off it was you?",
        "Think of something you wrote recently that you were happy with. What did you like about it — or just paste it in and I'll tell you what I notice.",
        "Are there any words, phrases, or habits in your writing that are just... you? Things people might tease you about or immediately associate with you?",
        "What's something about how you communicate that breaks conventional writing advice but works for you?",
      ];

      if (text.includes('personal writing style')) {
        // Interview just started — show intro + Q1, set local tracker
        interviewQuestionRef.current = 1;
        setMessages(prev => [...prev, { role: 'assistant', content: 'Great — six quick questions about how you write. Here\'s the first one.\n\nHow would you describe your communication style to someone who\'s never heard you speak?' }]);
      } else if (interviewQuestionRef.current >= 1 && interviewQuestionRef.current <= 4) {
        console.log('[INTERVIEW] Counter before increment:', interviewQuestionRef.current, 'Will inject Q' + (interviewQuestionRef.current + 1));
        // Q2-Q5: extract brief acknowledgment from Opus, append the correct next question
        interviewQuestionRef.current++;
        const nextQ = INTERVIEW_QUESTIONS[interviewQuestionRef.current - 1];
        // Take first sentence of Opus's response as acknowledgment
        const firstSentence = result.response.match(/^[^.!?]*[.!?]/)?.[0] || 'Got it.';
        setMessages(prev => [...prev, { role: 'assistant', content: `${firstSentence}\n\n${nextQ}` }]);
      } else if (interviewQuestionRef.current === 5) {
        console.log('[INTERVIEW] Counter is 5 — Q6 comparative path');
        // After Q5 answer → Q6 is comparative. Fetch the versions from the profile and inject them.
        interviewQuestionRef.current = 6;
        const firstSentence = result.response.match(/^[^.!?]*[.!?]/)?.[0] || 'Got it.';
        try {
          const { profile: p } = await api.get<{ profile: { comparativeQ6?: { versionA: string; versionB: string } } }>('/personalize/profile');
          if (p.comparativeQ6) {
            setMessages(prev => [...prev, { role: 'assistant', content: `${firstSentence}\n\nLast question — here are two versions of the same paragraph. Which one sounds more like something you'd say?\n\n**Version A:**\n${p.comparativeQ6!.versionA}\n\n**Version B:**\n${p.comparativeQ6!.versionB}` }]);
          } else {
            setMessages(prev => [...prev, { role: 'assistant', content: result.response, actionResult: result.actionResult }]);
          }
        } catch {
          setMessages(prev => [...prev, { role: 'assistant', content: result.response, actionResult: result.actionResult }]);
        }
      } else if (interviewQuestionRef.current === 6) {
        // Q6 answered — interview done. Replace Opus's response with a definitive confirmation.
        interviewQuestionRef.current = 0;
        setMessages(prev => [...prev, { role: 'assistant', content: "I've got it. From now on when you hit Personalize, I'll adjust the story to sound more like you. If you want to change this later, just tell me you want to adjust your personal style. Or paste in any document you like and I'll analyze it." }]);
      } else {
        setMessages(prev => [...prev, { role: 'assistant', content: result.response, actionResult: result.actionResult }]);
      }

      if (result.actionResult) {
        const navMatch = result.actionResult.match(/\[NAVIGATE:([^\]]+)\]/);
        if (navMatch) setTimeout(() => navigate(navMatch[1]), 1200);
      }

      if (result.refreshNeeded) refreshPage();
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Sorry, I had trouble with that. Try again?' }]);
    } finally {
      if (followUpRef.current) {
        followUpRef.current = false; // Let the recursive call own the dots
      } else {
        setSending(false);
      }
    }
  }, [input, sending, pageContext, refreshPage]);

  // Auto-send pending message after panel opens
  useEffect(() => {
    if (open && loaded && pendingMessageRef.current && !sending) {
      const msg = pendingMessageRef.current;
      pendingMessageRef.current = null;
      setTimeout(() => send(msg), 300);
    }
  }, [open, loaded, sending, send]);

  // ─── Context message for Phase 3 ───────────────���───

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
        return `Your Three Tier for ${offeringName} → ${audienceName} is done. Want to turn it into something or start something new?`;
      }
      return `Your ${offeringName} work is in good shape. Want to revisit it or start something new?`;
    }
    return `What are you working on? Tell me about your product or service, and who needs to hear about it.`;
  }

  // ─── Render intro ──────────────────────────────────

  function renderIntro() {
    // Step 0: Name capture
    if (introStep === 0) {
      return (
        <div className="partner-intro">
          <div className="partner-intro-message">
            <p>Hi — I'm Maria. Can I call you {suggestedName}?</p>
          </div>
          <div className="partner-intro-actions">
            {!showCustomInput ? (
              <>
                <button className="btn btn-primary" onClick={() => confirmName(suggestedName)}>That's me</button>
                <button className="btn btn-ghost" onClick={() => setShowCustomInput(true)}>Call me something else</button>
              </>
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
                <button className="btn btn-primary btn-sm" onClick={() => customName.trim() && confirmName(customName.trim())} disabled={!customName.trim()}>
                  That's it
                </button>
              </div>
            )}
          </div>
        </div>
      );
    }

    // Step 1: Phase 1 — interested in what I can do?
    if (introStep === 1) {
      return (
        <div className="partner-intro">
          <div className="partner-intro-message">
            <p>I've been here before, but I've gotten better. Interested in what I can do?</p>
          </div>
          <div className="partner-intro-actions">
            <button className="btn btn-primary" onClick={() => advanceIntro(2)}>Yes</button>
            <button className="btn btn-secondary" onClick={remindLater}>Remind me later</button>
            <button className="btn btn-ghost" onClick={dismissIntro}>Dismiss</button>
          </div>
        </div>
      );
    }

    // Step 2: Phase 2 — the real value
    if (introStep === 2) {
      return (
        <div className="partner-intro">
          <div className="partner-intro-message">
            <p>I can manage the whole process. Tell me about your product and audience, and I'll interview you one question at a time — pulling out what matters and building the structure as we go. Or use the app directly and bring me in whenever.</p>
          </div>
          <div className="partner-intro-actions">
            <button className="btn btn-primary" onClick={() => advanceIntro(3)}>Continue</button>
            <button className="btn btn-secondary" onClick={remindLater}>Remind me later</button>
            <button className="btn btn-ghost" onClick={dismissIntro}>Dismiss</button>
          </div>
        </div>
      );
    }

    // Step 3: Phase 3 — context
    if (introStep === 3) {
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
                advanceIntro(INTRO_DONE);
                navigate(`/three-tier/${returnContext!.draftId}`);
              }}>
                Go there
              </button>
            )}
            <button className={hasDraft ? 'btn btn-secondary' : 'btn btn-primary'} onClick={() => advanceIntro(INTRO_DONE)}>
              {hasDraft ? 'Start something else' : 'Let\u2019s go'}
            </button>
          </div>
        </div>
      );
    }

    return null;
  }

  // ─── Format helpers ─────────────────────────────────

  function formatContent(text: string) {
    // Strip [PAGE CONTENT] blocks from legacy messages
    let stripped = text.replace(/\[PAGE CONTENT\][\s\S]*?\[USER QUESTION\]\n?/g, '');
    const cleaned = stripped.replace(/\n\n\[.+\]$/, '');
    // Apply markdown at full-text level first, then handle line breaks via dangerouslySetInnerHTML
    let html = cleaned
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/gs, '<strong>$1</strong>')
      .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/gs, '<em>$1</em>')
      .replace(/^(\* )(.+)$/gm, '• $2')
      .replace(/\n\n+/g, '<br/><br/>')
      .replace(/\n/g, '<br/>');
    return <span dangerouslySetInnerHTML={{ __html: html }} />;
  }

  // ─── Render ─────────────────────────────────────────

  if (!user || isAuthPage) return null;

  const statusLoaded = introduced !== null;
  const showIntro = statusLoaded && (!introduced || introStep < INTRO_DONE);

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
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
          </svg>
          {showDot && <span className="partner-dot" />}
        </button>
      )}

      {/* Chat panel */}
      {open && (
        <div className="partner-panel" ref={panelRef}>
          <div className="partner-header">
            <span className="partner-header-name">Maria</span>
            <button className="partner-close" onClick={handleClose} aria-label="Close">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="partner-body">
            {!statusLoaded && (
              <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-tertiary)' }}>
                <span>Loading...</span>
              </div>
            )}
            {showIntro && renderIntro()}

            {statusLoaded && !showIntro && (
              <>
                <div className="partner-messages">
                  {/* Return context card */}
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
                        }}>Go there</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => setShowReturnCard(false)}>Dismiss</button>
                      </div>
                    </div>
                  )}

                  {/* Proactive offer card */}
                  {showProactiveCard && proactiveOffer && !showReturnCard && (
                    <div className="partner-return-card" style={{
                      padding: '12px 16px',
                      marginBottom: 8,
                      background: 'var(--bg-secondary, #f8f8fa)',
                      borderRadius: 'var(--radius-sm, 6px)',
                      border: '1px solid var(--border-light, #e5e5ea)',
                    }}>
                      <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 8px', lineHeight: 1.5 }}>
                        {proactiveOffer}
                      </p>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="btn btn-primary btn-sm" onClick={() => {
                          setShowProactiveCard(false);
                          send(proactiveOffer);
                        }}>Yes, go ahead</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => setShowProactiveCard(false)}>Not now</button>
                      </div>
                    </div>
                  )}

                  {messages.length === 0 && loaded && !showReturnCard && !showProactiveCard && (
                    <div className="partner-empty">What's on your mind?</div>
                  )}
                  {messages.map((msg, i) => (
                    <div key={i} className={`partner-msg partner-msg-${msg.role}`}>
                      {formatContent(msg.content)}
                      {msg.actionResult && <span className="partner-action-badge">{msg.actionResult.replace(/\[NAVIGATE:[^\]]+\]\s*/g, '').trim()}</span>}
                    </div>
                  ))}
                  {sending && (
                    <div className="partner-msg partner-msg-assistant partner-typing">
                      <span /><span /><span />
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>

                <div className="partner-input-area">
                  <textarea
                    ref={textareaRef}
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                    onInput={e => {
                      const el = e.currentTarget;
                      el.style.height = 'auto';
                      el.style.height = Math.min(el.scrollHeight, 100) + 'px';
                    }}
                    placeholder="Talk to Maria..."
                    disabled={sending}
                    rows={1}
                  />
                  <button className="partner-send" onClick={() => send()} disabled={!input.trim() || sending} aria-label="Send">
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
