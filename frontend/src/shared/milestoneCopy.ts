// Frontend mirror of the Cowork-locked wording in
// backend/src/prompts/milestoneCopy.ts. The backend file is the canonical
// source. The frontend can't import across the monorepo split, so these
// strings are duplicated here.
//
// Phase 2 — any change to the wording goes through Cowork in
// backend/src/prompts/milestoneCopy.ts FIRST, then this file is updated
// to match character-for-character. Never edit this file in isolation.

export const MODE_SWITCH_OFFER_PATH_A_TO_B =
  "Want me to take the lead from here? I'll narrate the next moves as we go.";

export const MODE_SWITCH_OFFER_CHIP_YES = "Yes, take the lead";
export const MODE_SWITCH_OFFER_CHIP_NO  = "No, I'll keep going";

export const TOGGLE_CONFIRMATION_ON =
  "Got it — taking over from here.";

export const TOGGLE_CONFIRMATION_OFF =
  "Got it. Back to you. I'll still be here for any edit requests or reviews anytime you ask.";

export const IPHONE_AFFORDANCE_TAKE_A_LOOK = "Take a look";
export const IPHONE_AFFORDANCE_WORK_WITH_MARIA = "Work with Maria";

export const PAGE_AFTER_NARRATION_DELAY_MS = 1000;

// Round 4 Fix 10 Part B — replaces the prior "You're driving" banner.
// Mirror of PATH_A_BANNER in backend/src/prompts/milestoneCopy.ts.
export const PATH_A_BANNER =
  "Maria is listening. Toggle 'Let Maria Lead' for guidance.";

// Round 3.1 Item 2 — autonomous skip-demand mirrors. Used to detect the
// AUTONOMOUS chip click and the post-delivery offer chips so the panel
// can route them deterministically (autonomous chip → /partner/autonomous-build,
// YES chip → navigate to Three Tier, NO chip → minimize panel).
export const SKIP_DEMAND_CHIP_AUTONOMOUS = "I understand. Do your best.";
export const AUTONOMOUS_POST_DELIVERY_CHIP_YES = "Yes, take me to the Three Tier";

// Match function for the NO chip. The chip text is template-generated
// per deliverable type ("No, I'll review the email here", "No, I'll
// review the pitch deck here", etc.), so the detector matches the
// prefix + suffix rather than an exact string.
export function isAutonomousPostDeliveryChipNo(chip: string): boolean {
  if (!chip) return false;
  const trimmed = chip.trim();
  return /^No, I'll review the .+ here\.?$/.test(trimmed);
}

// Round 3.2 Item 3 — splash welcome text. Mirror of SPLASH_FRESH_USER
// in backend/src/prompts/milestoneCopy.ts. Same six words as
// OPENER_FRESH_USER — shared on purpose so the splash and the chat
// opener don't compete on first impression.
export const SPLASH_FRESH_USER =
  "Hi — I'm Maria. What are we working on?";

// ─── Round 3.4 Bug 11 — empty Tier 2 row guidance ─────────────────────
// Mirror of buildTier2EmptyGuidance / TIER2_EMPTY_GUIDANCE_BY_CATEGORY
// in backend/src/prompts/milestoneCopy.ts. Per-category locked Cowork
// copy plus a generic fallback. Categories named to match what the
// backend Three Tier generator emits as t2.categoryLabel.
const TIER2_EMPTY_GUIDANCE_BY_CATEGORY: Record<string, string> = {
  "Social proof":
    "Social proof is empty because I don't have a name to use yet. Add one or two customers you can reference — even just first name + role + company size — and this row fills in.",
  "ROI":
    "ROI is empty because I don't have a measurable outcome yet. Tell me a number — even an order of magnitude estimate — and this row fills in.",
  "Support":
    "Support is empty because I don't know how you actually back up the buyer after the sale. Tell me what training, planning, or ongoing help you provide and this row fills in.",
  "Focus":
    "Focus is empty because I don't have your commitment-to-the-audience statement yet. Tell me, in your voice, what your company is committed to giving them — and this row fills in.",
  "Product":
    "Product is empty because I don't have your differentiating capabilities yet. Tell me one or two things your offering does that the alternatives don't — and this row fills in.",
};

export function buildTier2EmptyGuidance(categoryName: string): string {
  const trimmed = (categoryName || "").trim();
  if (TIER2_EMPTY_GUIDANCE_BY_CATEGORY[trimmed]) {
    return TIER2_EMPTY_GUIDANCE_BY_CATEGORY[trimmed];
  }
  return `${trimmed} is empty because I don't have what I need yet. Tell me what would go here, even briefly, and this row fills in.`;
}

export const DROP_EMPTY_ROW_CHIP = "Drop this row for now.";

// ─── Round 3.4 Bug 14 — suggested-answer chip framing ──────────────────
// Mirror of SUGGESTED_ANSWER_CHIP_FRAMING / SUGGESTED_CHIPS_FRAME.
export const SUGGESTED_ANSWER_CHIP_FRAMING =
  "Here are some shapes that often fit — pick one as a starting point if it sounds right, or type your own.";
export const SUGGESTED_CHIPS_FRAME = SUGGESTED_ANSWER_CHIP_FRAMING;
