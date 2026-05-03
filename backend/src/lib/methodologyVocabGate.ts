// Bundle 1B Rule 10 — methodology vocabulary first-use gating.
//
// Methodology terms ("Three Tier", "Five Chapter Story", "Tier 1",
// "Tier 2", "Framed Slot", etc.) get a brief framing on first use in
// a session, then are used unframed for the rest of the session. The
// next session resets — first use is again framed.
//
// Per Cowork's open-question answer: session boundary = calendar day.
// A user who signs in over multiple days gets methodology terms re-
// introduced (briefly framed) on first use of each day. Matches how
// a real "smart friend at coffee shop" conversation works — context
// fades naturally between days even if the underlying relationship
// persists.
//
// State shape on User.settings.methodologyVocab:
//   { [term]: "YYYY-MM-DD" }  // last-introduced calendar day in UTC
//
// First-use check: if the stored day !== today's UTC day, the term
// gets framed AND the day is updated.
//
// The framing copy itself lives in METHODOLOGY_TERM_EXPLANATIONS
// (prompts/milestoneCopy.ts) — this gate decides WHEN to apply it.

import { prisma } from './prisma.js';

const DAY_KEY_FORMAT = 'YYYY-MM-DD';

/** Calendar-day key in UTC. "2026-05-03" shape. */
function todayKey(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Read the user's methodology-vocab map. Returns empty object if
 *  unset or malformed. */
async function readVocabMap(userId: string): Promise<Record<string, string>> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { settings: true },
  });
  const settings = (user?.settings as Record<string, any>) || {};
  const map = settings.methodologyVocab;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return {};
  return map as Record<string, string>;
}

/**
 * Check whether a methodology term is "first use today" for this
 * user. Returns true on first use of the calendar day, false on
 * subsequent uses. Does NOT update the stored state — call
 * markIntroduced separately when you actually use the term framed.
 */
export async function isFirstUseToday(userId: string, term: string): Promise<boolean> {
  const map = await readVocabMap(userId);
  const lastDay = map[term];
  return !lastDay || lastDay !== todayKey();
}

/**
 * Mark a methodology term as introduced today. Subsequent calls to
 * isFirstUseToday with the same term + same calendar day return
 * false until UTC midnight rolls.
 */
export async function markIntroducedToday(userId: string, term: string): Promise<void> {
  const map = await readVocabMap(userId);
  const today = todayKey();
  if (map[term] === today) return; // No write needed — already marked.
  map[term] = today;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { settings: true },
  });
  const settings = (user?.settings as Record<string, any>) || {};
  settings.methodologyVocab = map;
  await prisma.user.update({
    where: { id: userId },
    data: { settings },
  });
}

/**
 * Compute which terms in a known vocabulary list are first-use today
 * vs already-introduced. Used to build a system-prompt directive
 * that tells Opus which terms to frame.
 *
 * Returns:
 *   {
 *     framed:    string[]  // terms requiring first-use framing this turn
 *     unframed:  string[]  // terms already introduced — use bare
 *   }
 */
export async function getVocabIntroductionState(
  userId: string,
  vocabulary: string[],
): Promise<{ framed: string[]; unframed: string[] }> {
  const map = await readVocabMap(userId);
  const today = todayKey();
  const framed: string[] = [];
  const unframed: string[] = [];
  for (const term of vocabulary) {
    if (map[term] === today) {
      unframed.push(term);
    } else {
      framed.push(term);
    }
  }
  return { framed, unframed };
}

void DAY_KEY_FORMAT; // documentation reference
