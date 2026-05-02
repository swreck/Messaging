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
  getToggleState,
  setToggleState,
  bumpOverrideCount,
  resetOverrideCount,
  getOverrideCount,
  LEAD_TOGGLE_EVENT,
  type LeadDirection,
} from './leadershipDetection';
import { VoiceInputButton } from './VoiceInputButton';
import {
  bumpWhatsNextAndShouldOffer,
  resetWhatsNextCount,
  markModeSwitchOfferDeclined,
} from './whatsNextDetector';
import {
  MODE_SWITCH_OFFER_PATH_A_TO_B,
  MODE_SWITCH_OFFER_CHIP_YES,
  MODE_SWITCH_OFFER_CHIP_NO,
  TOGGLE_CONFIRMATION_ON,
  TOGGLE_CONFIRMATION_OFF,
  SKIP_DEMAND_CHIP_AUTONOMOUS,
  AUTONOMOUS_POST_DELIVERY_CHIP_YES,
  isAutonomousPostDeliveryChipNo,
  SUGGESTED_CHIPS_FRAME,
} from './milestoneCopy';
// MOBILE_HOME_BREAKPOINT_PX import dropped in Round 4 Fix 10 (toggle
// renders at all widths). Re-add if future visual treatments need it.

interface Message {
  role: 'user' | 'assistant';
  content: string;
  actionResult?: string | null;
  // Chat-open opener — when Maria speaks first on panel-mount with the
  // "Let Maria lead" toggle on, she emits 2-4 reply chips. Tapping a chip
  // posts the chip text as a normal user message.
  chips?: string[];
  // Round 3.4 Bug 14 — suggested-answer chips. Distinct from `chips`
  // (navigation): clicking a suggestChip inserts its text into the input
  // as editable text rather than auto-submitting. Rendered above
  // navigation chips with the SUGGESTED_CHIPS_FRAME framing line above
  // the group.
  suggestChips?: string[];
  isChatOpen?: boolean;
  // Round 3.1 Item 2 — surfaced from the persisted assistantMessage
  // context for autonomous-post-delivery offer messages so the YES chip
  // can navigate to the right Three Tier without a server round-trip.
  kind?: string;
  autonomousDraftId?: string;
  autonomousStoryId?: string;
  autonomousDeliverableType?: string;
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
//
// EXCEPTION: [INSERT: …] markers are USER-FACING placeholders Maria emits
// when a piece of input is missing from a deliverable. They must survive
// every render and strip pass — Cowork April 2026 credibility-regression
// fix. Both the whole-message filter and the global stripper exclude
// INSERT-prefixed markers via lookahead.
const SYNTHETIC_MARKER_RE = /^\s*\[(?!INSERT:)[A-Z_]+(?:\s*:[^\]]*)?\]\s*$/;
const SYNTHETIC_MARKER_GLOBAL_RE = /\[(?!INSERT:)[A-Z][A-Z_]*(?:\s*:[^\]]*)?\]/g;
function isSyntheticMarker(content: string): boolean {
  return SYNTHETIC_MARKER_RE.test(content);
}
function stripSyntheticMarkers(content: string): string {
  if (!content) return content;
  // Replace each inline marker with an empty string, then collapse the
  // resulting double-spaces / leading-trailing whitespace so the remaining
  // text reads cleanly. We do NOT touch markdown-style links like [text](url)
  // because the regex requires ALL-CAPS inside the brackets. We do NOT
  // touch [INSERT: …] markers — those are user-facing placeholders that
  // must render as-is so the user can see what to fill before sending.
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
// Round 4 Fix 12 — markTimeBudgetAsked removed alongside the budget step.

type PanelSize = 'compact' | 'medium' | 'full';

// B-7 — chat scope filter helpers. Picks the primary entity ID from the
// current pageContext. Default-on; users toggle to "Everything" via the
// scope chip at the top of the chat panel. Filtering is purely
// user-visible — the backend system-prompt history is unfiltered so
// Maria's continuity reasoning still sees full context.
type ScopeKind = 'storyId' | 'draftId' | 'audienceId' | 'offeringId' | null;
function getScope(ctx: { storyId?: string; draftId?: string; audienceId?: string; offeringId?: string; mediumLabel?: string } | null | undefined): { kind: ScopeKind; id?: string; label: string; typeLabel: string } {
  if (!ctx) return { kind: null, label: '', typeLabel: '' };
  if (ctx.storyId) {
    const label = ctx.mediumLabel || 'Five Chapter Story';
    return { kind: 'storyId', id: ctx.storyId, label, typeLabel: label };
  }
  if (ctx.draftId) return { kind: 'draftId', id: ctx.draftId, label: 'Three Tier', typeLabel: 'Three Tier' };
  if (ctx.audienceId) return { kind: 'audienceId', id: ctx.audienceId, label: 'audience', typeLabel: 'audience' };
  if (ctx.offeringId) return { kind: 'offeringId', id: ctx.offeringId, label: 'offering', typeLabel: 'offering' };
  return { kind: null, label: '', typeLabel: '' };
}
function scopePrefKey(userId: string | undefined, scope: { kind: ScopeKind; id?: string }): string | null {
  if (!userId || !scope.kind || !scope.id) return null;
  return `chat-scope-${userId}-${scope.kind}-${scope.id}`;
}
function loadScopePref(userId: string | undefined, scope: { kind: ScopeKind; id?: string }): 'scoped' | 'everything' {
  const key = scopePrefKey(userId, scope);
  if (!key) return 'scoped';
  try {
    const v = localStorage.getItem(key);
    return v === 'everything' ? 'everything' : 'scoped';
  } catch { return 'scoped'; }
}
function saveScopePref(userId: string | undefined, scope: { kind: ScopeKind; id?: string }, mode: 'scoped' | 'everything') {
  const key = scopePrefKey(userId, scope);
  if (!key) return;
  try { localStorage.setItem(key, mode); } catch {}
}

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
  // Round 3.1 Item 1 — showCustomInput state removed alongside the
  // chip-or-input branch in renderIntro. The input is the only path now.
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

  // B-7 — chat scope filter. Default-on; persisted per surface so the
  // user's choice (scoped vs. everything) sticks across the session for
  // that surface. Refetches the visible history when scope or surface
  // changes; the backend system prompt always sees full history.
  const currentScope = getScope(pageContext);
  const [scopeMode, setScopeMode] = useState<'scoped' | 'everything'>(() => loadScopePref(user?.userId, currentScope));

  // B-4 — first-encounter voice-button orientation. Renders an inline
  // hint above the input row when the user opens Maria for the first
  // time after voice was added. Persisted per-user so it never re-fires.
  const voiceTooltipKey = user ? `voice-tooltip-dismissed-${user.userId}` : '';
  const [showVoiceTooltip, setShowVoiceTooltip] = useState<boolean>(() => {
    if (!voiceTooltipKey) return false;
    try { return !localStorage.getItem(voiceTooltipKey); } catch { return false; }
  });
  function dismissVoiceTooltip() {
    if (voiceTooltipKey) {
      try { localStorage.setItem(voiceTooltipKey, '1'); } catch {}
    }
    setShowVoiceTooltip(false);
  }

  // Toggle-can't-lie: when a user's in-chat directive conflicts with the visible
  // "Let Maria lead" toggle, Maria does the requested thing immediately AND offers
  // to promote the change to the toggle. The card below the latest exchange
  // presents the offer. After three dismissals in the same direction, the ask
  // softens (a little self-aware note) rather than repeating verbatim.
  const [leadPromotion, setLeadPromotion] = useState<{
    direction: LeadDirection;
    softened: boolean;
  } | null>(null);

  // Phase 2 — mode-switch offer state. Non-null when the user has just typed
  // the third consecutive "what's next?" in Path A and Maria has rendered the
  // locked offer text + chips locally. The chips' handlers persist the user's
  // accept/decline back to the partner conversation history asynchronously.
  const [modeSwitchOfferActive, setModeSwitchOfferActive] = useState<boolean>(false);

  // Round 4 Fix 10 — small-screen breakpoint state was used to gate the
  // chat-panel-header toggle. With the toggle now rendered at every
  // breakpoint, isSmallScreen is no longer needed inside MariaPartner.
  // The MOBILE_HOME_BREAKPOINT_PX import survives for future per-pixel
  // adjustments if Cowork wants different visual treatments by width.

  // Phase 2 — Fix 4: in-panel toggle state, mirrored from localStorage so
  // the visible switch reflects the current consultation. Listens for
  // LEAD_TOGGLE_EVENT to stay in sync when toggle moves from any source.
  const [panelConsultation, setPanelConsultation] = useState<'on' | 'off'>(() => getToggleState());
  useEffect(() => {
    function syncFromEvent(e: Event) {
      const detail = (e as CustomEvent).detail as { value?: 'on' | 'off' } | undefined;
      if (detail?.value === 'on' || detail?.value === 'off') {
        setPanelConsultation(detail.value);
      }
    }
    document.addEventListener(LEAD_TOGGLE_EVENT, syncFromEvent);
    return () => document.removeEventListener(LEAD_TOGGLE_EVENT, syncFromEvent);
  }, []);

  // Phase 2 — Fix 4: in-panel toggle click handler. Same dual-write pattern
  // as DashboardPage.toggleConsultation: localStorage + PUT /partner/consultation
  // + POST /partner/log-message + dispatch LEAD_TOGGLE_EVENT.
  function toggleConsultationFromPanel() {
    const next: 'on' | 'off' = panelConsultation === 'on' ? 'off' : 'on';
    setPanelConsultation(next);
    setToggleState(next);  // writes localStorage + dispatches LEAD_TOGGLE_EVENT
    api.put('/partner/consultation', { value: next }).catch(() => {/* non-critical */});
    api.post('/partner/log-message', {
      role: 'assistant',
      content: next === 'on' ? TOGGLE_CONFIRMATION_ON : TOGGLE_CONFIRMATION_OFF,
      kind: 'toggle-confirmation',
      ctx: pageContext,
    }).catch(() => {/* non-critical */});
  }

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const followUpRef = useRef(false);
  // Round 3.4 Bug 2 — queue for messages typed during an in-flight send.
  // When `sending` flips false the drain useEffect below pulls the next
  // queued message and fires send() on it. The chat input is never
  // disabled so the user can always type and queue.
  const pendingQueueRef = useRef<string[]>([]);

  // Round 3.1 Item 4 — when the auth user changes (logout → signup, or a
  // workspace switch), reset every panel-side state slice that can carry
  // a previous user's content. Without this, a brand-new TEST_aria signup
  // briefly inherited admin's proactive-return-card "I know what VP
  // Marketing typically cares about…" because setProactiveOffer was only
  // called on truthy values and the prior session's value lingered.
  useEffect(() => {
    if (!user) {
      setMessages([]);
      setReturnContext(null);
      setProactiveOffer(null);
      setResumeDraft(null);
      setSuggestedName('');
      setIntroduced(null);
      setIntroStep(0);
      setLoaded(false);
    }
  }, [user?.userId]);

  // Load status on mount — only if logged in
  useEffect(() => {
    if (!user) return;
    api.get<{ username: string; displayName?: string; introduced: boolean; introStep?: number; returnContext?: ReturnContext | null; proactiveOffer?: string | null; resumeDraft?: { sessionId: string; summary: string; phase: string } | null; consultation?: 'on' | 'off' }>('/partner/status')
      .then(status => {
        setIntroduced(status.introduced);
        setIntroStep(status.introStep ?? 0);
        // Round 3.1 Item 1 — suggestedName tracks the user's preferred
        // name only. No fallback to username (fabricating "Test_aria_2026"
        // from a TEST_* username produced the bug Cowork flagged).
        const realDisplayName = (status.displayName || '').trim();
        setSuggestedName(
          realDisplayName ? realDisplayName.charAt(0).toUpperCase() + realDisplayName.slice(1) : ''
        );

        // Round 3.1 Item 4 — set unconditionally so a null response
        // overwrites any stale state from a prior session. The previous
        // truthy-only setters were the bug — they let stale proactive
        // cards survive a logout/signup cycle.
        setReturnContext(status.returnContext || null);
        setProactiveOffer(status.proactiveOffer || null);
        setResumeDraft(status.resumeDraft || null);

        // Path-architecture refactor — Phase 1. Reconcile the device-local
        // toggle (localStorage) with the persisted source of truth on
        // User.settings. Server wins. This handles the case where the user
        // toggled on another device and is now opening this one — the
        // localStorage value is stale; the server is current. We do NOT
        // dispatch the LEAD_TOGGLE_EVENT here because no user action just
        // happened; we just quietly bring localStorage into agreement.
        if (status.consultation === 'on' || status.consultation === 'off') {
          try {
            const localValue = localStorage.getItem('maria-consultation');
            const serverValue = status.consultation;
            if (localValue !== serverValue) {
              localStorage.setItem('maria-consultation', serverValue);
            }
          } catch {}
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

  // B-7 — when surface changes (different draftId / storyId / etc.),
  // re-load the user's persisted scope preference for the new surface
  // and reset `loaded` so the history-load effect refetches with the
  // right scope. Without this, navigating from Three Tier A to Three
  // Tier B would keep showing A's filtered history under B's chip.
  useEffect(() => {
    setScopeMode(loadScopePref(user?.userId, currentScope));
    setLoaded(false);
  }, [user?.userId, currentScope.kind, currentScope.id]);

  // Load conversation history when panel first opens and intro is done.
  // B-7 — fetches with scope params when scope is active and mode is
  // 'scoped'; otherwise fetches full history. Refetches when scopeMode
  // toggles via the scope chip.
  useEffect(() => {
    if (open && !loaded && introduced) {
      const scopeParams: Record<string, string> = {};
      if (scopeMode === 'scoped' && currentScope.kind && currentScope.id) {
        if (currentScope.kind === 'storyId') scopeParams.scopeStoryId = currentScope.id;
        else if (currentScope.kind === 'draftId') scopeParams.scopeDraftId = currentScope.id;
        else if (currentScope.kind === 'audienceId') scopeParams.scopeAudienceId = currentScope.id;
        else if (currentScope.kind === 'offeringId') scopeParams.scopeOfferingId = currentScope.id;
      }
      const qs = new URLSearchParams(scopeParams).toString();
      const url = qs ? `/partner/history?${qs}` : '/partner/history';
      api.get<{ messages: (Message & { kind?: string; autonomousDraftId?: string; autonomousStoryId?: string; autonomousDeliverableType?: string })[] }>(url)
        .then(async ({ messages: rawHistory }) => {
          // Cowork follow-up #2 + #6 — backend now returns chips and kind on
          // assistant rows. Map kind:'chat-open-opener' to isChatOpen:true so
          // the cleanup sweep in the chat-open useEffect can identify them.
          const history: Message[] = rawHistory.map(m => ({
            role: m.role,
            content: m.content,
            actionResult: m.actionResult,
            chips: Array.isArray(m.chips) ? m.chips : undefined,
            isChatOpen: m.kind === 'chat-open-opener' || m.isChatOpen,
            kind: m.kind,
            autonomousDraftId: m.autonomousDraftId,
            autonomousStoryId: m.autonomousStoryId,
            autonomousDeliverableType: m.autonomousDeliverableType,
          }));
          // B-7 — when in scoped mode and the scoped history is empty,
          // skip the auto-greeting injection. The render layer shows the
          // empty-state UI ("No messages on this [type] yet — start a
          // conversation, or Show everything") instead. The greeting
          // injection only runs in the unscoped path so first-touch users
          // on the dashboard still get welcomed.
          //
          // Chat-open opener: when "Let Maria lead" is on, the opener
          // useEffect below handles greeting + reply chips in Maria's
          // voice via the partner pipeline. Skip the legacy injection in
          // that case so Maria doesn't speak twice.
          // Phase 2 — Redline #11: legacy greeting block removed. Chat-open
          // useEffect below now fires unconditionally and is the sole opener.
          // eslint-disable-next-line no-constant-condition
          if (false) {
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
  }, [open, loaded, introduced, introStep, scopeMode, currentScope.kind, currentScope.id]);

  // Chat-open proactive opener. The rule: when the panel opens with
  // "Let Maria lead" on, Maria's first message arrives within ~3s and
  // ends with reply chips. The user is never left wondering what to do.
  //
  // Cowork follow-up #5 — gate key is per-page-context, not per-user.
  // Each distinct surface (Dashboard vs deliverable vs different
  // deliverable) fires its own opener exactly once per session.
  // Navigation between pages within the same session refires correctly
  // because the key changes.
  //
  // Cowork follow-up #6 — when a new opener fires, the backend sweeps
  // prior chat-open-opener rows for this user. We also remove stale
  // chat-open-opener messages from the visible thread on the client
  // before appending the new one, so the panel never shows two competing
  // openers from different page-contexts.
  useEffect(() => {
    if (!open || !loaded || !introduced || !user) return;
    // Phase 2 — Redline #11: the chat-open opener now fires regardless of
    // toggle state. Empty workspaces hit the locked OPENER_FRESH_USER path
    // server-side; populated workspaces hit the existing state-aware
    // opener. Both paths are unconditional once the panel is open.
    //
    // Exception: when a synthetic message is already queued (e.g. the
    // dashboard toggle-ON flow queues [STATE_RECAP]), let that message
    // serve as the opener for this open event. The chat-open trigger
    // would double-greet otherwise.
    if (pendingMessageRef.current) return;
    const pageKind = pageContext?.page || 'dashboard';
    const deliverableId = pageContext?.draftId || pageContext?.storyId || 'none';
    const gateKey = `maria-opened-${user.userId}-${pageKind}-${deliverableId}`;
    try {
      if (sessionStorage.getItem(gateKey)) return;
      sessionStorage.setItem(gateKey, '1');
    } catch {}

    let cancelled = false;
    setSending(true);
    api.post<{
      response: string;
      chips?: string[];
      isChatOpen?: boolean;
    }>('/partner/message', {
      trigger: 'chat-open',
      context: pageContext,
    })
      .then(result => {
        if (cancelled) return;
        if (result.response) {
          setMessages(prev => {
            // Remove any prior chat-open openers from the visible thread
            // before appending the new one. Real conversational replies
            // are untouched.
            const cleaned = prev.filter(m => !m.isChatOpen);
            return [...cleaned, {
              role: 'assistant',
              content: result.response,
              chips: result.chips || [],
              isChatOpen: true,
            }];
          });
        }
      })
      .catch(err => {
        // Silent failure — the user's experience is "panel opened, no
        // opener fired." Logged for debugging; the next user message
        // proceeds normally. We do NOT clear the sessionStorage gate
        // here — a transient backend failure shouldn't trigger an
        // immediate retry that would feel chaotic to the user.
        console.warn('[Partner] chat-open opener failed:', err);
      })
      .finally(() => {
        if (!cancelled) setSending(false);
      });

    return () => { cancelled = true; };
  }, [open, loaded, introduced, user, pageContext?.page, pageContext?.draftId, pageContext?.storyId, pageContext?.offeringId, pageContext?.audienceId]);

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

  // Phase 2 — visible toggle-confirmation listener (Redline #9). Every time
  // the "Let Maria lead" toggle flips (from the dashboard, from the
  // mode-switch offer, from anywhere) the LEAD_TOGGLE_EVENT fires. Append
  // the locked confirmation text to the visible thread for instant feel.
  // Persistence is handled by the flip-trigger site (DashboardPage's
  // toggleConsultation handler, or the mode-switch offer chip handler) —
  // this listener is presentation only.
  useEffect(() => {
    function onLeadToggleChanged(e: Event) {
      const detail = (e as CustomEvent).detail as { value?: 'on' | 'off' } | undefined;
      const next = detail?.value;
      if (next !== 'on' && next !== 'off') return;
      const content = next === 'on' ? TOGGLE_CONFIRMATION_ON : TOGGLE_CONFIRMATION_OFF;
      setMessages(prev => [...prev, { role: 'assistant', content }]);
    }
    document.addEventListener(LEAD_TOGGLE_EVENT, onLeadToggleChanged);
    return () => document.removeEventListener(LEAD_TOGGLE_EVENT, onLeadToggleChanged);
  }, []);

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
        // Round 4 Fix 2 — `+ New message` and other fresh-start entry
        // points dispatch maria-toggle with freshStart=true so the panel
        // resets to empty before the chat-open opener fires. Without this,
        // the unscoped panel surfaces full prior history including stale
        // sessions, and the user lands on a "step indicator says ✓ basics"
        // experience for a build they don't recognize.
        if (detail.freshStart) {
          setMessages([]);
          setLoaded(true);
          setIntroduced(true);
          setShowProactiveCard(false);
          setShowReturnCard(false);
          setShowBudgetCard(false);
        }
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

  // Round 4 Fix 12 — dismissIntro removed alongside the budget step. The
  // only call site was the "Not now" button on the budget chips.

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
    // Round 3.1 follow-up regression fix — PUT /partner/name now
    // advances introStep=4, introduced=true server-side directly.
    // Mirror the advance into local state and trigger the history
    // reload so the chat-open opener fires immediately. The previous
    // advanceIntro(INTRO_DONE) call (and its parallel PUT
    // /partner/intro-step) was racing the /name PUT and being
    // clobbered, leaving fresh users stuck at introStep=1.
    setIntroStep(INTRO_DONE);
    setIntroduced(true);
    setLoaded(false);
  }

  // ─── Send message ───────────────────────────────────

  const send = useCallback(async (overrideText?: string, pageContent?: string) => {
    const text = overrideText || input.trim();
    if (!text && pendingFiles.length === 0) return;
    // Round 3.4 Bug 2 — chat input never disabled; queue mid-send messages.
    // If the user types and submits while a previous send is in flight,
    // push the text into a queue rather than dropping it. The drain
    // useEffect below picks up queued messages when sending flips false.
    if (sending) {
      // Only queue typed messages, not auto-fired overrideText (chip clicks
      // already have their own retry path).
      if (!overrideText && text) {
        pendingQueueRef.current.push(text);
        setInput('');
      }
      return;
    }

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

    // Phase 2 — Path A what's-next counter. Bump per user message. When the
    // toggle is OFF and the third consecutive "what's next?"-style intent
    // arrives, render the locked mode-switch offer locally for snappy feel
    // and persist it asynchronously. The offer's accept/decline chips fire
    // toggle promotion + persistence below in the render block.
    if (getToggleState() === 'off' && !overrideText) {
      const shouldOffer = bumpWhatsNextAndShouldOffer(user?.userId, text);
      if (shouldOffer) {
        // Render locally for instant feel — Redline #6. The offer text is a
        // normal assistant bubble; the two chips (Yes / No) are rendered by
        // the dedicated mode-switch-offer card below the thread, similar to
        // the existing toggle-can't-lie promotion card.
        setMessages(prev => [
          ...prev,
          { role: 'assistant', content: MODE_SWITCH_OFFER_PATH_A_TO_B },
        ]);
        setModeSwitchOfferActive(true);
        // Reset so the offer doesn't immediately re-fire if the user keeps asking.
        resetWhatsNextCount(user?.userId);
        // Persist asynchronously — survives reload + cross-device.
        api.post('/partner/log-message', {
          role: 'assistant',
          content: MODE_SWITCH_OFFER_PATH_A_TO_B,
          kind: 'mode-switch-offer',
          ctx: pageContext,
        }).catch(() => {/* non-critical */});
        return;
      }
    } else if (getToggleState() === 'on' && !overrideText) {
      // Toggle ON — counter is meaningless in Path B; keep it cleared.
      resetWhatsNextCount(user?.userId);
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
        chips?: string[];
        suggestChips?: string[];
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
        // Round E3 — flag persistent-intent voice input so Maria's prompt rule
        // surfaces the explicit summary-back. Cleared after one trip.
        ...(((): Record<string, unknown> => {
          try {
            const v = localStorage.getItem('voice-persistent-intent-pending');
            if (v) {
              localStorage.removeItem('voice-persistent-intent-pending');
              return { voicePersistentIntent: v };
            }
          } catch {}
          return {};
        })()),
        // B-2 — once-per-session flag so Maria's proactive website-research
        // offer only fires once. Date-stamped key resets each new day.
        ...(((): Record<string, unknown> => {
          try {
            const d = new Date();
            const key = `website-research-offered-${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
            return { websiteResearchOffered: !!localStorage.getItem(key) };
          } catch {}
          return {};
        })()),
        // Cowork follow-up #3 — once-per-session over-budget acknowledgement.
        // Suppresses repeat firing of the time-threshold alert after the user
        // has seen it once today.
        ...(((): Record<string, unknown> => {
          try {
            const d = new Date();
            const key = `over-budget-ack-${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
            return { overBudgetAcknowledged: !!localStorage.getItem(key) };
          } catch {}
          return {};
        })()),
        // Path-architecture refactor — Phase 1. Send the device-local toggle
        // state on every turn so the route layer can read it for that turn's
        // logic (Phase 3 will gate proactive milestone narration on this).
        // Body wins over persisted value; absent body falls back to persisted.
        consultation: getToggleState(),
      });
      // Round B6 — backend tells us when the threshold marker fired this turn so
      // we can persist thresholdTriggered=true and avoid re-firing on later messages.
      // Cowork follow-up #3 — also write a date-stamped over-budget acknowledgement
      // so the alert is suppressed for the rest of the day even across cleared
      // session storage or fresh tabs.
      if (result.timeThresholdFired && !timeContext.thresholdTriggered) {
        const updated: TimeContext = { ...timeContext, thresholdTriggered: true };
        setTimeContext(updated);
        saveTimeContext(updated);
        try {
          const d = new Date();
          const key = `over-budget-ack-${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
          localStorage.setItem(key, '1');
        } catch {}
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

          // Round E2 — Maria emits [SAVE_STYLE_RULE:audienceType:format:rule text]
          // when the user accepts a detected edit-pattern question. Persist via
          // /api/settings/style-rules POST and dispatch an event so the
          // SettingsPage refreshes if it's open.
          const ruleMatch = cleanedResponse.match(/\[SAVE_STYLE_RULE:([^:\]]*):([^:\]]*):([^\]]+)\]/);
          if (ruleMatch) {
            const scopeAudienceType = ruleMatch[1].trim();
            const scopeFormat = ruleMatch[2].trim();
            const ruleText = ruleMatch[3].trim();
            if (ruleText && ruleText !== 'rule text') {
              api.post('/settings/style-rules', { rule: ruleText, scopeAudienceType, scopeFormat })
                .then((r) => {
                  document.dispatchEvent(new CustomEvent('user-style-rule-added', { detail: r }));
                  // Bug #5 — clear the pending E2 entry server-side so the
                  // surfacing block stops re-firing on subsequent replies.
                  return api.post('/partner/clear-pending', { kind: 'editPattern' });
                })
                .catch((e) => console.error('[E2] style-rule save failed', e));
            }
            cleanedResponse = cleanedResponse.replace(/\s*\[SAVE_STYLE_RULE:[^\]]+\]\s*/g, '').trim();
          }
          // Round E4 — Maria emits [APPLY_FOUNDATIONAL_SHIFT:draftId:targetCell:newText]
          // when the user confirms her proposed Tier update. Persist via the
          // existing tier1/tier2/tier3 PUT endpoints.
          const shiftMatch = cleanedResponse.match(/\[APPLY_FOUNDATIONAL_SHIFT:([^:\]]+):([^:\]]+):([^\]]+)\]/);
          if (shiftMatch) {
            const draftId = shiftMatch[1].trim();
            const targetCell = shiftMatch[2].trim();
            const newText = shiftMatch[3].trim();
            if (draftId && draftId.length >= 5 && draftId !== 'draftId' && draftId !== 'cmEXAMPLE0000000000000000' && newText && targetCell) {
              const clearPending = () => api.post('/partner/clear-pending', { kind: 'foundationalShift' }).catch((e) => console.error('[E4] clear-pending failed', e));
              if (targetCell === 'tier1') {
                api.put(`/tiers/${draftId}/tier1`, { text: newText, changeSource: 'foundational_shift' })
                  .then(() => {
                    document.dispatchEvent(new CustomEvent('three-tier-updated', { detail: { draftId, targetCell } }));
                    return clearPending();
                  })
                  .catch((e) => console.error('[E4] tier1 apply failed', e));
              } else if (targetCell.startsWith('tier2-')) {
                // The targetCell shape is "tier2-N" referring to sortOrder index.
                // Resolve the actual tier2Statement id by reading the draft.
                const idx = parseInt(targetCell.split('-')[1], 10);
                api.get<{ draft: { tier2Statements: Array<{ id: string; sortOrder: number }> } }>(`/drafts/${draftId}`)
                  .then(({ draft }) => {
                    const t2 = (draft.tier2Statements || [])[idx];
                    if (!t2) throw new Error('tier2 cell not found');
                    return api.put(`/tiers/${draftId}/tier2/${t2.id}`, { text: newText, changeSource: 'foundational_shift' });
                  })
                  .then(() => {
                    document.dispatchEvent(new CustomEvent('three-tier-updated', { detail: { draftId, targetCell } }));
                    return clearPending();
                  })
                  .catch((e) => console.error('[E4] tier2 apply failed', e));
              }
            } else {
              console.warn('[APPLY_FOUNDATIONAL_SHIFT] ignored placeholder ids:', draftId, targetCell);
            }
            cleanedResponse = cleanedResponse.replace(/\s*\[APPLY_FOUNDATIONAL_SHIFT:[^\]]+\]\s*/g, '').trim();
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

          // Round s8 — chat-only B5 entry path. When Maria emits
          // [PPTX_PREVIEW_REQUEST:<storyId>] from a chat-only request ("export
          // this to slides"), route through the visual preview path so the
          // [PPTX_PREVIEW:realId] priming gets dispatched and the trust gate
          // fires the same way a button click does.
          const pptxRequestMatch = cleanedResponse.match(/\[PPTX_PREVIEW_REQUEST:([^\]]+)\]/);
          if (pptxRequestMatch) {
            const storyId = pptxRequestMatch[1].trim();
            if (isValidStoryId(storyId)) {
              api.post<{ slides: Array<{ title: string; bullets: string[]; chapterNum?: number }> }>(`/ai/stories/${storyId}/pptx-preview`, {})
                .then((result) => {
                  const titles = (result.slides || []).map((s, i) => `${i + 1}. ${s.title}`).join('\n');
                  const slideCount = result.slides?.length || 0;
                  const previewMsg = `I'll produce a ${slideCount}-slide first-draft skeleton to save you time. Titles below — scan and tell me to go ahead, or cancel.\n\n${titles}\n\nThe deck comes unstyled. Open it in PowerPoint or Keynote, then apply your template (Design → Themes) to style the whole deck in one click.`;
                  document.dispatchEvent(new CustomEvent('maria-toggle', {
                    detail: {
                      open: true,
                      message: `[PPTX_PREVIEW:${storyId}] ${previewMsg}\n\nReady to download? Reply "yes" or "go ahead" — I'll deliver the file.`,
                      hint: true,
                    },
                  }));
                })
                .catch((e) => console.error('[s8] chat-only pptx preview failed', e));
            } else {
              console.warn('[PPTX_PREVIEW_REQUEST] ignored placeholder storyId:', storyId);
            }
            cleanedResponse = cleanedResponse.replace(/\s*\[PPTX_PREVIEW_REQUEST:[^\]]+\]\s*/g, '').trim();
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

          // B-2 — proactive website-research offer marker. When Maria
          // includes [WEBSITE_RESEARCH_OFFERED] anywhere in her reply,
          // set the date-stamped session flag so the next message tells
          // her she's already offered this session and not to re-offer.
          // Marker is stripped from visible text before render.
          if (/\[WEBSITE_RESEARCH_OFFERED\]/.test(cleanedResponse)) {
            try {
              const d = new Date();
              const key = `website-research-offered-${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
              localStorage.setItem(key, '1');
            } catch {}
            cleanedResponse = cleanedResponse.replace(/\s*\[WEBSITE_RESEARCH_OFFERED\]\s*/g, '').trim();
          }
        }
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: cleanedResponse || result.response,
          actionResult: result.actionResult,
          chips: result.chips,
          suggestChips: result.suggestChips,
        }]);
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
          // Round 3 fix — drop the rotating cute-phrase placeholder. The
          // backend writes Maria-voice milestone narrations (Path B) and
          // stage-aware presence check-ins (>30s stages) into chat history
          // as they happen. The chat panel just needs to fast-poll
          // /partner/history during the build so those messages surface
          // within ~5s of being written, not in a burst at the end.
          const buildStartedAt = Date.now();
          const historyPoll = setInterval(async () => {
            try {
              const scopeParams: Record<string, string> = {};
              if (scopeMode === 'scoped' && currentScope.kind && currentScope.id) {
                if (currentScope.kind === 'storyId') scopeParams.scopeStoryId = currentScope.id;
                else if (currentScope.kind === 'draftId') scopeParams.scopeDraftId = currentScope.id;
                else if (currentScope.kind === 'audienceId') scopeParams.scopeAudienceId = currentScope.id;
                else if (currentScope.kind === 'offeringId') scopeParams.scopeOfferingId = currentScope.id;
              }
              const qs = new URLSearchParams(scopeParams).toString();
              const url = qs ? `/partner/history?${qs}` : '/partner/history';
              const fresh = await api.get<{ messages: (Message & { kind?: string; autonomousDraftId?: string; autonomousStoryId?: string; autonomousDeliverableType?: string })[] }>(url);
              const remapped: Message[] = fresh.messages.map(m => ({
                role: m.role,
                content: m.content,
                actionResult: m.actionResult,
                chips: Array.isArray(m.chips) ? m.chips : undefined,
                isChatOpen: m.kind === 'chat-open-opener' || m.isChatOpen,
                kind: m.kind,
                autonomousDraftId: m.autonomousDraftId,
                autonomousStoryId: m.autonomousStoryId,
                autonomousDeliverableType: m.autonomousDeliverableType,
              }));
              setMessages(remapped);
            } catch {
              // Transient error — keep polling
            }
          }, 5000);
          const pollInterval = setInterval(async () => {
            try {
              const status = await api.get<{
                status: string;
                draftId: string | null;
                resultStoryId: string | null;
              }>(`/express/status/${jobId}`);
              if (status.status === 'complete' && status.resultStoryId && status.draftId) {
                clearInterval(pollInterval);
                clearInterval(historyPoll);
                navigate(`/five-chapter/${status.draftId}?story=${status.resultStoryId}`);
              } else if (status.status === 'error') {
                clearInterval(pollInterval);
                clearInterval(historyPoll);
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
          setTimeout(() => {
            clearInterval(pollInterval);
            clearInterval(historyPoll);
          }, 600000);
          void buildStartedAt;
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

  // Round 3.4 Bug 2 — drain the pending message queue when sending finishes.
  // If the user typed and submitted while a previous send was in flight,
  // those messages were pushed to pendingQueueRef. Pull the oldest queued
  // message and fire send() on it. send() will set sending=true again,
  // suspending the drain until the next finish, so messages process FIFO
  // one-at-a-time without re-disabling the input.
  useEffect(() => {
    if (sending) return;
    if (pendingQueueRef.current.length === 0) return;
    const next = pendingQueueRef.current.shift();
    if (!next) return;
    setTimeout(() => send(next), 100);
  }, [sending, send]);

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
    // Round 3.1 Item 1 — name capture, refactored. Brand-new users no
    // longer see a "That's me" chip backed by a fabricated suggestedName
    // (the prior path produced "TEST" for every TEST_* synthetic account
    // and similar artifacts for any multi-word invitee name). The user
    // types their preferred name or taps the secondary chip to use their
    // username verbatim. Maria asks one question and waits.
    if (introStep === 0) {
      const usernameFallback = user?.username || '';
      return (
        <div className="partner-intro">
          <div className="partner-intro-message">
            <p>Hi — I'm Maria. What should I call you?</p>
          </div>
          <div className="partner-intro-actions">
            <div className="partner-name-input">
              <input
                type="text"
                value={customName}
                onChange={e => setCustomName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && customName.trim()) confirmName(customName.trim());
                }}
                placeholder="Type your preferred name"
                autoFocus
              />
              <button className="btn btn-primary btn-sm" onClick={() => customName.trim() && confirmName(customName.trim())} disabled={!customName.trim()}>
                That's it
              </button>
            </div>
            {usernameFallback && (
              <button
                className="btn btn-ghost btn-sm"
                style={{ marginTop: 8 }}
                onClick={() => confirmName(usernameFallback)}
              >
                Call me {usernameFallback}
              </button>
            )}
          </div>
        </div>
      );
    }

    // Round 4 Fix 12 — the time-budget intro step (introStep === 1 || 2)
    // is removed. Fresh users now go from name confirmation directly to
    // the chat-open opener. The downstream TIME_THRESHOLD logic in
    // routes/partner.ts is gated on timeContext.budgetMin being truthy,
    // which it never is once this step is gone — sensible no-op default
    // matches the CC prompt's "Let Maria lead replaces the lead-vs-
    // follow signal that the budget step used to provide."

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

          {/* Round 4 Fix 10 — toggle relocation. The "Let Maria lead"
              toggle lives in the chat-panel header at every breakpoint
              now (was small-screen-only in Round 2). It's a setting WITHIN
              the Maria relationship, so its home is Maria's panel. The
              dashboard's top-right toggle is removed in this round. */}
          {(
            <div
              className="partner-lead-toggle"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '10px 16px',
                borderBottom: '1px solid var(--border-light, #e5e5ea)',
                background: 'var(--bg-secondary, #f8f8fa)',
              }}
            >
              <span
                style={{
                  fontSize: 14,
                  fontWeight: 500,
                  color: panelConsultation === 'on' ? 'var(--text-primary, #1c1c1e)' : 'var(--text-secondary, #6e6e73)',
                }}
              >
                Let Maria lead
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={panelConsultation === 'on'}
                aria-label="Toggle Maria collaboration"
                title={panelConsultation === 'on' ? 'Maria guides each step. Take over whenever you want.' : 'You drive. Maria waits on the side.'}
                onClick={toggleConsultationFromPanel}
                style={{
                  width: 50,
                  height: 30,
                  borderRadius: 15,
                  border: 'none',
                  background: panelConsultation === 'on' ? 'var(--accent, #007aff)' : 'var(--border-light, #c7c7cc)',
                  position: 'relative',
                  cursor: 'pointer',
                  padding: 0,
                  flexShrink: 0,
                  transition: 'background 0.15s',
                }}
              >
                <span
                  style={{
                    position: 'absolute',
                    top: 3,
                    left: panelConsultation === 'on' ? 23 : 3,
                    width: 24,
                    height: 24,
                    borderRadius: '50%',
                    background: 'white',
                    transition: 'left 0.15s',
                    boxShadow: '0 1px 2px rgba(0,0,0,0.15)',
                  }}
                />
              </button>
            </div>
          )}

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
                  {/* B-7 — chat scope chip. Only renders when the current
                      surface has a primary entity (Three Tier draftId,
                      FCS storyId, audience, offering). On Dashboard /
                      Settings / etc. there's no scope to apply, so the
                      chip is hidden and the chat shows full history. */}
                  {currentScope.kind && (
                    <div className="partner-scope">
                      {scopeMode === 'scoped' ? (
                        <>
                          <span className="partner-scope-label">On this {currentScope.label}</span>
                          <button
                            className="partner-scope-link"
                            onClick={() => {
                              setScopeMode('everything');
                              saveScopePref(user?.userId, currentScope, 'everything');
                              setLoaded(false);
                            }}
                          >Show everything →</button>
                        </>
                      ) : (
                        <>
                          <span className="partner-scope-label">Everything</span>
                          <button
                            className="partner-scope-link"
                            onClick={() => {
                              setScopeMode('scoped');
                              saveScopePref(user?.userId, currentScope, 'scoped');
                              setLoaded(false);
                            }}
                          >Back to this {currentScope.typeLabel} →</button>
                        </>
                      )}
                    </div>
                  )}
                  {/* Bug D — single-prompt prioritization. Pre-resolve which
                      proactive prompt to show this turn, render at most one.
                      Order: resume-guided (active guided session waiting) →
                      resume-draft (express draft) → return-context (prior
                      Three Tier work) → proactive offer → budget chips →
                      start-guided (CTA fallback). Resume offers are merged
                      into a single prompt; the user dismisses one and the
                      next one in the queue surfaces on the next render
                      (e.g. budget chips fire after resume is dismissed). */}
                  {/* Round 3 fix — only render the cross-draft "Pick it back up"
                      banner when the chat panel is in dashboard-level (unscoped)
                      view. Inside a story / draft / audience / offering scope,
                      the banner pointed at a DIFFERENT draft would violate the
                      scope promise the panel just made. The banner remains useful
                      on the dashboard, where the user IS at the cross-draft level. */}
                  {loaded && hasActiveGuidedSession && !currentScope.kind && (
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
                  )}

                  {loaded && !hasActiveGuidedSession && !resumeDraft && !(showReturnCard && returnContext) && !(showProactiveCard && proactiveOffer) && !(showBudgetCard && !timeContext.budgetMin) && (
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
                  )}

                  {/* Resume draft card — second priority after active guided session. */}
                  {loaded && !hasActiveGuidedSession && resumeDraft && (
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

                  {/* Return context card — only when no in-progress guided/draft. */}
                  {loaded && !hasActiveGuidedSession && !resumeDraft && showReturnCard && returnContext && (
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

                  {/* Proactive offer card — fires only when no resume class is active. */}
                  {loaded && !hasActiveGuidedSession && !resumeDraft && !(showReturnCard && returnContext) && showProactiveCard && proactiveOffer && (
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

                  {/* Round 4 Fix 12 — day-to-day budget re-ask card removed.
                      The "Let Maria lead" toggle covers the lead-vs-follow
                      pacing distinction; specific time budgets aren't needed.
                      Downstream TIME_THRESHOLD logic in routes/partner.ts
                      stays in place but no-ops because no budget gets set. */}

                  {/* Bug E — when scope is scoped and the filtered message list
                      is empty, ALWAYS show the empty-state copy so the user
                      understands why the chat looks blank. Even when proactive
                      cards are present, the empty-state renders below them so
                      "I'm scoped to this email and there's nothing here yet"
                      is visible. The unscoped empty-state keeps its prior
                      gating (only shows when no proactive card occupies the
                      slot) since its copy is more conversational than
                      orienting. */}
                  {messages.length === 0 && loaded && scopeMode === 'scoped' && currentScope.kind && (
                    <div className="partner-empty">
                      No messages on this {currentScope.typeLabel} yet — start a conversation, or{' '}
                      <button
                        className="partner-empty-link"
                        onClick={() => {
                          setScopeMode('everything');
                          saveScopePref(user?.userId, currentScope, 'everything');
                          setLoaded(false);
                        }}
                      >show everything</button>.
                    </div>
                  )}
                  {messages.length === 0 && loaded && !(scopeMode === 'scoped' && currentScope.kind) && !showReturnCard && !showProactiveCard && !showBudgetCard && (
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
                  {/* Round 3.4 Bug 14 — suggested-answer chips. Render
                      above the navigation chips, with the locked Cowork
                      framing line above the group. Click inserts text
                      into the input as editable; user reviews and submits.
                      Suggested chips do NOT auto-submit. */}
                  {(() => {
                    const last = messages[messages.length - 1];
                    if (!last || last.role !== 'assistant') return null;
                    const sChips = last.suggestChips || [];
                    if (sChips.length === 0) return null;
                    if (sending) return null;
                    return (
                      <div className="partner-suggest-chips" style={{
                        padding: '8px 14px 4px 14px',
                      }}>
                        <div style={{
                          fontSize: 12,
                          lineHeight: 1.45,
                          color: '#6e6e73',
                          marginBottom: 8,
                          fontStyle: 'italic',
                        }}>
                          {SUGGESTED_CHIPS_FRAME}
                        </div>
                        <div style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: 8,
                        }}>
                          {sChips.map((chip, i) => (
                            <button
                              key={`s-${i}`}
                              type="button"
                              className="btn btn-ghost btn-sm partner-suggest-chip"
                              style={{
                                borderRadius: 18,
                                padding: '8px 14px',
                                fontSize: 13,
                                border: '1px dashed var(--accent, #007aff)',
                                color: 'var(--accent, #007aff)',
                                background: 'transparent',
                                textAlign: 'left',
                                lineHeight: 1.4,
                              }}
                              onClick={() => {
                                // Insert as editable text. Append to current
                                // input rather than replacing — the user may
                                // have started typing.
                                setInput(prev => (prev ? `${prev} ${chip}` : chip));
                                setTimeout(() => textareaRef.current?.focus(), 50);
                              }}
                              title="Click to drop this into the chat box. You can edit before sending."
                            >
                              {chip}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Chat-open reply chips. Render below the latest assistant
                      message when it carries chips and is the bottom of the
                      thread. Tap echoes the chip text as a normal user reply
                      via the existing send() flow. */}
                  {(() => {
                    const last = messages[messages.length - 1];
                    if (!last || last.role !== 'assistant') return null;
                    const chips = last.chips || [];
                    if (chips.length === 0) return null;
                    if (sending) return null;
                    return (
                      <div className="partner-opener-chips" style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 8,
                        padding: '8px 14px 4px 14px',
                      }}>
                        {chips.map((chip, i) => (
                          <button
                            key={i}
                            type="button"
                            className="btn btn-ghost btn-sm"
                            style={{
                              borderRadius: 18,
                              padding: '8px 14px',
                              fontSize: 14,
                              border: '1px solid var(--accent, #007aff)',
                              color: 'var(--accent, #007aff)',
                              background: 'transparent',
                            }}
                            onClick={async () => {
                              // Round 3.1 Item 2 — intercept three specific
                              // chip texts before falling through to the
                              // generic send-through-Opus path.

                              // (1) AUTONOMOUS skip-demand chip — route
                              // directly to /partner/autonomous-build so the
                              // pipeline kickoff is deterministic, not
                              // Opus-interpreted.
                              if (chip === SKIP_DEMAND_CHIP_AUTONOMOUS) {
                                setMessages(prev => prev.map((m, j) => (
                                  j === prev.length - 1 ? { ...m, chips: [] } : m
                                )).concat({ role: 'user', content: chip }));
                                try {
                                  const result = await api.post<{
                                    started: boolean;
                                    jobId?: string;
                                    draftId?: string;
                                    deliverableType?: string;
                                    reason?: string;
                                  }>('/partner/autonomous-build', {});
                                  if (result.started && result.jobId && result.draftId) {
                                    // Behave as if [BUILD_STARTED:jobId:draftId]
                                    // was received. Reuse the existing build-poll
                                    // path by synthesizing the marker into a
                                    // local actionResult-shaped follow-up.
                                    const synthetic = `[BUILD_STARTED:${result.jobId}:${result.draftId}] Building your ${result.deliverableType || 'deliverable'} now.`;
                                    // Send a no-op to trigger the existing
                                    // BUILD_STARTED handler — passing the
                                    // synthetic marker through send()'s
                                    // post-result branch isn't possible, so we
                                    // call the same poll logic inline. Keep it
                                    // simple: poll status here.
                                    const pollInterval = setInterval(async () => {
                                      try {
                                        const status = await api.get<{
                                          status: string;
                                          draftId: string | null;
                                          resultStoryId: string | null;
                                        }>(`/express/status/${result.jobId}`);
                                        if (status.status === 'complete' && status.resultStoryId && status.draftId) {
                                          clearInterval(pollInterval);
                                          navigate(`/five-chapter/${status.draftId}?story=${status.resultStoryId}`);
                                        } else if (status.status === 'error') {
                                          clearInterval(pollInterval);
                                          setMessages(prev => [...prev, {
                                            role: 'assistant',
                                            content: "Something went wrong building the draft. Tell me to try again if you'd like.",
                                          }]);
                                        }
                                      } catch {
                                        // Transient error — keep polling
                                      }
                                    }, 5000);
                                    setTimeout(() => clearInterval(pollInterval), 600000);
                                    void synthetic;
                                  } else {
                                    // Fallback: server couldn't classify or
                                    // couldn't find offering/audience. Send
                                    // chip text through Opus as before — Opus
                                    // ends up at Three-Tier-only, which is the
                                    // intended fallback per the CC prompt.
                                    send(chip);
                                  }
                                } catch (err) {
                                  console.error('[autonomous-build]', err);
                                  send(chip);
                                }
                                return;
                              }

                              // (2) YES on autonomous post-delivery offer →
                              // navigate to /three-tier/{draftId}.
                              if (chip === AUTONOMOUS_POST_DELIVERY_CHIP_YES && last.autonomousDraftId) {
                                setMessages(prev => prev.map((m, j) => (
                                  j === prev.length - 1 ? { ...m, chips: [] } : m
                                )).concat({ role: 'user', content: chip }));
                                navigate(`/three-tier/${last.autonomousDraftId}`);
                                return;
                              }

                              // (3) NO on autonomous post-delivery offer →
                              // close panel so the deliverable comes to focus.
                              if (isAutonomousPostDeliveryChipNo(chip) && last.kind === 'autonomous-post-delivery') {
                                setMessages(prev => prev.map((m, j) => (
                                  j === prev.length - 1 ? { ...m, chips: [] } : m
                                )).concat({ role: 'user', content: chip }));
                                setOpen(false);
                                return;
                              }

                              // Default: echo as user bubble + send through Opus.
                              setMessages(prev => prev.map((m, j) => (
                                j === prev.length - 1 ? { ...m, chips: [] } : m
                              )).concat({ role: 'user', content: chip }));
                              send(chip);
                            }}
                          >
                            {chip}
                          </button>
                        ))}
                      </div>
                    );
                  })()}

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

                  {/* Phase 2 — mode-switch offer card (Path A only). Appears
                      below the offer text when the user has hit the third
                      consecutive what's-next intent. Yes flips the toggle to
                      ON (Path B) and writes TOGGLE_CONFIRMATION_ON. No just
                      dismisses. Both outcomes persist asynchronously so chat
                      history stays complete across reloads / devices. */}
                  {modeSwitchOfferActive && !sending && (
                    <div className="partner-lead-promotion">
                      <div className="partner-lead-promotion-actions">
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => {
                            // Persist the user's accept as a chip-text user message.
                            api.post('/partner/log-message', {
                              role: 'user',
                              content: MODE_SWITCH_OFFER_CHIP_YES,
                              kind: 'mode-switch-accept',
                              ctx: pageContext,
                            }).catch(() => {/* non-critical */});
                            // Append the user's chip text locally for instant feel.
                            setMessages(prev => [
                              ...prev,
                              { role: 'user', content: MODE_SWITCH_OFFER_CHIP_YES },
                            ]);
                            // Persist the toggle state on User.settings so it
                            // follows the user across devices (Phase 1 promise).
                            api.put('/partner/consultation', { value: 'on' }).catch(() => {/* non-critical */});
                            // Persist the toggle confirmation chat row.
                            api.post('/partner/log-message', {
                              role: 'assistant',
                              content: TOGGLE_CONFIRMATION_ON,
                              kind: 'toggle-confirmation',
                              ctx: pageContext,
                            }).catch(() => {/* non-critical */});
                            // Flip the toggle. setToggleState dispatches the
                            // LEAD_TOGGLE_EVENT — the dashboard toggle UI moves
                            // visibly AND the LEAD_TOGGLE_EVENT listener
                            // appends TOGGLE_CONFIRMATION_ON to the thread.
                            setToggleState('on');
                            setModeSwitchOfferActive(false);
                          }}
                        >
                          {MODE_SWITCH_OFFER_CHIP_YES}
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => {
                            api.post('/partner/log-message', {
                              role: 'user',
                              content: MODE_SWITCH_OFFER_CHIP_NO,
                              kind: 'mode-switch-decline',
                              ctx: pageContext,
                            }).catch(() => {/* non-critical */});
                            setMessages(prev => [
                              ...prev,
                              { role: 'user', content: MODE_SWITCH_OFFER_CHIP_NO },
                            ]);
                            // Round 4 Fix 5 — session-level decline flag so
                            // the offer doesn't re-fire later in the same
                            // session if the user crosses threshold again.
                            markModeSwitchOfferDeclined(user?.userId);
                            setModeSwitchOfferActive(false);
                          }}
                        >
                          {MODE_SWITCH_OFFER_CHIP_NO}
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
                {/* B-4 — first-encounter voice-button orientation. Renders
                    once per user (localStorage). Same visual treatment as
                    Three Tier "view mode" orientation: subtle card with a
                    short hint and a "Got it" dismiss. */}
                {showVoiceTooltip && (
                  <div className="partner-voice-tooltip" role="status">
                    <span><strong>New:</strong> tap and hold the mic to talk. Faster than typing for long thoughts.</span>
                    <button className="btn btn-ghost btn-sm" onClick={dismissVoiceTooltip}>Got it</button>
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
                    placeholder={sending ? "Type — I'll fold it in when this finishes…" : "Type a reply, or ask Maria anything…"}
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
                  {/* Round E3 — voice-IN button. Tap-and-hold to dictate; release
                      to send the transcript into the input. Whole utterance
                      processed as one turn (no breaking on pauses). On iOS
                      uses webkitSpeechRecognition; on desktop uses standard
                      SpeechRecognition. Falls back to keyboard with a tooltip
                      if neither is available. */}
                  <VoiceInputButton
                    onTranscript={(text, persistentIntent) => {
                      // Append to current input rather than replacing — the user
                      // may have typed something before tapping the mic.
                      setInput((prev) => (prev ? `${prev} ${text}` : text));
                      // If the heuristic identified a persistent intent, hand it
                      // off so the substantive-direction summary-back rule fires.
                      if (persistentIntent) {
                        try {
                          localStorage.setItem('voice-persistent-intent-pending', persistentIntent);
                        } catch {}
                      }
                    }}
                  />
                  <button
                    className="partner-attach"
                    onClick={() => fileInputRef.current?.click()}
                    aria-label="Attach file"
                    title="Drop a doc — Maria reads PDFs, Word, plain text, screenshots."
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
                    </svg>
                  </button>
                  {/* Round 3.4 Bug 2 — Send is no longer disabled while a
                      previous send is in flight. send() handles the queue
                      logic: mid-send clicks push to pendingQueueRef and
                      drain when sending flips false. Only stay disabled
                      when there's literally nothing to send. */}
                  <button className="partner-send" onClick={() => send()} disabled={!input.trim() && pendingFiles.length === 0} aria-label="Send">
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
