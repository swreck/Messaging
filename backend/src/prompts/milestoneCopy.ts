// All user-facing wording in this file is authored by Cowork and approved
// by Ken. Do not modify any string without Ken's explicit approval.
// This file is requested for the locked-files list in CLAUDE.md once shipped.

// ─── Milestone narrations (Path B only) ──────────────────────────────

export const MILESTONE_FOUNDATION_CONFIRMED =
  "OK, I've turned what you told me into the foundational message, what we call your Three Tier. Have a look at the top tier — that's the line we want your audience to remember. If it doesn't sound like you, tell me and we'll adjust.";

export const MILESTONE_CHAPTERS_SEPARATED_READY =
  "Now I've taken the foundation and split it into the five chapters of a story, what we call your 5 Chapter Story. I keep them separate at this stage so we can examine each one. Read them in order — they should feel like five connected steps, not five paragraphs.";

export const MILESTONE_CHAPTERS_COMBINED_READY =
  "I've joined the five chapters into one read so you can hear them as a single voice. It's still in pieces underneath — we can return to any one of them — but this is what your audience will experience.";

export const MILESTONE_BLENDED_READY =
  "Last pass: I've polished the seams so the five chapters feel like one piece of writing instead of five. This is the version you'd send. Take a look. If anything doesn't sound like you, point at it and we'll fix it.";

// ─── Soft notes for chapter content gaps (empty or partial) ──────────────
// Sent as separate chat messages after MILESTONE_BLENDED_READY, never
// appended to the deliverable body. One soft note per gappy chapter.

const CHAPTER_PURPOSE: Record<3 | 4 | 5, string> = {
  3: "ROI and measurable value",
  4: "others who already trust you",
  5: "what you want your audience to do next",
};

const EMPTY_CASE_FILL: Record<3 | 4 | 5, string> = {
  3: "any numerical metric",
  4: "an actual name or award",
  5: "a specific action they can take — a call link, an email, or a scheduling page",
};

const VALUE_CLAIM_POOL: ReadonlyArray<string> = [
  "more compelling",
  "more persuasive",
  "sharper",
  "more direct",
  "stronger",
];

// Internal counter for index-rotating selection. Module-level state.
let _valueClaimIdx = 0;
function pickValueClaim(): string {
  const claim = VALUE_CLAIM_POOL[_valueClaimIdx % VALUE_CLAIM_POOL.length];
  _valueClaimIdx += 1;
  return claim;
}

export function buildSoftNote(
  chapter: 3 | 4 | 5,
  missingPieces: string[]  // empty = whole chapter empty; non-empty = partial
): string {
  const purpose = CHAPTER_PURPOSE[chapter];
  const valueClaim = pickValueClaim();

  let missingDescription: string;
  if (missingPieces.length === 0) {
    missingDescription = EMPTY_CASE_FILL[chapter];
  } else if (missingPieces.length === 1) {
    missingDescription = missingPieces[0];
  } else if (missingPieces.length === 2) {
    missingDescription = `${missingPieces[0]} and ${missingPieces[1]}`;
  } else {
    const last = missingPieces[missingPieces.length - 1];
    const rest = missingPieces.slice(0, -1).join(", ");
    missingDescription = `${rest}, and ${last}`;
  }

  return `The chapter on ${purpose}, chapter ${chapter}, would be ${valueClaim} with ${missingDescription}. Anything I can use?`;
}

// ─── Mode-switch offer (Path A → Path B, after 3 consecutive what's-next) ─

export const MODE_SWITCH_OFFER_PATH_A_TO_B =
  "Want me to take the lead from here? I'll narrate the next moves as we go.";

export const MODE_SWITCH_OFFER_CHIP_YES = "Yes, take the lead";
export const MODE_SWITCH_OFFER_CHIP_NO  = "No, I'll keep going";

// ─── Toggle confirmations (fire on every flip event, in or out of pipeline) ─

export const TOGGLE_CONFIRMATION_ON =
  "Got it — taking over from here.";

export const TOGGLE_CONFIRMATION_OFF =
  "Got it. Back to you. I'll still be here for any edit requests or reviews anytime you ask.";

// ─── Foundational-shift pause (mid-pipeline, after a foundation-changing edit) ─

export const PAUSE_ON_FOUNDATIONAL_SHIFT =
  "Hold on — let me redo the foundation with that change before I keep going.";

// ─── Foundational-shift timeout (Path B, 5-min hold expired) ──────────

export const TIMEOUT_AREA_TIER1     = "your top tier";
export const TIMEOUT_AREA_TIER2     = "your priorities";
export const TIMEOUT_AREA_AUDIENCE  = "your audience";
export const TIMEOUT_AREA_OFFERING  = "your offering";
export const TIMEOUT_AREA_FALLBACK  = "the foundation";

export function buildFoundationalShiftTimeout(area: string): string {
  return `I had to let the story go — I can only hold things for a few minutes. When you're ready to come back to ${area}, tell me and we'll start it back up.`;
}

// ─── Fresh-user opener (empty workspace, on direct invocation of chat) ────

export const OPENER_FRESH_USER =
  "Hi — I'm Maria. What are we working on?";

// ─── Fresh-user opener chips (paired with OPENER_FRESH_USER) ────────────

export const OPENER_FRESH_USER_CHIPS: ReadonlyArray<string> = [
  "Win over a customer or outside audience",
  "Get sign-off from a decision-maker inside",
  "Align a team on a move",
  "Sharpen a draft I've already started",
];

// ─── iPhone affordance labels ─────────────────────────────────────────

export const IPHONE_AFFORDANCE_TAKE_A_LOOK = "Take a look";
export const IPHONE_AFFORDANCE_WORK_WITH_MARIA = "Work with Maria";

// ─── Tunable constants ────────────────────────────────────────────────

export const PAGE_AFTER_NARRATION_DELAY_MS = 1000;
export const WHATS_NEXT_TRIGGER_THRESHOLD = 3;

// ─── What's-next detector intent list ─────────────────────────────────

export const WHATS_NEXT_INTENT_PHRASES: ReadonlyArray<string> = [
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
