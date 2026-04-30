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

// ─── Soft notes for missing chapters (sent as a separate chat message
// after MILESTONE_BLENDED_READY, not appended to the deliverable body) ─

export const SOFT_NOTE_CHAPTER_3_MISSING =
  "Note: we haven't discussed numbers or outcomes yet, so there's nothing yet in the measurable value chapter (Chapter 3). When you're ready, tell me what the measurable difference looks like and I'll fold it in.";

export const SOFT_NOTE_CHAPTER_4_MISSING =
  "Note: we haven't discussed customers or awards yet, so there's nothing yet in the social proof chapter (Chapter 4). When we have a customer story or two, I can fold them in.";

export const SOFT_NOTE_CHAPTER_5_MISSING =
  "Note: we haven't discussed what you want your audience to do next, so there's nothing yet in the ask chapter (Chapter 5). Tell me the action and I'll add it.";

// Composite note when 2 or 3 chapters are missing — sent as one chat
// message after MILESTONE_BLENDED_READY in place of the individual
// soft notes.
export function buildCompositeMissingNote(missing: Array<3 | 4 | 5>): string {
  const labels: Record<3 | 4 | 5, string> = {
    3: "the measurable value (Chapter 3)",
    4: "the references and social proof (Chapter 4)",
    5: "the ask (Chapter 5)",
  };
  const parts = missing.sort().map((n) => labels[n]);
  let list: string;
  if (parts.length === 2) {
    list = `${parts[0]} and ${parts[1]}`;
  } else {
    list = `${parts[0]}, ${parts[1]}, and ${parts[2]}`;
  }
  return `Note: a few chapters aren't filled in yet — ${list}. When we have any of them, I'll fold them in.`;
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
