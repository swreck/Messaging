import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useMaria } from './MariaContext';
import { useGuidedSessionContext } from '../guided/GuidedSessionContext';
import { GuidedFlow } from '../guided/GuidedFlow';
import {
  detectLeadDirective,
  directiveConflictsWithToggle,
  setToggleState,
  bumpOverrideCount,
  resetOverrideCount,
  getOverrideCount,
  type LeadDirection,
} from './leadershipDetection';

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
  lastActivityAt?: string;
}

// Step 7: warm relative-time phrasing for return greetings.
// "earlier today" / "yesterday" / "3 days ago" / "last week" / "a while back"
function describeWhen(iso?: string): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (isNaN(then)) return '';
  const hrs = (Date.now() - then) / 3_600_000;
  if (hrs < 12) return 'earlier today';
  if (hrs < 36) return 'yesterday';
  const days = hrs / 24;
  if (days < 7) return `${Math.round(days)} days ago`;
  if (days < 14) return 'last week';
  if (days < 45) return `${Math.round(days / 7)} weeks ago`;
  return 'a while back';
}

// Intro steps: 0=name, 1=phase1, 2=phase2, 3=phase3, 4=done
const INTRO_DONE = 4;

// Round C Bug #3 — placeholder-storyId guard. Reject the literal "storyId"
// AND the obviously-fake example sentinel "cmEXAMPLE0000000000000000" so a
// marker-handler never fires against a non-existent story when Maria copies
// a prompt example verbatim.
const PLACEHOLDER_STORY_IDS: ReadonlySet<string> = new Set([
  'storyId',
  'cmEXAMPLE0000000000000000',
]);
function isValidStoryId(id: string | undefined | null): boolean {
  if (!id) return false;
  const trimmed = id.trim();
  if (!trimmed) return false;
  if (trimmed.length < 5) return false;
  if (PLACEHOLDER_STORY_IDS.has(trimmed)) return false;
  return true;
}

// Synthetic-marker patterns. Internal routing tokens like [STATE_RECAP],
// [OPEN_ON_PAGE], [REVIEW_TIER2_COLUMN:Focus], [PPTX_PREVIEW:storyId],
// [CONFIRM_PPTX:...], [PRE_CHAPTER_4:...], [SAVE_PEER_INFO:...],
// [SET_VIEW_MODE:...], [TIME_THRESHOLD_REACHED:...], [FOUNDATION],
// [INSTRUCTION: ...] are routing breadcrumbs the user should never see.
//
// Two filters work together:
//   - WHOLE-MESSAGE filter: drop user/assistant bubbles whose entire content
//     is a single marker (e.g. when the synthetic message is the only payload).
//   - INLINE filter: strip embedded markers from message text before render
//     so a marker that appears mid-message (e.g. Maria's preview "[PPTX_PREVIEW:storyId]
//     I'll produce a 13-slide…") never shows up as visible text.
//
// Both patterns recognize the same token shape: ALL-CAPS name plus an optional
// colon-prefixed payload of arbitrary characters up to the closing bracket.
// The payload may include spaces, equals, commas, dashes, etc. (see
// [INSTRUCTION: rewrite this in plain voice]).
const SYNTHETIC_MARKER_RE = /^\s*\[[A-Z_]+(?:\s*:[^\]]*)?\]\s*$/;
const SYNTHETIC_MARKER_GLOBAL_RE = /\[[A-Z][A-Z_]*(?:\s*:[^\]]*)?\]/g;
function isSyntheticMarker(content: string): boolean {
  return SYNTHETIC_MARKER_RE.test(content);
}
function stripSyntheticMarkers(content: string): string {
  if (!content) return content;
  // Replace each inline marker with an empty string, then collapse the
  // resulting double-spaces / leading-trailing whitespace so the remaining
  // text reads cleanly. We do NOT touch markdown-style links like [text](url)
  // because the regex requires ALL-CAPS inside the brackets.
  return content
    .replace(SYNTHETIC_MARKER_GLOBAL_RE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[ \t\n]+|[ \t\n]+$/g, '');
}

// Round B6 — time-aware session pacing. Per-tab session state lives in
// localStorage so reloads preserve the budget and trigger-once semantics.
// Keys are date-stamped so a fresh day always asks again.
type TimeContext = {
  sessionStartMs?: number;
  budgetMin?: number;
  thresholdTriggered?: boolean;
};
function getSessionDateKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
function loadTimeContext(): TimeContext {
  try {
    const raw = localStorage.getItem(`time-context-${getSessionDateKey()}`);
    if (raw) return JSON.parse(raw) as TimeContext;
  } catch {}
  return {};
}
function saveTimeContext(tc: TimeContext) {
  try {
    localStorage.setItem(`time-context-${getSessionDateKey()}`, JSON.stringify(tc));
  } catch {}
}
function hasAskedTimeBudget(): boolean {
  try {
    return !!localStorage.getItem(`time-budget-asked-${getSessionDateKey()}`);
  } catch {
    return true; // err on the side of not re-asking
  }
}
function markTimeBudgetAsked() {
  try {
    localStorage.setItem(`time-budget-asked-${getSessionDateKey()}`, '1');
  } catch {}
}

type PanelSize = 'compact' | 'medium' | 'full';

function getInitialPanelSize(): PanelSize {
  try {
    const saved = localStorage.getItem('maria-panel-size') as PanelSize | null;
    if (saved === 'compact' || saved === 'medium' || saved === 'full') return saved;
  } catch {}
  // Default: compact on phone, medium elsewhere
  if (typeof window !== 'undefined' && window.innerWidth <= 600) return 'compact';
  return 'medium';
}

