// Bundle 1A rev7 Pair A — gap-notice-before-build service.
//
// Cowork's Rules 1 and 3 share a behavioral shift: when Maria detects
// that a deliverable needs user data she doesn't have (a display name
// for the email sign-off, Support-category Tier 2 substance for Ch3),
// she asks the user before generating, with one line about why filling
// the gap makes the message stronger. If the user dismisses, the
// deliverable falls through to a graceful default — never a literal
// placeholder string.
//
// This service detects gaps. The action handler in lib/actions.ts
// gates the build_deliverable pipeline on the result; the pipeline
// generation paths read the dismissal flags to choose between
// fall-through-default and substantive-content branches.
//
// Detectors are pure: they take the build context and return whether
// the gap is present. No LLM calls. No DB writes inside the detector.

import {
  GAP_NOTICE_DISPLAY_NAME,
  GAP_NOTICE_DISPLAY_NAME_CHIP_DISMISS,
  GAP_NOTICE_SUPPORT,
  GAP_NOTICE_SUPPORT_CHIP_DISMISS,
} from '../prompts/milestoneCopy.js';

export type GapKey = 'displayName' | 'support';

export interface GapNotice {
  key: GapKey;
  /** The Cowork-locked question Maria asks the user. */
  question: string;
  /** The Cowork-locked dismissal-chip text. */
  dismissChip: string;
  /** Priority: lower numbers fire first (one-gap-per-turn ordering). */
  priority: number;
}

export interface GapNoticeContext {
  /** User.name value (empty string or null when not set). */
  userDisplayName: string | null | undefined;
  /** Medium of the deliverable being built. Lowercase canonical key
   *  (email, landing_page, pitch_deck, etc.). */
  medium: string | null | undefined;
  /** Tier 2 statements from the draft, with their categoryLabel and
   *  whether they have substantive tier3 proof bullets. The detector
   *  reads categoryLabel === 'Support' AND text non-empty AND
   *  tier3BulletCount > 0 to consider Support material substantive. */
  tier2: { categoryLabel: string | null; text: string; tier3BulletCount: number }[];
  /** Per-build dismissal flags persisted on
   *  ExpressJob.interpretation.gapDismissals. Each gap fires at most
   *  once per build; user dismissal sticks for that build. */
  dismissals: Partial<Record<GapKey, boolean>>;
}

/**
 * Detect display-name gap.
 *
 * Triggered when:
 *   - User.name is empty/null
 *   - AND medium is email (the medium with a sign-off requirement
 *     today — landing_page and pitch_deck do not have user-name
 *     sign-offs in the same shape)
 *   - AND not already dismissed for this build
 */
function detectDisplayNameGap(ctx: GapNoticeContext): GapNotice | null {
  if (ctx.dismissals.displayName === true) return null;
  const hasName = typeof ctx.userDisplayName === 'string' && ctx.userDisplayName.trim().length > 0;
  if (hasName) return null;
  const mediumKey = (ctx.medium || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (mediumKey !== 'email') return null;
  return {
    key: 'displayName',
    question: GAP_NOTICE_DISPLAY_NAME,
    dismissChip: GAP_NOTICE_DISPLAY_NAME_CHIP_DISMISS,
    priority: 1,
  };
}

/**
 * Detect Support-gap.
 *
 * Triggered when:
 *   - The draft's Tier 2 has no Support-category statement with
 *     substantive content (non-empty text AND tier3BulletCount > 0)
 *   - AND not already dismissed for this build
 *
 * "Support" here is the Tier 2 categoryLabel that lands Ch3 content
 * in the existing methodology. When source has no substantive Support
 * material, Ch3 has nothing concrete to draw from — that's the gap.
 */
function detectSupportGap(ctx: GapNoticeContext): GapNotice | null {
  if (ctx.dismissals.support === true) return null;
  const supportRows = ctx.tier2.filter(
    t2 => (t2.categoryLabel || '').trim().toLowerCase() === 'support',
  );
  const substantive = supportRows.find(
    t2 => t2.text.trim().length > 0 && t2.tier3BulletCount > 0,
  );
  if (substantive) return null;
  return {
    key: 'support',
    question: GAP_NOTICE_SUPPORT,
    dismissChip: GAP_NOTICE_SUPPORT_CHIP_DISMISS,
    priority: 2,
  };
}

/**
 * Detect all gaps. Returns the highest-priority unfilled, undismissed
 * gap. Caller fires that gap's notice, lets user respond/dismiss, then
 * re-checks on next turn (matches the rev6b enrichment-one-at-a-time
 * pattern; the user gets one focused question per turn).
 *
 * Returns null when no gaps remain.
 */
export function detectNextGap(ctx: GapNoticeContext): GapNotice | null {
  const detectors: Array<(c: GapNoticeContext) => GapNotice | null> = [
    detectDisplayNameGap,
    detectSupportGap,
  ];
  const gaps: GapNotice[] = [];
  for (const detector of detectors) {
    const gap = detector(ctx);
    if (gap) gaps.push(gap);
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a.priority - b.priority);
  return gaps[0];
}
