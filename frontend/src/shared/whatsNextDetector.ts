// What's-next intent detector for Path A (toggle off).
//
// The 12-phrase intent list MUST stay character-for-character in sync
// with WHATS_NEXT_INTENT_PHRASES in backend/src/prompts/milestoneCopy.ts.
// That backend file is the canonical source authored by Cowork. The
// frontend can't import from backend/src/ across the monorepo split, so
// the array is mirrored here. Any change to the list goes through Cowork
// in milestoneCopy.ts FIRST, then this file is updated to match — never
// the other way around.

const WHATS_NEXT_INTENT_PHRASES: ReadonlyArray<string> = [
  "what's next",
  "whats next",
  "what now",
  "now what",
  "what should i do",
  "what do i do next",
  "where do we go from here",
  "what's the next step",
  "keep going",
  "let's keep going",
  "go on",
  "continue",
];

const WHATS_NEXT_TRIGGER_THRESHOLD = 3;

// Match the user's message against the intent list. Case-insensitive,
// strips outer whitespace and trailing punctuation. Leans toward false
// negatives so the offer doesn't misfire on borderline phrasing.
export function isWhatsNextIntent(rawText: string): boolean {
  if (!rawText) return false;
  const normalized = rawText
    .trim()
    .toLowerCase()
    .replace(/[?!.,;:]+$/, '')
    .trim();
  if (!normalized) return false;
  return WHATS_NEXT_INTENT_PHRASES.includes(normalized);
}

// Per-tab session memory for the consecutive what's-next counter.
// Resets on logout (sessionStorage scope), on a non-matching user
// message, on toggle promotion, on offer accept, on offer decline.
function counterKey(userId: string): string {
  return `whats-next-count-${userId}`;
}

export function getWhatsNextCount(userId: string | undefined): number {
  if (!userId) return 0;
  try {
    const v = sessionStorage.getItem(counterKey(userId));
    if (!v) return 0;
    const n = parseInt(v, 10);
    return isNaN(n) ? 0 : n;
  } catch {
    return 0;
  }
}

export function setWhatsNextCount(userId: string | undefined, n: number): void {
  if (!userId) return;
  try {
    sessionStorage.setItem(counterKey(userId), String(n));
  } catch { /* non-critical */ }
}

export function resetWhatsNextCount(userId: string | undefined): void {
  if (!userId) return;
  try {
    sessionStorage.removeItem(counterKey(userId));
  } catch { /* non-critical */ }
}

// Bump the counter and return whether the threshold was just crossed.
// Caller fires the mode-switch offer when this returns true.
export function bumpWhatsNextAndShouldOffer(
  userId: string | undefined,
  userText: string,
): boolean {
  if (!userId) return false;
  if (!isWhatsNextIntent(userText)) {
    resetWhatsNextCount(userId);
    return false;
  }
  const next = getWhatsNextCount(userId) + 1;
  setWhatsNextCount(userId, next);
  return next >= WHATS_NEXT_TRIGGER_THRESHOLD;
}

export const __TEST_ONLY__ = {
  WHATS_NEXT_INTENT_PHRASES,
  WHATS_NEXT_TRIGGER_THRESHOLD,
};
