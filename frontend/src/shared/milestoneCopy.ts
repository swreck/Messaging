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
