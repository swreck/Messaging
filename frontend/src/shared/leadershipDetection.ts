// Detects when a chat message from the user expresses a preference for Maria
// to lead more (just decide) or lead less (check with me first). This is the
// client-side half of the "toggle can't lie" rule: the chat request complies
// immediately for the current task, but the visible "Let Maria lead" toggle
// only moves with explicit confirmation.
//
// Kept as a pure regex utility so future refinement (e.g. switching to an AI
// classifier) can drop in behind the same shape without touching UI wiring.

export type LeadDirection = 'more' | 'less';

// These patterns must match the WHOLE message (with polite filler stripped),
// not just appear somewhere inside it. This is the critical guardrail: if a
// user types "just decide which example to use for Tier 2", that's a real
// task request — we must NOT intercept it and send back a meta-ack. The
// anchors (^...$) below enforce that only standalone directives qualify.

// "More" — user wants Maria to take more initiative / stop asking
const LEAD_MORE_PATTERNS = [
  /^just (?:decide|pick|choose|go|do it|handle it)$/i,
  /^you (?:decide|pick|choose|go ahead|handle it|drive|lead|take over)$/i,
  /^go ahead(?: and (?:decide|pick|choose))?$/i,
  /^don'?t (?:keep )?asking(?: me)?$/i,
  /^stop asking(?: me)?$/i,
  /^(?:i )?trust (?:you|your (?:judg?ment|call))$/i,
  /^surprise me$/i,
  /^your call$/i,
  /^you know best$/i,
  /^you decide$/i,
];

// "Less" — user wants Maria to slow down / check first
const LEAD_LESS_PATTERNS = [
  /^ask me (?:first|before)$/i,
  /^check with me(?: (?:first|before))?$/i,
  /^stop deciding (?:for me|on your own)$/i,
  /^let me decide$/i,
  /^slow down$/i,
  /^don'?t (?:just )?(?:decide|pick|choose) (?:for me|on your own)$/i,
  /^wait for me$/i,
  /^i (?:want to|will) (?:decide|pick|choose)$/i,
];

// Strip leading/trailing polite filler and punctuation so a phrase like
// "please just decide!!" or "hey Maria, your call." still registers as a
// pure directive. We do NOT strip from the middle — if there's meaningful
// content between pleasantries, the anchored patterns below won't match,
// and that's the correct outcome.
function coreText(raw: string): string {
  let t = raw.trim().toLowerCase();
  // strip surrounding quotes
  t = t.replace(/^["'`]+|["'`]+$/g, '');
  // strip leading filler words (one or more, in any order)
  // eg "please ok hey maria, just decide" → "just decide"
  const leading = /^(?:please|okay|ok|hey|hi|yeah|yes|sure|um|uh|so|well|maria|maria,?)\s+/i;
  while (leading.test(t)) t = t.replace(leading, '');
  // strip trailing punctuation and filler
  t = t.replace(/[\s.!?,;:]+$/g, '');
  const trailing = /\s+(?:please|thanks|thank you|maria)$/i;
  while (trailing.test(t)) t = t.replace(trailing, '');
  t = t.replace(/[\s.!?,;:]+$/g, '');
  return t.trim();
}

export function detectLeadDirective(text: string): LeadDirection | null {
  const t = coreText(text);
  if (!t) return null;
  if (LEAD_MORE_PATTERNS.some(re => re.test(t))) return 'more';
  if (LEAD_LESS_PATTERNS.some(re => re.test(t))) return 'less';
  return null;
}

// Toggle storage helpers. The toggle is binary today ('on' = Maria leads,
// 'off' = user leads). If the rule expands to three-state later, this is the
// point where we widen the shape.
const TOGGLE_KEY = 'maria-consultation';
const OVERRIDE_COUNT_KEY = 'maria-lead-override-count';
const PROMOTION_EVENT = 'maria-lead-toggle-changed';

export type ToggleState = 'on' | 'off';

export function getToggleState(): ToggleState {
  try {
    const v = localStorage.getItem(TOGGLE_KEY);
    if (v === 'off') return 'off';
    return 'on'; // default on, matches DashboardPage initializer
  } catch {
    return 'on';
  }
}

export function setToggleState(next: ToggleState): void {
  try {
    localStorage.setItem(TOGGLE_KEY, next);
  } catch {}
  try {
    document.dispatchEvent(
      new CustomEvent(PROMOTION_EVENT, { detail: { value: next } })
    );
  } catch {}
}

// Returns true if the given directive conflicts with the current toggle state
// (i.e. the user is asking for the opposite of what the toggle promises).
export function directiveConflictsWithToggle(direction: LeadDirection): boolean {
  const s = getToggleState();
  if (direction === 'more' && s === 'off') return true; // toggle says user leads, user wants Maria to lead
  if (direction === 'less' && s === 'on') return true; // toggle says Maria leads, user wants to slow down
  return false;
}

// Override count per direction — resets when user promotes the direction.
// Used by the 3-strike softening message: after three dismissals Maria reads
// the pattern and offers again in a more self-aware voice.
type CountMap = { more: number; less: number };

function readCounts(): CountMap {
  try {
    const raw = localStorage.getItem(OVERRIDE_COUNT_KEY);
    if (!raw) return { more: 0, less: 0 };
    const parsed = JSON.parse(raw);
    return {
      more: Math.max(0, Number(parsed?.more) || 0),
      less: Math.max(0, Number(parsed?.less) || 0),
    };
  } catch {
    return { more: 0, less: 0 };
  }
}

function writeCounts(c: CountMap): void {
  try {
    localStorage.setItem(OVERRIDE_COUNT_KEY, JSON.stringify(c));
  } catch {}
}

export function bumpOverrideCount(direction: LeadDirection): number {
  const c = readCounts();
  c[direction] = c[direction] + 1;
  writeCounts(c);
  return c[direction];
}

export function resetOverrideCount(direction: LeadDirection): void {
  const c = readCounts();
  c[direction] = 0;
  writeCounts(c);
}

export function getOverrideCount(direction: LeadDirection): number {
  return readCounts()[direction];
}

export const LEAD_TOGGLE_EVENT = PROMOTION_EVENT;
