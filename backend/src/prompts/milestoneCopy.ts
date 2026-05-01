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

// Round 4 Fix 9 — expanded from 5 to 10 entries so users don't see the
// same opening word for soft note 1 across multiple builds in a session.
export const VALUE_CLAIM_POOL: ReadonlyArray<string> = [
  "more compelling",
  "more persuasive",
  "sharper",
  "more direct",
  "stronger",
  "tighter",
  "clearer",
  "more memorable",
  "more concrete",
  "more credible",
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

  // Round 3.2 Item 4 — strip trailing punctuation from each piece before
  // joining. Some classifier outputs end with a period; the template
  // appends its own period after `${missingDescription}`, producing the
  // doubled-period bug Cowork observed (".. Anything I can use?").
  const cleanedPieces = missingPieces.map(p => p.replace(/[.!?]+\s*$/, '').trim()).filter(p => p.length > 0);

  let missingDescription: string;
  if (cleanedPieces.length === 0) {
    missingDescription = EMPTY_CASE_FILL[chapter];
  } else if (cleanedPieces.length === 1) {
    missingDescription = cleanedPieces[0];
  } else if (cleanedPieces.length === 2) {
    missingDescription = `${cleanedPieces[0]} and ${cleanedPieces[1]}`;
  } else {
    const last = cleanedPieces[cleanedPieces.length - 1];
    const rest = cleanedPieces.slice(0, -1).join(", ");
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

// ─── Skip-demand response (user explicitly asks to bypass coaching) ─────
// Round 4 Fix 4 — Ken's tightened four-sentence version. Replaces the
// prior five-sentence text which read as a wall on phones.

export const SKIP_DEMAND_RESPONSE =
  "I've tried this — it doesn't work well. The result is more persuasive if you confirm interim steps. I'll help. But if you really want to skip, I'll do my best with what you've given me. It'll take a few minutes.";

export const SKIP_DEMAND_CHIP_CONTINUE = "Lead me through interim steps. Quickly.";
export const SKIP_DEMAND_CHIP_AUTONOMOUS = "I understand. Do your best.";

export const SKIP_INTENT_PHRASES: ReadonlyArray<string> = [
  "just build it",
  "just build the whole thing",
  "skip the process",
  "skip the questions",
  "skip the steps",
  "skip ahead",
  "skip it",
  "i don't want to do this",
  "i don't want to walk through",
  "give me the result",
  "give me the deliverable",
  "do it for me",
  "do the whole thing",
  "go ahead and do it",
  "build the whole thing",
];

// ─── Stage-aware presence check-ins (fire if a stage runs > 30s) ─────

export const STAGE_CHECKIN_TIER_GENERATION =
  "Working on the foundation — won't be long.";

export const STAGE_CHECKIN_CHAPTERS =
  "Working through the chapters — should be a couple minutes.";

export const STAGE_CHECKIN_BLEND =
  "Polishing the seams — almost there.";

// ─── Foundational-shift hold midpoint presence (fires at 90s of 3-min hold) ──

export const FOUNDATIONAL_SHIFT_HOLD_MIDPOINT =
  "Still here — take your time.";

// ─── Fallback chat-open opener when the validator catches a fabricated name ─
// Round 4 Fix 1.

export const OPENER_FALLBACK_GENERIC =
  "Welcome back. What are we working on today?";

// ─── Soft-note pacing — Round 4 Fixes 7 + 8 ────────────────────────────
// After MILESTONE_BLENDED_READY lands, wait this long before writing the
// first soft note so Maria's "Take a look" invitation has breathing room.
export const PAUSE_BEFORE_SOFT_NOTES_MS = 4000;
// Between soft notes, when more than one chapter has gaps. Prevents the
// chat panel from queue-dumping bubbles all at once.
export const SOFT_NOTE_STAGGER_MS = 3500;

// ─── Path A dashboard banner — Round 4 Fix 10 ──────────────────────────
// Replaces the prior "You're driving. I'll wait until you ask." banner.
// Stylized capital-L "Let Maria Lead" is intentional — the live toggle
// label uses lowercase but the banner reference reads as a setting name.

export const PATH_A_BANNER =
  "Maria is listening. Toggle 'Let Maria Lead' for guidance.";

// ─── Round 3.1 Item 2 — Autonomous skip-demand pipeline messages ───────
// Templates take the user's stated deliverable type ("email", "pitch
// deck", "landing page", etc.). The same word substitutes into every
// slot of a given message — never mix "email" and "draft" inside one
// post-delivery offer. If the deliverable type is unknown, callers
// should fall back to "deliverable" verbatim.

export function buildAutonomousPreBuildExpectation(deliverableType: string): string {
  return `I'll be doing multiple things with the info you've given me to create the ${deliverableType} — this will take a few minutes.`;
}

export function buildAutonomousPostDeliveryOffer(deliverableType: string): string {
  return `This is the ${deliverableType} you asked for. Quick context: to write it I built a reusable foundation underneath — a Three Tier — and the deliverable came out of that. If anything in the ${deliverableType} feels off, the Three Tier is the place to fix it, not the ${deliverableType} itself. Take me there to review?`;
}

export const AUTONOMOUS_POST_DELIVERY_CHIP_YES =
  "Yes, take me to the Three Tier";

export function buildAutonomousPostDeliveryChipNo(deliverableType: string): string {
  return `No, I'll review the ${deliverableType} here`;
}

// ─── Round 3.1 Item 3 — Blend-phase heartbeat ──────────────────────────
// Fires AT MOST once per blend run, when the blend stage exceeds
// BLEND_HEARTBEAT_MS. Suppressed if blend completes under the threshold.

export const BLEND_HEARTBEAT =
  "Still polishing — this last pass takes a minute.";

export const BLEND_HEARTBEAT_MS = 60000;

// ─── Round 3.3 Item 1 — tier-generation + chapters heartbeats ─────────
// Same pattern as BLEND_HEARTBEAT — fire AT MOST once per stage when
// elapsed exceeds the threshold. Round 3.2 surfaced 4-5 minute silent
// gaps between STAGE_CHECKIN and the next milestone; users staring at
// a silent chat close the tab. Cowork-locked wording.

export const TIER_GENERATION_HEARTBEAT =
  "Still on the foundation — getting the top tier right takes a beat.";

export const CHAPTERS_HEARTBEAT =
  "Still on the chapters — letting each one breathe before stitching them together.";

export const TIER_GENERATION_HEARTBEAT_MS = 90000;
export const CHAPTERS_HEARTBEAT_MS = 90000;

// ─── Round 3.2 Item 3 — Splash welcome (fresh-signup dashboard) ────────
// Replaces the prior 47-word promotional splash. Same six words as
// OPENER_FRESH_USER — the splash and the chat-panel opener intentionally
// share this line to reduce visual noise on first impression.

export const SPLASH_FRESH_USER =
  "Hi — I'm Maria. What are we working on?";

// ─── Round 3.2 Item 5B — DROPPED per Cowork's verification call. ──────
// PATH_A_RETURN_ACKNOWLEDGMENTS and buildPathAReturnAcknowledgment were
// removed because Round 4 Fix 11's audience-anchored chat-open opener
// ("Back to the [audience]?") already covers return-user continuity
// for the same trigger condition. Adding a separate locked-pool layer
// on top competed with Fix 11 for the same chat-panel slot.

// ─── Round 3.2 Item 7 — Affirmation pool ──────────────────────────────
// Replaces the templated "That was actually really clear" tic. Maria
// chooses an entry only when an affirmation is warranted; many turns
// have no affirmation at all. Index-rotating selection, same shape as
// VALUE_CLAIM_POOL.

export const AFFIRMATION_POOL: ReadonlyArray<string> = [
  "Got it. That's enough to work with.",
  "OK — I have what I need on that.",
  "Right there — that's clean.",
  "Crisp. That helps.",
  "That tracks. Good enough to build on.",
  "Clear. Moving on.",
  "Solid. That's what I needed.",
  "Got it.",
];

let _affirmationIdx = 0;
export function pickAffirmation(): string {
  const a = AFFIRMATION_POOL[_affirmationIdx % AFFIRMATION_POOL.length];
  _affirmationIdx += 1;
  return a;
}

// ─── Round 3.2 Item 11 — Identity acknowledgment ──────────────────────
// Fires only when the user asks an identity question ("Are you AI?",
// "What model are you?", "Who built you?", similar). Maria answers
// directly, then bridges back to the work at hand on the next turn.

export const IDENTITY_ACKNOWLEDGMENT =
  "Yes, I'm an AI agent built by Anthropic and trained on techniques to help with persuasive messaging.";

// Phrase list for backend identity-question detection. Lean toward false
// negatives — if the user phrases the question off-list, Opus's normal
// flow continues; the rule-detect short-circuit only fires on clear hits.
export const IDENTITY_INTENT_PHRASES: ReadonlyArray<string> = [
  "are you ai",
  "are you a ai",
  "are you an ai",
  "are you human",
  "are you a human",
  "are you a person",
  "are you a bot",
  "are you a chatbot",
  "what model are you",
  "what model is this",
  "which model",
  "who built you",
  "who made you",
  "who created you",
  "what are you",
  "are you real",
];