export function MariaPartner() {
  const { user, refreshUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { pageContext, refreshPage } = useMaria();
  const { hasActiveGuidedSession, startNewSession } = useGuidedSessionContext();
  // Hide on auth pages only. Maria now appears on every other page, including
  // former /express (which is being removed — this hide rule is dropped).
  const isAuthPage =
    ['/login', '/register'].some(p => location.pathname.startsWith(p)) ||
    location.pathname.startsWith('/join/');

  // Guided-mode visibility within the panel. Separate from hasActiveGuidedSession because:
  // - enteringGuided: user just clicked "Start a guided message" — new session exists but has no
  //   content yet, so hasActiveGuidedSession is still false until GuidedFlow adds the first message.
  // - preferAssistant: user clicked "Chat with Maria instead" from inside guided. They want the
  //   assistant view even though a guided session is still active in the background.
  const [enteringGuided, setEnteringGuided] = useState(false);
  const [preferAssistant, setPreferAssistant] = useState(false);
  const showGuidedInPanel = (hasActiveGuidedSession || enteringGuided) && !preferAssistant;
  // Once the guided session picks up content, clear the transient entering flag.
  useEffect(() => { if (hasActiveGuidedSession && enteringGuided) setEnteringGuided(false); }, [hasActiveGuidedSession, enteringGuided]);

  // Panel state
  const [open, setOpen] = useState(false);
  const [panelSize, setPanelSize] = useState<PanelSize>(getInitialPanelSize);

  function changePanelSize(size: PanelSize) {
    setPanelSize(size);
    try { localStorage.setItem('maria-panel-size', size); } catch {}
  }
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [thinkingSlow, setThinkingSlow] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<{ data: string; mimeType: string; filename: string }[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [loaded, setLoaded] = useState(false);

  // Intro state — persisted on backend as introStep (0-4)
  const [introStep, setIntroStep] = useState<number>(0);
  const [introduced, setIntroduced] = useState<boolean | null>(null);
  const [customName, setCustomName] = useState('');
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [suggestedName, setSuggestedName] = useState('');

  // Round B6 — time-aware session pacing
  const [timeContext, setTimeContext] = useState<TimeContext>(() => loadTimeContext());
  const [showBudgetCard, setShowBudgetCard] = useState<boolean>(() => !hasAskedTimeBudget());

  // Return context and proactive offers
  const [returnContext, setReturnContext] = useState<ReturnContext | null>(null);
  const [showReturnCard, setShowReturnCard] = useState(false);
  const [proactiveOffer, setProactiveOffer] = useState<string | null>(null);
  const [showProactiveCard, setShowProactiveCard] = useState(false);
  // Active (non-completed) guided session the user walked away from. When set,
  // Maria offers "resume where you left off" as the highest-priority return offer.
  const [resumeDraft, setResumeDraft] = useState<{ sessionId: string; summary: string; phase: string } | null>(null);

  // Bubble indicators
  const [showDot, setShowDot] = useState(false);
  const [showGlow, setShowGlow] = useState(false);

  // Toggle-can't-lie: when a user's in-chat directive conflicts with the visible
  // "Let Maria lead" toggle, Maria does the requested thing immediately AND offers
  // to promote the change to the toggle. The card below the latest exchange
  // presents the offer. After three dismissals in the same direction, the ask
  // softens (a little self-aware note) rather than repeating verbatim.
  const [leadPromotion, setLeadPromotion] = useState<{
    direction: LeadDirection;
    softened: boolean;
  } | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const followUpRef = useRef(false);

  // Load status on mount — only if logged in
  useEffect(() => {
    if (!user) return;
    api.get<{ username: string; displayName?: string; introduced: boolean; introStep?: number; returnContext?: ReturnContext | null; proactiveOffer?: string | null; resumeDraft?: { sessionId: string; summary: string; phase: string } | null }>('/partner/status')
      .then(status => {
        setIntroduced(status.introduced);
        setIntroStep(status.introStep ?? 0);
        const name = status.displayName || status.username || '';
        setSuggestedName(
          name ? name.charAt(0).toUpperCase() + name.slice(1) : ''
        );

        if (status.returnContext) {
          setReturnContext(status.returnContext);
        }
        if (status.proactiveOffer) {
          setProactiveOffer(status.proactiveOffer);
        }
        if (status.resumeDraft) {
          setResumeDraft(status.resumeDraft);
        }

        if (!status.introduced) {
          setShowDot(true);
        } else if (status.returnContext || status.proactiveOffer || status.resumeDraft) {
          setShowGlow(true);
        }
      })
      .catch(() => {
        setIntroduced(false);
      });
  }, [user]);

  // Push page content aside when panel is open (desktop/tablet).
  useEffect(() => {
    if (open) {
      document.body.classList.add('maria-panel-open');
    } else {
      document.body.classList.remove('maria-panel-open');
    }
    return () => { document.body.classList.remove('maria-panel-open'); };
  }, [open]);

  // Screen Wake Lock — prevent iPhone from sleeping during dictation.
  // Acquired when the partner panel opens, released when it closes.
  useEffect(() => {
    let wakeLock: WakeLockSentinel | null = null;
    if (open && 'wakeLock' in navigator) {
      navigator.wakeLock.request('screen')
        .then(wl => { wakeLock = wl; })
        .catch(() => {}); // Silently fail on unsupported browsers
    }
    return () => { wakeLock?.release().catch(() => {}); };
  }, [open]);

  // Load conversation history when panel first opens and intro is done
  useEffect(() => {
    if (open && !loaded && introduced) {
      api.get<{ messages: Message[] }>('/partner/history')
        .then(async ({ messages: history }) => {
          if (history.length === 0) {
            const firstName = suggestedName ? suggestedName.split(/\s+/)[0] : '';
            const onEntityDetailPage =
              pageContext &&
              ['offering', 'audience', 'three-tier', 'five-chapter'].includes(pageContext.page) &&
              (pageContext.offeringId || pageContext.audienceId || pageContext.draftId || pageContext.storyId);
            // Change 11 — if Maria is opening on an entity-detail page that already
            // has the user's context, she should reference the entity by name and
            // propose next moves rather than ask "what are you working on?" The
            // synthetic message below tells the partner endpoint to compose a
            // context-aware greeting using the partner system prompt's existing
            // page-awareness; partner.ts is updated to handle this trigger.
            if (onEntityDetailPage) {
              try {
                const result = await api.post<{ response: string }>('/partner/message', {
                  message: '[OPEN_ON_PAGE]',
                  context: pageContext,
                });
                if (result.response) {
                  setMessages([{ role: 'assistant', content: result.response }]);
                } else {
                  // Fallback to generic greeting if partner returns nothing.
                  const fallback = firstName
                    ? `Hi ${firstName} — I see you're here. Tell me what you'd like to work on.`
                    : 'I see you\'re here. Tell me what you\'d like to work on.';
                  setMessages([{ role: 'assistant', content: fallback }]);
                }
              } catch {
                // Network error: still show something rather than nothing.
                const fallback = firstName
                  ? `Hi ${firstName} — I see you're here. Tell me what you'd like to work on.`
                  : 'I see you\'re here. Tell me what you\'d like to work on.';
                setMessages([{ role: 'assistant', content: fallback }]);
              }
            } else if (returnContext) {
              // Change 16 — Returning-user briefing: send [STATE_RECAP] for a
              // catch-up briefing with equal-weight next-move options. Same
              // synthetic-message handler covers Change 14's toggle-ON activation.
              try {
                const result = await api.post<{ response: string }>('/partner/message', {
                  message: '[STATE_RECAP]',
                  context: pageContext,
                });
                if (result.response) {
                  setMessages([{ role: 'assistant', content: result.response }]);
                } else {
                  const fallback = firstName ? `Welcome back, ${firstName}.` : 'Welcome back.';
                  setMessages([{ role: 'assistant', content: fallback }]);
                }
              } catch {
                const fallback = firstName ? `Welcome back, ${firstName}.` : 'Welcome back.';
                setMessages([{ role: 'assistant', content: fallback }]);
              }
            } else {
              const greeting = firstName
                ? `Hi ${firstName} — what are you working on today? Tell me about what you need to communicate and who needs to hear it, or just ask me anything.`
                : "Hi — what are you working on today? Tell me about what you need to communicate and who needs to hear it, or just ask me anything.";
              setMessages([{ role: 'assistant', content: greeting }]);
            }
          } else {
            setMessages(history);
          }
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
    if (open && introduced) {
      setTimeout(() => textareaRef.current?.focus(), 100);
    }
  }, [open, introStep]);

  // Keyboard shortcut events
  // Ref to hold a pending auto-send message (set by maria-toggle with message detail)
  const pendingMessageRef = useRef<string | null>(null);
  const interviewQuestionRef = useRef(0); // Tracks which interview question we're on (1-6, 0 = not interviewing)
  // Restore counter from profile on mount in case HMR reset it
  useEffect(() => {
    if (!user) return;
    api.get<{ profile: { interviewStep: number; observations: any[] } }>('/personalize/profile')
      .then(({ profile }) => {
        if (profile.interviewStep > 0 && profile.interviewStep < 7 && profile.observations.length === 0) {
          interviewQuestionRef.current = profile.interviewStep;
        }
      })
      .catch(() => {});
  }, [user]);

  // Stashed hint message (assistant-authored) to be appended when the user opens the panel
  const pendingHintRef = useRef<string | null>(null);

  // Round B Bug #1 — defense-in-depth for the SAVE_PEER_INFO marker.
  // When the frontend dispatches [PRE_CHAPTER_4:storyId:...], we record the
  // storyId here. The user's NEXT message is captured into peerPromptContextRef
  // so that if Maria writes a "Writing Chapter 4 with [peer]" confirmation
  // WITHOUT emitting the SAVE_PEER_INFO marker, the frontend can fall back to
  // saving the peer info itself using the user's free-text answer.
  const pendingPeerStoryIdRef = useRef<string | null>(null);
  const peerPromptContextRef = useRef<{ storyId: string; userAnswer: string } | null>(null);

  useEffect(() => {
    function onToggle(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (detail?.glow && !detail?.open) {
        // Non-blocking hint: glow the bubble so the user notices Maria has something to say
        setShowGlow(true);
        if (detail.message) {
          pendingHintRef.current = detail.message;
        }
        return;
      }
      if (detail?.open) {
        setOpen(true);
        setShowDot(false);
        setShowGlow(false);
        if (detail.hint && detail.message) {
          // Proactive hint: inject as an assistant message, no user message, no backend call
          pendingHintRef.current = detail.message;
        } else if (detail.message) {
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

  // When the panel opens with a stashed hint, append it as an assistant message.
  useEffect(() => {
    if (open && loaded && pendingHintRef.current) {
      const hint = pendingHintRef.current;
      pendingHintRef.current = null;
      setMessages(prev => [...prev, { role: 'assistant', content: hint }]);
    }
  }, [open, loaded]);

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

  // FAB click — default to chat view. If the user has an active guided session, a
  // "Return to your guided message" card appears at the top of chat so they can
  // resume the wizard in one tap. Opening the FAB should feel like tapping a
  // partner on the shoulder (chat), not falling back into a wizard they may have
  // left mid-step.
  const handleOpen = useCallback(() => {
    setPreferAssistant(true);
    setOpen(true);
    setShowDot(false);
    setShowGlow(false);
  }, []);
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

  // remindLater removed — intro simplified to 2 steps

  async function confirmName(name: string) {
    try {
      await api.put('/partner/name', { displayName: name });
      // Pull the new name into the auth user so the top nav and other
      // user-bound UI stop showing the raw workspace username.
      await refreshUser();
    } catch { /* non-critical */ }
    // Refresh the name used in subsequent greetings — otherwise the first
    // conversation greeting still reads "Hi <username>" after the user
    // just told Maria their real name.
    setSuggestedName(name.charAt(0).toUpperCase() + name.slice(1));
    setIntroStep(1); // advance past name to Phase 1
  }

  // ─── Send message ───────────────────────────────────

  const send = useCallback(async (overrideText?: string, pageContent?: string) => {
    const text = overrideText || input.trim();
    if ((!text && pendingFiles.length === 0) || sending) return;

    setShowReturnCard(false);
    setShowProactiveCard(false);

    // Step 6: Explicit handoff — user asks Maria to lead. Start a guided session so
    // the GuidedFlow picks up the conversation. No mode announcement, just an energy shift.
    const HANDOFF = /\b(tell me what to do|lead me|guide me|walk me through|take me through|help me (?:build|start|make|get started)|take over|you (?:lead|drive)|show me how (?:to )?(?:start|begin)|where do I (?:start|begin)|i don'?t know where to (?:start|begin))\b/i;
    if (HANDOFF.test(text) && !hasActiveGuidedSession && !enteringGuided) {
      setEnteringGuided(true);
      setPreferAssistant(false);
      if (!overrideText) {
        setInput('');
        setMessages(prev => [...prev, { role: 'user', content: text }]);
      }
      try {
        await startNewSession();
      } catch {
        setEnteringGuided(false);
      }
      return;
    }

    // Local "stop jumping in" intercept — user can opt out of proactive help without a backend call
    const lower = text.toLowerCase();
    if (/\bstop\s+jumping\s+in\b/.test(lower) || /\b(turn off|disable|stop)\b.*\bproactive\b/.test(lower)) {
      try { localStorage.setItem('maria-proactive-help-off', '1'); } catch {}
      if (!overrideText) {
        setInput('');
        setMessages(prev => [...prev, { role: 'user', content: text }, {
          role: 'assistant',
          content: "Got it. I'll stay in the bubble unless you open me. If you change your mind, say \"start jumping in\" and I'll help out again.",
        }]);
      }
      return;
    }
    if (/\bstart\s+jumping\s+in\b/.test(lower)) {
      try { localStorage.removeItem('maria-proactive-help-off'); } catch {}
      if (!overrideText) {
        setInput('');
        setMessages(prev => [...prev, { role: 'user', content: text }, {
          role: 'assistant',
          content: "Okay, I'll jump in with tips when you hit new stages.",
        }]);
      }
      return;
    }

    // Toggle-can't-lie detection. A pure lead directive ("just decide", "ask
    // me first") is a meta-instruction about HOW Maria should work — it isn't
    // a task. Handle it client-side so Maria acknowledges directly instead of
    // round-tripping through the partner prompt (which treats it as a bad
    // request and replies "Sorry, I had trouble with that"). If the directive
    // conflicts with the current toggle, also queue the promotion offer.
    {
      const directive = detectLeadDirective(text);
      if (directive) {
        const conflicts = directiveConflictsWithToggle(directive);
        const reply = directive === 'more'
          ? (conflicts
              ? "Got it — I'll take the lead on this one."
              : "Got it — staying in the lead.")
          : (conflicts
              ? "Okay — I'll slow down and check in as we go."
              : "Okay — I'll keep checking in.");
        if (!overrideText) {
          setInput('');
          setMessages(prev => [
            ...prev,
            { role: 'user', content: text },
            { role: 'assistant', content: reply },
          ]);
        }
        if (conflicts) {
          const softened = getOverrideCount(directive) >= 3;
          setLeadPromotion({ direction: directive, softened });
        }
        if (textareaRef.current) textareaRef.current.style.height = 'auto';
        return;
      }
    }

    if (!overrideText) {
      setInput('');
      setMessages(prev => [...prev, { role: 'user', content: (text ? text : '') + (pendingFiles.length > 0 ? ` (${pendingFiles.length} files)` : '') }]);
    }

    // Round B Bug #1 — capture peer-prompt context for the SAVE_PEER_INFO fallback.
    // When the synthetic [PRE_CHAPTER_4:storyId:...] message goes out, record the
    // storyId. The next user message after that is the peer answer; record it so
    // the response handler can save it directly if Maria forgets the marker.
    const preChapterMatch = text.match(/^\s*\[PRE_CHAPTER_4:([^:\]]+):/);
    if (preChapterMatch) {
      pendingPeerStoryIdRef.current = preChapterMatch[1];
      peerPromptContextRef.current = null;
    } else if (pendingPeerStoryIdRef.current && text.trim()) {
      // This message is the user's free-text answer to the peer prompt.
      peerPromptContextRef.current = { storyId: pendingPeerStoryIdRef.current, userAnswer: text };
      pendingPeerStoryIdRef.current = null;
    }

    setSending(true);

    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    try {
      const result = await api.post<{
        response: string;
        actionResult: string | null;
        refreshNeeded: boolean;
        needsPageContent?: boolean;
        timeThresholdFired?: boolean;
      }>('/partner/message', {
        message: pageContent ? `[PAGE CONTENT]\n${pageContent}\n\n[USER QUESTION]\n${text}` : text,
        context: pageContext,
        ...(pendingFiles.length === 1 ? { attachment: pendingFiles[0] } : pendingFiles.length > 1 ? { attachments: pendingFiles } : {}),
        // Round B6 — send time context so the backend can decide whether to inject
        // the [TIME_THRESHOLD_REACHED] marker. Only sent if the user set a budget.
        ...(timeContext.budgetMin && timeContext.sessionStartMs ? { timeContext } : {}),
      });
      // Round B6 — backend tells us when the threshold marker fired this turn so
      // we can persist thresholdTriggered=true and avoid re-firing on later messages.
      if (result.timeThresholdFired && !timeContext.thresholdTriggered) {
        const updated: TimeContext = { ...timeContext, thresholdTriggered: true };
        setTimeContext(updated);
        saveTimeContext(updated);
      }
      setPendingFiles([]);

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
        // If response is empty but actions happened, generate a visible message
        // so the user never sees a blank bubble. This handles the case where
        // the server returns actions but empty text for any reason.
        let displayResponse = result.response;
        if (!displayResponse?.trim() && result.actionResult) {
          if (result.actionResult.includes('BUILD_STARTED')) {
            displayResponse = "I'm putting together your draft now. I'll bring you right to it when it's ready.";
          } else if (result.actionResult.includes('Created offering') || result.actionResult.includes('Created audience')) {
            displayResponse = "Got it — I've set that up. Let me keep building.";
          } else {
            displayResponse = "Working on it.";
          }
        }
        // Round A1 — Maria-equivalent path: scan for [SET_VIEW_MODE:...] marker
        // and dispatch a frontend event so the Three Tier review's view mode
        // updates without the user touching the segmented control. Strip the
        // marker from the visible text so it doesn't render as a bracketed token.
        let cleanedResponse = displayResponse || result.response;
        if (cleanedResponse) {
          const vmMatch = cleanedResponse.match(/\[SET_VIEW_MODE:(no-markup|minimal|all-markup)\]/);
          if (vmMatch) {
            const mode = vmMatch[1] as 'no-markup' | 'minimal' | 'all-markup';
            document.dispatchEvent(new CustomEvent('three-tier-view-mode', { detail: { mode } }));
            cleanedResponse = cleanedResponse.replace(/\s*\[SET_VIEW_MODE:[^\]]+\]\s*/g, '').trim();
          }
          // Round D — provenance Maria-equivalent path (Topic 21). Maria emits
          // one of several markers when the user drives the provenance system
          // through chat. These all share the storyId-substitution rules from
          // Bug #3: the FE rejects placeholder cuids before dispatching.
          // [SET_PROVENANCE_VIEW_MODE:no-markup|minimal|all-markup]
          const provViewMatch = cleanedResponse.match(/\[SET_PROVENANCE_VIEW_MODE:(no-markup|minimal|all-markup)\]/);
          if (provViewMatch) {
            const mode = provViewMatch[1];
            document.dispatchEvent(new CustomEvent('provenance-view-mode', { detail: { mode } }));
            cleanedResponse = cleanedResponse.replace(/\s*\[SET_PROVENANCE_VIEW_MODE:[^\]]+\]\s*/g, '').trim();
          }
          // [PROVENANCE_CUT:storyId:claimId], [PROVENANCE_OWN:storyId:claimId],
          // [PROVENANCE_EDIT:storyId:claimId:new sentence],
          // [PROVENANCE_ADD_SOURCE:storyId:claimId:URL]
          const provResolveMatch = cleanedResponse.match(/\[PROVENANCE_(CUT|OWN|EDIT|ADD_SOURCE):([^:\]]+):([^:\]]+)(?::([^\]]*))?\]/);
          if (provResolveMatch) {
            const action = provResolveMatch[1];
            const storyId = provResolveMatch[2].trim();
            const claimId = provResolveMatch[3].trim();
            const payload = provResolveMatch[4] || '';
            if (isValidStoryId(storyId) && claimId && claimId.length >= 5 && claimId !== 'claimId') {
              const body: Record<string, unknown> = {
                CUT: { action: 'cut' },
                OWN: { action: 'own' },
                EDIT: { action: 'edit', newSentence: payload },
                ADD_SOURCE: { action: 'add-source', sourceUrl: payload },
              }[action] || {};
              api.patch<any>(`/ai/claims/${claimId}`, body)
                .then((r) => {
                  document.dispatchEvent(new CustomEvent('provenance-claim-resolved', { detail: { storyId, claimId, action, result: r } }));
                })
                .catch((e) => console.error('[provenance] action failed', e));
            } else {
              console.warn(`[PROVENANCE_${action}] ignored placeholder ids:`, storyId, claimId);
            }
            cleanedResponse = cleanedResponse.replace(/\s*\[PROVENANCE_[A-Z_]+:[^\]]+\]\s*/g, '').trim();
          }
          // [PROVENANCE_OWN_ALL:storyId] — bulk-own every OPEN INFERENCE claim.
          const provOwnAllMatch = cleanedResponse.match(/\[PROVENANCE_OWN_ALL:([^\]]+)\]/);
          if (provOwnAllMatch) {
            const storyId = provOwnAllMatch[1].trim();
            if (isValidStoryId(storyId)) {
              api.get<{ claims: Array<{ id: string; state: string; origin: string }> }>(`/ai/stories/${storyId}/claims`)
                .then(async ({ claims }) => {
                  const targets = (claims || []).filter(c => c.state === 'OPEN' && c.origin === 'INFERENCE');
                  await Promise.all(targets.map(c => api.patch(`/ai/claims/${c.id}`, { action: 'own' }).catch(() => {})));
                  document.dispatchEvent(new CustomEvent('provenance-claim-resolved', { detail: { storyId, action: 'OWN_ALL', count: targets.length } }));
                })
                .catch((e) => console.error('[provenance] own-all failed', e));
            } else {
              console.warn('[PROVENANCE_OWN_ALL] ignored placeholder storyId:', storyId);
            }
            cleanedResponse = cleanedResponse.replace(/\s*\[PROVENANCE_OWN_ALL:[^\]]+\]\s*/g, '').trim();
          }
          // [PROVENANCE_LIST_REQUEST:storyId] — Maria asked the system to surface
          // the unsourced claim list for her next reply. We don't act on this
          // synchronously; the system already surfaces claims via STORY_CONTEXT.
          // Strip it so the user doesn't see a routing token in chat.
          if (/\[PROVENANCE_LIST_REQUEST:/.test(cleanedResponse)) {
            cleanedResponse = cleanedResponse.replace(/\s*\[PROVENANCE_LIST_REQUEST:[^\]]+\]\s*/g, '').trim();
          }

          // Round C3 — chat-direction style override. Maria emits
          // [SET_STORY_STYLE:storyId:STYLE] when the user asks to change a
          // deliverable's style via chat. Persist via the PATCH endpoint and
          // dispatch an event so any open FCS view refreshes its metadata row.
          const styleMatch = cleanedResponse.match(/\[SET_STORY_STYLE:([^:\]]+):(TABLE_FOR_2|ENGINEERING_TABLE|PERSONALIZED|)\]/);
          if (styleMatch) {
            const storyId = styleMatch[1].trim();
            const newStyle = styleMatch[2];
            if (isValidStoryId(storyId)) {
              api.patch<{ style?: string; effective?: string }>(`/stories/${storyId}/style`, { style: newStyle })
                .then((r) => {
                  document.dispatchEvent(new CustomEvent('story-style-changed', { detail: { storyId, style: r?.style, effective: r?.effective } }));
                })
                .catch((e) => console.error('[set-story-style] save failed', e));
            } else {
              console.warn('[SET_STORY_STYLE] ignored placeholder storyId:', storyId);
            }
            cleanedResponse = cleanedResponse.replace(/\s*\[SET_STORY_STYLE:[^\]]+\]\s*/g, '').trim();
          }

          // Round B5 — pitch-deck export: scan for [CONFIRM_PPTX:storyId] which
          // Maria emits when the user agrees to the trust-gate preview. Trigger
          // the download via FiveChapterShell. Strip the marker from visible text.
          // Round B Bug #2 — reject the literal placeholder "storyId" so we don't
          // dispatch a download for a non-existent story.
          const pptxConfirmMatch = cleanedResponse.match(/\[CONFIRM_PPTX:([^\]]+)\]/);
          if (pptxConfirmMatch) {
            const storyId = pptxConfirmMatch[1].trim();
            if (isValidStoryId(storyId)) {
              document.dispatchEvent(new CustomEvent('pptx-export-confirmed', { detail: { storyId } }));
            } else {
              console.warn('[CONFIRM_PPTX] ignored placeholder storyId:', storyId);
            }
            cleanedResponse = cleanedResponse.replace(/\s*\[CONFIRM_PPTX:[^\]]+\]\s*/g, '').trim();
          }

          // Round B4 — pre-Chapter-4 peer prompt: scan for [SAVE_PEER_INFO:storyId:summary]
          // marker emitted by Maria once she has the user's peer answer (or skip).
          // POST to the backend to save peerInfo + peerAsked, then dispatch event
          // so FiveChapterShell resumes Chapter 4 generation. Strip the marker.
          const peerMatch = cleanedResponse.match(/\[SAVE_PEER_INFO:([^:\]]+):([^\]]*)\]/);
          if (peerMatch) {
            const storyId = peerMatch[1].trim();
            const peerSummary = peerMatch[2] || '';
            // Reject placeholder storyIds — the literal "storyId" or the
            // example sentinel — same as for CONFIRM_PPTX and SET_STORY_STYLE.
            if (isValidStoryId(storyId)) {
              api.post(`/ai/stories/${storyId}/peer-info`, { peerInfo: peerSummary })
                .catch((e) => console.error('[peer-info] save failed', e))
                .finally(() => {
                  document.dispatchEvent(new CustomEvent('chapter4-peer-info-saved', { detail: { storyId, peerInfo: peerSummary } }));
                });
              peerPromptContextRef.current = null;
            } else {
              console.warn('[SAVE_PEER_INFO] ignored placeholder storyId:', storyId);
            }
            cleanedResponse = cleanedResponse.replace(/\s*\[SAVE_PEER_INFO:[^\]]+\]\s*/g, '').trim();
          } else if (peerPromptContextRef.current) {
            // Round B Bug #1 fallback — Maria wrote a "writing Chapter 4 (now|with) ..."
            // confirmation but forgot the marker. Use the captured user answer to save
            // peer info directly so the chapter pipeline isn't stuck. Pattern is
            // intentionally broad: any reply that signals Chapter 4 is going forward
            // counts, even without the literal "writing chapter 4" phrase.
            const writingCh4 = /\b(writing|drafting|generat\w+|building|start\w*|moving on to|on to)\s+(chapter\s+4|ch\.?\s*4|the\s+(?:fourth|social\s+proof|peer)\s+chapter)\b/i;
            const generalGoForward = /\b(got it|with that|let me|i'?ll|great|perfect|thanks)\b/i;
            const looksLikeCh4Confirm = writingCh4.test(cleanedResponse)
              || (generalGoForward.test(cleanedResponse) && cleanedResponse.length < 400);
            if (looksLikeCh4Confirm) {
              const ctx = peerPromptContextRef.current;
              peerPromptContextRef.current = null;
              api.post(`/ai/stories/${ctx.storyId}/peer-info`, { peerInfo: ctx.userAnswer })
                .catch((e) => console.error('[peer-info fallback] save failed', e))
                .finally(() => {
                  document.dispatchEvent(new CustomEvent('chapter4-peer-info-saved', { detail: { storyId: ctx.storyId, peerInfo: ctx.userAnswer } }));
                });
            }
          }
        }
        setMessages(prev => [...prev, { role: 'assistant', content: cleanedResponse || result.response, actionResult: result.actionResult }]);
      }

      if (result.actionResult) {
        const navMatch = result.actionResult.match(/\[NAVIGATE:([^\]]+)\]/);
        if (navMatch) setTimeout(() => navigate(navMatch[1]), 1200);

        // Auto-poll pipeline when Maria fires build_deliverable. The user
        // should NEVER have to ask "is it ready?" — the partner chat polls
        // automatically and navigates when the draft is complete.
        const buildMatch = result.actionResult.match(/\[BUILD_STARTED:([^:]+):([^\]]+)\]/);
        if (buildMatch) {
          const jobId = buildMatch[1];
          // Show a progress message that updates with fun status lines
          const progressPhrases = [
            "Reading between the lines...",
            "Mapping what matters to your audience...",
            "Writing chapter 1 — setting the scene...",
            "Building the case...",
            "Finding the right words...",
            "Almost there — polishing the draft...",
          ];
          let phraseIdx = 0;
          const progressMsgId = `build-${jobId}`;
          setMessages(prev => [...prev, {
            role: 'assistant',
            content: progressPhrases[0],
            id: progressMsgId,
          } as any]);
          const phraseInterval = setInterval(() => {
            phraseIdx = Math.min(phraseIdx + 1, progressPhrases.length - 1);
            setMessages(prev => prev.map(m =>
              (m as any).id === progressMsgId
                ? { ...m, content: progressPhrases[phraseIdx] }
                : m
            ));
          }, 12000);
          const pollInterval = setInterval(async () => {
            try {
              const status = await api.get<{
                status: string;
                draftId: string | null;
                resultStoryId: string | null;
              }>(`/express/status/${jobId}`);
              if (status.status === 'complete' && status.resultStoryId && status.draftId) {
                clearInterval(pollInterval);
                clearInterval(phraseInterval);
                setMessages(prev => prev.filter(m => (m as any).id !== progressMsgId));
                navigate(`/five-chapter/${status.draftId}?story=${status.resultStoryId}`);
              } else if (status.status === 'error') {
                clearInterval(pollInterval);
                clearInterval(phraseInterval);
                setMessages(prev => [...prev, {
                  role: 'assistant',
                  content: "Something went wrong building the draft. Tell me to try again if you'd like.",
                }]);
              }
            } catch {
              // Transient error — keep polling
            }
          }, 5000);
          // Safety: stop polling after 10 minutes
          setTimeout(() => { clearInterval(pollInterval); clearInterval(phraseInterval); }, 600000);
        }
      }

      if (result.refreshNeeded) refreshPage();
    } catch (err) {
      console.error('[Maria send error]', err);
      setMessages(prev => [...prev, { role: 'assistant', content: 'Sorry, I had trouble with that. Try again?' }]);
    } finally {
      if (followUpRef.current) {
        followUpRef.current = false; // Let the recursive call own the dots
      } else {
        setSending(false);
      }
    }
  }, [input, sending, pageContext, refreshPage, pendingFiles]);

  // Auto-send pending message after panel opens
  useEffect(() => {
    if (open && loaded && pendingMessageRef.current && !sending) {
      const msg = pendingMessageRef.current;
      pendingMessageRef.current = null;
      setTimeout(() => send(msg), 300);
    }
  }, [open, loaded, sending, send]);

  // After ~5s of bouncing dots, show "Maria is thinking..." so the user
  // knows it's working, not stalled.
  useEffect(() => {
    if (!sending) { setThinkingSlow(false); return; }
    const t = setTimeout(() => setThinkingSlow(true), 5000);
    return () => clearTimeout(t);
  }, [sending]);

  // ─── Context message for Phase 3 ───────────────���───

  function getContextMessage(): string {
    if (returnContext) {
      const { offeringName, audienceName, currentStep } = returnContext;
      const when = describeWhen(returnContext.lastActivityAt);
      const whenPhrase = when ? `${when.charAt(0).toUpperCase() + when.slice(1)}, ` : '';
      if (currentStep < 5) {
        return `${whenPhrase}you were building a message for ${offeringName} for ${audienceName}. Want to pick that up or start something else?`;
      }
      if (returnContext.unblendedMedium) {
        return `${whenPhrase}you were working on a ${returnContext.unblendedMedium} for ${offeringName} → ${audienceName}. The chapters are written but not blended yet. Want to finish that or start something else?`;
      }
      if (!returnContext.hasStories) {
        return `Your Three Tier for ${offeringName} → ${audienceName} is done${when ? ` as of ${when}` : ''}. Want to turn it into something or start something new?`;
      }
      return `Your ${offeringName} work is in good shape${when ? ` — last touched ${when}` : ''}. Want to revisit it or start something new?`;
    }
    return `What are you working on? Tell me what you need to communicate and who needs to hear it.`;
  }

  // ─── Render intro ──────────────────────────────────

  function renderIntro() {
    // Step 0: Name capture
    if (introStep === 0) {
      return (
        <div className="partner-intro">
          <div className="partner-intro-message">
            <p>Hi — I'm Maria.{suggestedName ? ` Can I call you ${suggestedName}?` : ' What should I call you?'}</p>
          </div>
          <div className="partner-intro-actions">
            {!showCustomInput && suggestedName ? (
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

    // Steps 1-2 combined: brief pitch + go
    if (introStep === 1 || introStep === 2) {
      const firstName = suggestedName ? suggestedName.split(/\s+/)[0] : '';
      return (
        <div className="partner-intro">
          <div className="partner-intro-message">
            <p>{firstName ? `Nice to meet you, ${firstName}. ` : ''}I help people build more persuasive messages and then apply them to almost any medium. Tell me about your work and I'll take it from there.</p>
          </div>
          <div className="partner-intro-actions">
            <button className="btn btn-primary" onClick={() => advanceIntro(INTRO_DONE)}>Let's go</button>
            <button className="btn btn-ghost" onClick={dismissIntro}>Not now</button>
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
    let cleaned = stripped.replace(/\n\n\[.+\]$/, '');
    // Inline synthetic-marker filter: remove any embedded routing tokens
    // (e.g. [PPTX_PREVIEW:storyId], [FOUNDATION], [INSTRUCTION: ...]) so a
    // marker that lives mid-message — escaping the whole-message filter — never
    // shows up in the user-visible chat. Applied to every rendered message.
    cleaned = stripSyntheticMarkers(cleaned);
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
          className={`partner-bubble ${(showGlow || showDot) ? 'partner-glow' : ''}`}
          onClick={handleOpen}
          aria-label="Work with Maria"
          title={showGlow || showDot ? 'Maria has something for you' : 'Work with Maria'}
        >
          {(showGlow || showDot) ? (
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 11V6a1 1 0 0 0-2 0v5" />
              <path d="M16 11V4a1 1 0 0 0-2 0v7" />
              <path d="M14 11V5a1 1 0 0 0-2 0v6" />
              <path d="M12 11V7a1 1 0 0 0-2 0v9a5 5 0 0 0 10 0v-4a1 1 0 0 0-2 0" />
            </svg>
          ) : (
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
            </svg>
          )}
        </button>
      )}

      {/* Chat panel */}
      {open && (
        <div
          className={`partner-panel partner-panel-${panelSize}`}
          ref={panelRef}
          onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
          onDrop={e => {
            e.preventDefault();
            e.stopPropagation();
            const files = Array.from(e.dataTransfer.files);
            files.forEach(file => {
              const reader = new FileReader();
              reader.onload = () => {
                const base64 = (reader.result as string).split(',')[1];
                setPendingFiles(prev => [...prev, { data: base64, mimeType: file.type || 'application/octet-stream', filename: file.name }]);
                setTimeout(() => textareaRef.current?.focus(), 100);
              };
              reader.readAsDataURL(file);
            });
          }}
        >
          <div className="partner-header">
            <span className="partner-header-name">Maria</span>
            <div className="partner-header-actions">
              <div className="partner-size-toggle" role="group" aria-label="Panel size">
                <button
                  className={`partner-size-btn ${panelSize === 'compact' ? 'active' : ''}`}
                  onClick={() => changePanelSize('compact')}
                  aria-label="Compact"
                  title="Compact"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="4" y="14" width="16" height="6" rx="1" />
                  </svg>
                </button>
                <button
                  className={`partner-size-btn ${panelSize === 'medium' ? 'active' : ''}`}
                  onClick={() => changePanelSize('medium')}
                  aria-label="Medium"
                  title="Medium"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="4" y="9" width="16" height="11" rx="1" />
                  </svg>
                </button>
                <button
                  className={`partner-size-btn ${panelSize === 'full' ? 'active' : ''}`}
                  onClick={() => changePanelSize('full')}
                  aria-label="Full"
                  title="Full"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="4" y="4" width="16" height="16" rx="1" />
                  </svg>
                </button>
              </div>
              <button className="partner-close" onClick={handleClose} aria-label="Minimize" title="Minimize — Maria stays in the bubble">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
            </div>
          </div>

          <div className="partner-body">
            {!statusLoaded && (
              <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-tertiary)' }}>
                <span>Loading...</span>
              </div>
            )}
            {showIntro && renderIntro()}

            {/* Guided flow branch — when an active guided session exists and user hasn't
                explicitly chosen assistant view, render the full guided experience inside the panel.
                The user can always tap "Chat with Maria instead" to hop back without losing progress. */}
            {statusLoaded && !showIntro && showGuidedInPanel && (
              <GuidedFlow
                mode="panel"
                onSwitchToAssistant={() => setPreferAssistant(true)}
              />
            )}

            {statusLoaded && !showIntro && !showGuidedInPanel && (
              <>
                <div className="partner-messages">
                  {/* Guided entry card — shows one of two states:
                      - Active session in background (user chose assistant view temporarily):
                        "Return to your guided message" — clears preferAssistant and flips back
                      - No active session: "Start a guided message" — creates new session */}
                  {loaded && (hasActiveGuidedSession ? (
                    <div className="partner-guided-card partner-guided-card-return">
                      <div className="partner-guided-card-text">
                        Your guided message is still in progress.
                      </div>
                      <div className="partner-guided-card-actions">
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => setPreferAssistant(false)}
                        >
                          Pick it back up
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="partner-guided-card partner-guided-card-start">
                      <div className="partner-guided-card-text">
                        Want me to walk you through building a message? I'll ask a few questions and draft the first version for you.
                      </div>
                      <div className="partner-guided-card-actions">
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={async () => {
                            setEnteringGuided(true);
                            setPreferAssistant(false);
                            await startNewSession();
                          }}
                        >
                          Start a guided message
                        </button>
                      </div>
                    </div>
                  ))}

                  {/* Resume draft card — highest priority: user walked away from an in-progress guided session */}
                  {resumeDraft && (
                    <div className="partner-return-card" style={{
                      padding: '12px 16px',
                      marginBottom: 8,
                      background: 'var(--bg-secondary, #f8f8fa)',
                      borderRadius: 'var(--radius-sm, 6px)',
                      border: '1px solid var(--border-light, #e5e5ea)',
                    }}>
                      <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 8px', lineHeight: 1.5 }}>
                        {resumeDraft.summary}
                      </p>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="btn btn-primary btn-sm" onClick={() => {
                          setResumeDraft(null);
                          navigate('/express');
                        }}>Resume</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => setResumeDraft(null)}>Not now</button>
                      </div>
                    </div>
                  )}

                  {/* Return context card */}
                  {showReturnCard && returnContext && !resumeDraft && (
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
                  {showProactiveCard && proactiveOffer && !showReturnCard && !resumeDraft && (
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

                  {/* Round B6 — time-aware session pacing chips. Render once at session
                      start (when chat is opened with no messages and no budget yet).
                      User picks 15/30/45/Skip; budget saves to localStorage and the
                      backend reads it on each subsequent message. */}
                  {showBudgetCard && messages.length === 0 && loaded && !showReturnCard && !showProactiveCard && !introduced && (
                    <div className="partner-return-card" style={{
                      padding: '12px 16px',
                      marginBottom: 8,
                      background: 'var(--bg-secondary, #f8f8fa)',
                      borderRadius: 'var(--radius-sm, 6px)',
                      border: '1px solid var(--border-light, #e5e5ea)',
                    }}>
                      <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 8px', lineHeight: 1.5 }}>
                        What's your time budget for this session? I'll pace accordingly.
                      </p>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {[15, 30, 45].map((mins) => (
                          <button
                            key={mins}
                            className="btn btn-ghost btn-sm"
                            style={{ minHeight: 32, padding: '4px 12px' }}
                            onClick={() => {
                              const tc: TimeContext = { sessionStartMs: Date.now(), budgetMin: mins, thresholdTriggered: false };
                              setTimeContext(tc);
                              saveTimeContext(tc);
                              markTimeBudgetAsked();
                              setShowBudgetCard(false);
                            }}
                          >{mins} min</button>
                        ))}
                        <button
                          className="btn btn-ghost btn-sm"
                          style={{ minHeight: 32, padding: '4px 12px' }}
                          onClick={() => {
                            const m = window.prompt('How many minutes?');
                            const n = m ? parseInt(m, 10) : NaN;
                            if (!isNaN(n) && n > 0 && n <= 240) {
                              const tc: TimeContext = { sessionStartMs: Date.now(), budgetMin: n, thresholdTriggered: false };
                              setTimeContext(tc);
                              saveTimeContext(tc);
                              markTimeBudgetAsked();
                              setShowBudgetCard(false);
                            }
                          }}
                        >Other</button>
                        <button
                          className="btn btn-ghost btn-sm"
                          style={{ minHeight: 32, padding: '4px 12px' }}
                          onClick={() => {
                            markTimeBudgetAsked();
                            setShowBudgetCard(false);
                          }}
                        >Skip</button>
                      </div>
                    </div>
                  )}

                  {messages.length === 0 && loaded && !showReturnCard && !showProactiveCard && !introduced && !showBudgetCard && (
                    <div className="partner-empty">
                      Tell me about your work — or if you have notes, a discovery doc, or an old draft, drop them here and I'll work from those.
                    </div>
                  )}
                  {messages.map((msg, i) => {
                    // Suppress synthetic-marker bubbles from the user's view.
                    // The marker still lives in the conversation history Maria
                    // reads — only the visible bubble is hidden. Apply to both
                    // roles in case Maria ever echoes a marker before her reply.
                    if (isSyntheticMarker(msg.content)) {
                      return null;
                    }
                    return (
                    <div key={i} className={`partner-msg partner-msg-${msg.role}`}>
                      {formatContent(msg.content)}
                      {msg.actionResult && (() => {
                        // Strip NAVIGATE/BUILD_STARTED first (they have known shapes), then run the
                        // generic synthetic-marker stripper to catch any other inline routing token.
                        const cleaned = stripSyntheticMarkers(
                          msg.actionResult.replace(/\[NAVIGATE:[^\]]+\]\s*/g, '').replace(/\[BUILD_STARTED:[^\]]+\]\s*/g, '')
                        ).trim();
                        if (!cleaned) return null;
                        // Simplify internal action results for naive users
                        const simple = cleaned
                          .replace(/Created offering "[^"]*" with \d+ capabilities?/g, 'Set up your product')
                          .replace(/Created audience "[^"]*" with \d+ priorities?/g, 'Set up the message target')
                          .replace(/Updated \d+ priorities in "[^"]*"/g, '')
                          .replace(/Drafted motivating factors for \d+ differentiators on "[^"]*"\. Each one names multiple audience types so the same offering can speak to different audiences\.?/g, '')
                          .replace(/Drafted motivating factors[^·]*/g, '')
                          .replace(/Building your first draft now\. This takes a few minutes\.?/g, '')
                          .replace(/\s*·\s*·\s*/g, ' · ')
                          .replace(/^\s*·\s*|\s*·\s*$/g, '')
                          .trim();
                        return simple ? <span className="partner-action-badge">{simple}</span> : null;
                      })()}
                    </div>
                    );
                  })}
                  {sending && (
                    <div className="partner-msg partner-msg-assistant partner-typing">
                      <span /><span /><span />
                      {thinkingSlow && (
                        <span className="partner-typing-label">Maria is thinking…</span>
                      )}
                    </div>
                  )}

                  {/* Toggle-can't-lie promotion card. Appears after Maria's reply when the
                      user's message contradicted the visible "Let Maria lead" toggle. Maria
                      already complied on this turn; this card asks once whether to move the
                      toggle too. After 3 dismissals in a row, the ask softens. */}
                  {leadPromotion && !sending && (
                    <div className="partner-lead-promotion">
                      <div className="partner-lead-promotion-text">
                        {leadPromotion.softened
                          ? (leadPromotion.direction === 'more'
                              ? "You've told me to just decide three times now — want me to just decide by default from here on?"
                              : "You've asked me to check with you three times now — want me to check first by default from here on?")
                          : (leadPromotion.direction === 'more'
                              ? "Want me to just decide by default from here on?"
                              : "Want me to check with you first by default from here on?")}
                      </div>
                      <div className="partner-lead-promotion-actions">
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => {
                            const next = leadPromotion.direction === 'more' ? 'on' : 'off';
                            setToggleState(next);
                            resetOverrideCount(leadPromotion.direction);
                            setMessages(prev => [...prev, {
                              role: 'assistant',
                              content: leadPromotion.direction === 'more'
                                ? "Done — I'll just decide by default. You can flip it back anytime from the home screen."
                                : "Done — I'll check with you first by default. You can flip it back anytime from the home screen.",
                            }]);
                            setLeadPromotion(null);
                          }}
                        >
                          {leadPromotion.direction === 'more' ? 'Yes, make it the default' : 'Yes, check with me'}
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => {
                            bumpOverrideCount(leadPromotion.direction);
                            setLeadPromotion(null);
                          }}
                        >
                          Just this time
                        </button>
                      </div>
                    </div>
                  )}

                  <div ref={messagesEndRef} />
                </div>

                {pendingFiles.length > 0 && (
                  <div style={{ padding: '6px 12px', borderTop: '1px solid var(--border-light, #e5e5ea)', maxHeight: 80, overflowY: 'auto', flexShrink: 0 }}>
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 2 }}>{pendingFiles.length} file{pendingFiles.length > 1 ? 's' : ''} attached</div>
                    {pendingFiles.map((f, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 0', fontSize: 12, color: 'var(--text-secondary)' }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, marginRight: 8 }}>{f.filename}</span>
                        <button type="button" onClick={() => setPendingFiles(prev => prev.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', fontSize: 14, lineHeight: 1, padding: '0 4px', flexShrink: 0 }} aria-label="Remove">×</button>
                      </div>
                    ))}
                  </div>
                )}
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
                    onPaste={e => {
                      const items = e.clipboardData?.items;
                      if (!items) return;
                      // If clipboard has text, let the browser handle it normally (paste as text).
                      // Only intercept if there are ONLY file items (actual file drops, not rich text copies).
                      const hasText = Array.from(items).some(item => item.kind === 'string' && (item.type === 'text/plain' || item.type === 'text/html'));
                      if (hasText) return; // Let browser paste the text naturally
                      const fileItems = Array.from(items).filter(item => item.kind === 'file');
                      if (fileItems.length > 0) {
                        e.preventDefault();
                        fileItems.forEach(item => {
                          const file = item.getAsFile();
                          if (!file) return;
                          const reader = new FileReader();
                          reader.onload = () => {
                            const base64 = (reader.result as string).split(',')[1];
                            setPendingFiles(prev => [...prev, { data: base64, mimeType: file.type || 'application/octet-stream', filename: file.name || 'pasted-file' }]);
                          };
                          reader.readAsDataURL(file);
                        });
                      }
                    }}
                    placeholder="Work with Maria..."
                    disabled={sending}
                    rows={1}
                    style={{ minHeight: 44, flexShrink: 0 }}
                  />
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="image/*,.pdf,.txt,.csv,.json,.md,.doc,.docx,.pptx"
                    style={{ display: 'none' }}
                    onChange={e => {
                      const files = Array.from(e.target.files || []);
                      files.forEach(file => {
                        const reader = new FileReader();
                        reader.onload = () => {
                          const base64 = (reader.result as string).split(',')[1];
                          setPendingFiles(prev => [...prev, { data: base64, mimeType: file.type || 'application/octet-stream', filename: file.name }]);
                        };
                        reader.readAsDataURL(file);
                      });
                      e.target.value = '';
                    }}
                  />
                  <button
                    className="partner-attach"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={sending}
                    aria-label="Attach file"
                    title="Drop a doc — Maria reads PDFs, Word, plain text, screenshots."
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
                    </svg>
                  </button>
                  <button className="partner-send" onClick={() => send()} disabled={(!input.trim() && pendingFiles.length === 0) || sending} aria-label="Send">
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
