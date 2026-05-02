// Express Flow — commit + silent pipeline orchestration.
//
// Called from POST /api/express/commit. Takes an approved ExpressInterpretation,
// creates the 2.5 data rows (Offering, OfferingElement, Audience, Priority,
// ThreeTierDraft), then runs the full build pipeline in the background:
//   mapping → Tier 1/2/3 generation → 5CS per-chapter → blend.
// The ExpressJob row tracks progress so the frontend can poll.
//
// This file is purely additive to 2.5. It calls into existing AI helpers and
// prompts but never modifies 2.5 routes or logic. If this file is deleted,
// 2.5 continues working identically.

import { prisma } from './prisma.js';
import { getConsultationLive } from './partnerSettings.js';
import { callAI, callAIWithJSON } from '../services/ai.js';
import { MAPPING_SYSTEM } from '../prompts/mapping.js';
import { CONVERT_LINES_SYSTEM } from '../prompts/generation.js';
import {
  buildChapterPrompt,
  BLEND_SYSTEM,
  JOIN_CHAPTERS_SYSTEM,
  CHAPTER_CRITERIA,
  CHAPTER_NAMES,
} from '../prompts/fiveChapter.js';
import {
  MILESTONE_FOUNDATION_CONFIRMED,
  MILESTONE_CHAPTERS_SEPARATED_READY,
  MILESTONE_CHAPTERS_COMBINED_READY,
  MILESTONE_BLENDED_READY,
  buildSoftNote,
  PAUSE_ON_FOUNDATIONAL_SHIFT,
  buildFoundationalShiftTimeout,
  TIMEOUT_AREA_TIER1,
  TIMEOUT_AREA_TIER2,
  TIMEOUT_AREA_FALLBACK,
  STAGE_CHECKIN_TIER_GENERATION,
  STAGE_CHECKIN_CHAPTERS,
  STAGE_CHECKIN_BLEND,
  FOUNDATIONAL_SHIFT_HOLD_MIDPOINT,
  PAUSE_BEFORE_SOFT_NOTES_MS,
  SOFT_NOTE_STAGGER_MS,
  BLEND_HEARTBEAT,
  BLEND_HEARTBEAT_MS,
  TIER_GENERATION_HEARTBEAT,
  TIER_GENERATION_HEARTBEAT_MS,
  CHAPTERS_HEARTBEAT,
  CHAPTERS_HEARTBEAT_MS,
  buildAutonomousPostDeliveryOffer,
  AUTONOMOUS_POST_DELIVERY_CHIP_YES,
  buildAutonomousPostDeliveryChipNo,
  ENRICHMENT_INTRO,
  AUTONOMOUS_BUILD_COMPLETE,
} from '../prompts/milestoneCopy.js';
import { getMediumSpec } from '../prompts/mediums.js';
import {
  checkStatements,
  checkProse,
  buildViolationFeedback,
  buildProseViolationFeedback,
  type StatementInput,
} from '../services/voiceCheck.js';
import {
  checkChapterFabrication,
  buildFabricationFeedback,
  redactChapterViolations,
} from '../services/fabricationCheck.js';
import {
  checkChapterOneAltitude,
  buildAltitudeFeedback,
  elevateChapterOne,
} from '../services/altitudeCheck.js';
import {
  extractSocialProof,
  groupByType,
  type SocialProofItem,
} from '../services/socialProofExtract.js';
import { classifyClaims } from '../services/provenanceClassify.js';
import { checkFiveChapter, type FiveChapterInput } from '../services/fiveChapterCheck.js';
import type { ExpressInterpretation } from './expressExtraction.js';

// ─── Medium translation ────────────────────────────────
// The extraction prompt uses human-readable medium labels like "talking points".
// The 2.5 FiveChapterStory model uses internal keys like "in_person". Translate.
const MEDIUM_ID_MAP: Record<string, string> = {
  email: 'email',
  'pitch deck': 'pitch_deck',
  'landing page': 'landing_page',
  'blog post': 'blog',
  'press release': 'press_release',
  'talking points': 'in_person',
  newsletter: 'newsletter',
  'one-pager': 'landing_page', // Closest 2.5 format for a concise leave-behind
  report: 'report',
};

function pickInternalMedium(extractedMedium: string): string {
  return MEDIUM_ID_MAP[extractedMedium] || 'email';
}

// ─── Phase 2 helpers — milestone narration, soft notes, shift pause ──
//
// These helpers are used by both the autonomous pipeline (runPipeline) and
// the guided pipeline (runDraftPipeline) so the user-facing chat behavior
// is identical regardless of which path produced the deliverable. All
// user-facing strings come from prompts/milestoneCopy.ts — the wording is
// Cowork-authored and never composed in this file.

interface PartnerCtx {
  storyId?: string;
  draftId?: string;
  audienceId?: string;
  offeringId?: string;
}

function buildPartnerContext(workspaceId: string, ctx: PartnerCtx, kind?: string): Record<string, string> {
  const out: Record<string, string> = { channel: 'partner', workspaceId };
  if (ctx.storyId) out.storyId = ctx.storyId;
  if (ctx.draftId) out.draftId = ctx.draftId;
  if (ctx.audienceId) out.audienceId = ctx.audienceId;
  if (ctx.offeringId) out.offeringId = ctx.offeringId;
  if (kind) out.kind = kind;
  return out;
}

// Write an assistant message into the persistent partner conversation.
// Used for milestone narrations, soft notes, the foundational-shift pause
// message, and toggle confirmations written by the pipeline. Fail-open so
// pipeline progress is never blocked by a chat-write hiccup.
async function writeMariaMessage(opts: {
  userId: string;
  workspaceId: string;
  ctx: PartnerCtx;
  content: string;
  kind?: string;
}): Promise<void> {
  try {
    await prisma.assistantMessage.create({
      data: {
        userId: opts.userId,
        role: 'assistant',
        content: opts.content,
        context: buildPartnerContext(opts.workspaceId, opts.ctx, opts.kind),
      },
    });
  } catch (err) {
    console.error('[ExpressPipeline] writeMariaMessage failed (fail-open):', err);
  }
}

// Path-architecture refactor — Phase 2, Redline #3. Live read of the
// "Let Maria lead" toggle BEFORE each milestone narration. Flipping the
// toggle mid-pipeline takes effect on the next milestone — the toggle is
// a live promise, not a snapshot at job start.
async function narrateMilestoneIfPathB(opts: {
  userId: string;
  workspaceId: string;
  ctx: PartnerCtx;
  milestone:
    | typeof MILESTONE_FOUNDATION_CONFIRMED
    | typeof MILESTONE_CHAPTERS_SEPARATED_READY
    | typeof MILESTONE_CHAPTERS_COMBINED_READY
    | typeof MILESTONE_BLENDED_READY;
}): Promise<void> {
  try {
    const consultation = await getConsultationLive(opts.userId);
    if (consultation !== 'on') return;
  } catch (err) {
    console.error('[ExpressPipeline] consultation read failed (fail-closed, no narration):', err);
    return;
  }
  await writeMariaMessage({
    userId: opts.userId,
    workspaceId: opts.workspaceId,
    ctx: opts.ctx,
    content: opts.milestone,
    kind: 'milestone-narration',
  });
}

// Round 3 fix — convert verb-form / instruction descriptors into
// noun-phrase form so they slot grammatically after "with" in the
// soft-note template. Existing noun-form descriptors (e.g. "the typical
// engagement length") pass through unchanged. Patterns the regex doesn't
// catch are logged server-side so Cowork can extend the set over time.
const KNOWN_NOUN_FORM_PREFIXES = /^(the|a|an|any|your|our|some|two|three|several|specific|named|measurable|approximate|exact)\s/i;
function normalizeMissingPieceDescriptor(raw: string): string {
  const original = raw.trim();
  let s = original;
  s = s.replace(/^name\s+(?=[a-z\d])/i, 'names of ');
  s = s.replace(/^list\s+(?=[a-z\d])/i, 'a list of ');
  s = s.replace(/^tell (us|me) (about |your )?/i, '');
  s = s.replace(/^give (us|me) (the |a |an |your )?/i, '');
  s = s.replace(/^share (the |a |an |your )?/i, '');
  s = s.replace(/^provide (the |a |an |your )?/i, '');
  s = s.replace(/^add (the |a |an |your )?/i, '');
  s = s.replace(/^include (the |a |an |your )?/i, '');
  if (s === original && !KNOWN_NOUN_FORM_PREFIXES.test(s)) {
    console.log(`[ExpressPipeline] missing-piece descriptor passed through unchanged (flag for Cowork): ${JSON.stringify(original)}`);
  }
  return s;
}

// Round 2 fix — extract [INSERT: <description>] markers from chapter
// content, return the descriptions (user-facing missing-piece labels) plus
// the chapter content with marker-bearing sentences stripped. The chapter
// generators emit markers as a classifier signal; the descriptions feed
// the soft-note system, and the stripped prose is what goes into join +
// blend. Net effect: blendedText has zero brackets, and missing-fact
// metadata reaches the chat as soft notes.
function extractAndStripMarkers(content: string): {
  cleanContent: string;
  missingPieces: string[];
} {
  const missingPieces: string[] = [];
  const markerRe = /\[INSERT:\s*([^\]\n]+?)\s*\]/g;
  let mm: RegExpExecArray | null;
  while ((mm = markerRe.exec(content)) !== null) {
    const desc = mm[1].trim();
    if (desc) missingPieces.push(normalizeMissingPieceDescriptor(desc));
  }
  if (missingPieces.length === 0) {
    return { cleanContent: content, missingPieces };
  }
  // Remove every sentence containing a marker, then collapse the residual
  // whitespace. Sentence boundary = `.`, `!`, or `?` followed by space or
  // line break, plus paragraph boundaries. The conservative approach is to
  // walk paragraphs and rebuild without marker-bearing sentences.
  const paragraphs = content.split(/\n{2,}/);
  const cleanedParagraphs = paragraphs
    .map(par => {
      // Split paragraph into sentences. Keep terminator with sentence so we
      // can reassemble cleanly.
      const sentenceRe = /[^.!?]+[.!?]+["')\]]?\s*|\S[^.!?\n]*$/g;
      const sentences = par.match(sentenceRe) || [par];
      const kept = sentences.filter(s => !/\[INSERT:/.test(s));
      return kept.join('').trim();
    })
    .filter(par => par.length > 0);
  const cleanContent = cleanedParagraphs.join('\n\n').trim();
  return { cleanContent, missingPieces };
}

// Round 3 fix — stage-aware presence check-ins. Each pipeline stage
// (tier_generation, chapters, blend) sets a 30-second timer when it
// begins. If the timer fires before the stage's completion milestone
// lands, the corresponding locked Maria-voice check-in is written to
// chat (kind: 'stage-checkin'). Each check-in fires at most once per
// pipeline run per stage, even across foundational-shift regen cycles.
// Path B only — gated by live consultation read, same pattern as
// milestone narrations. Path A stays silent.
// Round 3.1 Item 3 — added 'blend-heartbeat' as a separate flag so the
// 60s blend heartbeat fires independently of the 30s blend stage
// check-in. Both can land in a single long blend run; both are at-most
// once per pipeline.
// Round 3.3 Item 1 — extended the heartbeat pattern to tier-generation
// and chapters (90s threshold each). All three heartbeats are flag-
// gated for at-most-once-per-pipeline; the regen cycle does not reset.
type StageCheckinKey =
  | 'tier'
  | 'chapters'
  | 'blend'
  | 'tier-heartbeat'
  | 'chapters-heartbeat'
  | 'blend-heartbeat';
type StageCheckinFlags = Record<StageCheckinKey, boolean>;
function makeStageCheckinFlags(): StageCheckinFlags {
  return {
    tier: false,
    chapters: false,
    blend: false,
    'tier-heartbeat': false,
    'chapters-heartbeat': false,
    'blend-heartbeat': false,
  };
}
function scheduleStageCheckin(opts: {
  stage: StageCheckinKey;
  message: string;
  flags: StageCheckinFlags;
  userId: string;
  workspaceId: string;
  ctx: PartnerCtx;
  // Round 3.1 Item 3 — optional delay override (default 30s for stage
  // check-ins; 60s for the blend heartbeat).
  delayMs?: number;
  // kind override for the assistantMessage row. Default 'stage-checkin';
  // the blend heartbeat uses 'blend-heartbeat' so soft-note routing and
  // any future telemetry can distinguish.
  kind?: string;
}): () => void {
  if (opts.flags[opts.stage]) {
    return () => {};
  }
  const delay = typeof opts.delayMs === 'number' ? opts.delayMs : 30000;
  const writeKind = opts.kind || 'stage-checkin';
  const handle = setTimeout(async () => {
    if (opts.flags[opts.stage]) return;
    try {
      const consultation = await getConsultationLive(opts.userId);
      if (consultation !== 'on') return;
      opts.flags[opts.stage] = true;
      await writeMariaMessage({
        userId: opts.userId,
        workspaceId: opts.workspaceId,
        ctx: opts.ctx,
        content: opts.message,
        kind: writeKind,
      });
    } catch (err) {
      console.error('[ExpressPipeline] stage-checkin write failed:', err);
    }
  }, delay);
  return () => clearTimeout(handle);
}

// Soft-note routing — Round 2 (unified template). After
// MILESTONE_BLENDED_READY fires, emit one buildSoftNote per chapter that
// has any gap. Empty case (whole chapter missing per tier-level rules):
// pass missingPieces=[] so the template uses EMPTY_CASE_FILL. Partial case
// (chapter exists but content gaps): pass extracted marker descriptions.
// Soft notes go to chat ONLY — never appended to blendedText. Fires
// regardless of toggle state: the user needs to know what's missing
// whether Maria is leading or quiet.
async function emitChapterSoftNotes(opts: {
  userId: string;
  workspaceId: string;
  ctx: PartnerCtx;
  wholeChapterEmpty: Set<3 | 4 | 5>;
  chapterMissingPieces: Record<3 | 4 | 5, string[]>;
}): Promise<void> {
  // Round 4 Fix 7 — assemble the soft notes that need to fire BEFORE
  // sleeping, so we can short-circuit the whole pause when there are
  // none. No work, no delay.
  // Round 3.4 Bug 4 — order chapters by methodology importance: 3 (ROI,
  // most-quantitative substance) → 4 (named customer evidence) → 5
  // (CTA). When a chapter is wholly empty, that ranks above a partial-
  // gap chapter at the same level. Within ties, lower chapter number
  // wins so the conversational flow tracks the reader's experience.
  const allGaps: { chapter: 3 | 4 | 5; text: string; isWhole: boolean }[] = [];
  for (const chapter of [3, 4, 5] as const) {
    const isEmpty = opts.wholeChapterEmpty.has(chapter);
    const pieces = opts.chapterMissingPieces[chapter] || [];
    if (!isEmpty && pieces.length === 0) continue;
    allGaps.push({
      chapter,
      text: buildSoftNote(chapter, isEmpty ? [] : pieces),
      isWhole: isEmpty,
    });
  }
  if (allGaps.length === 0) return;
  allGaps.sort((a, b) => {
    if (a.isWhole !== b.isWhole) return a.isWhole ? -1 : 1;
    return a.chapter - b.chapter;
  });

  // Round 4 Fix 7 — give MILESTONE_BLENDED_READY breathing room before
  // the first soft note fires. Without the pause, "Take a look" and the
  // gap notices arrive in the same bubble cluster and undercut each
  // other.
  await new Promise(r => setTimeout(r, PAUSE_BEFORE_SOFT_NOTES_MS));

  // Round 3.4 Bug 4 — fire ONLY the most-important gap question now,
  // prefaced with ENRICHMENT_INTRO when there's more than one gap. The
  // remaining gaps persist as User.settings.pendingEnrichmentGaps and
  // surface one-at-a-time in subsequent partner-chat replies via the
  // injection in partner.ts. Cowork's acceptance: "second question fires
  // next turn, not in the same turn."
  const firstGap = allGaps[0];
  const remaining = allGaps.slice(1);
  const introPrefix = allGaps.length > 1 ? `${ENRICHMENT_INTRO}\n\n` : '';
  await writeMariaMessage({
    userId: opts.userId,
    workspaceId: opts.workspaceId,
    ctx: opts.ctx,
    content: `${introPrefix}${firstGap.text}`,
    kind: 'soft-note',
  });

  // Persist the remaining ranked gaps. Stored as a list so the partner
  // route can pop the head, fire it after the user's next reply, and
  // re-write the tail until the queue is empty. Schema-light — uses
  // User.settings JSON to avoid a Prisma migration in this checkpoint.
  if (remaining.length > 0) {
    try {
      const user = await prisma.user.findUnique({
        where: { id: opts.userId },
        select: { settings: true },
      });
      const settings = (user?.settings as Record<string, any>) || {};
      settings.pendingEnrichmentGaps = remaining.map(g => ({
        chapter: g.chapter,
        text: g.text,
      }));
      await prisma.user.update({
        where: { id: opts.userId },
        data: { settings },
      });
    } catch (err) {
      console.error('[ExpressPipeline] persist pendingEnrichmentGaps failed:', err);
    }
  }
}

// Foundational-shift pause (Redline #4). Polls User.settings.pendingFoundationalShift
// for a fresh entry that landed during this pipeline run. If detected:
// (a) writes PAUSE_ON_FOUNDATIONAL_SHIFT to chat once per pipeline,
// (b) waits for the pending shift to clear (user resolved via existing
//     APPLY_FOUNDATIONAL_SHIFT chat marker — that handler clears the flag
//     and applies the tier update),
// (c) returns 'regenerate-chapters' if the resolution actually changed the
//     Tier 1 text since the pipeline started (caller restarts chapter loop),
//     'continue' if the user declined or the tier didn't change,
//     'timeout' if no resolution arrived inside the wait window.
//
// Cosmetic edits (no pending shift) return 'continue' immediately; the
// pipeline proceeds normally.
type ShiftPauseAction = 'continue' | 'regenerate-chapters' | 'timeout';
interface ShiftPauseResult {
  action: ShiftPauseAction;
  // Populated whenever a pending shift was detected (regenerate-chapters or
  // timeout outcomes). Mirrors the foundationalShift classifier's targetCell:
  // "tier1" | "tier2-N" | "none" — caller maps to TIMEOUT_AREA_*.
  targetCell?: string;
}

// Map a foundational-shift targetCell to the locked timeout-area constant
// used by buildFoundationalShiftTimeout. The classifier's outputs today are
// "tier1" | "tier2-N" | "none". TIMEOUT_AREA_AUDIENCE / TIMEOUT_AREA_OFFERING
// constants exist in milestoneCopy.ts for forward-compat — this mapping
// falls those cases through to TIMEOUT_AREA_FALLBACK because the current
// pause path only fires from chapter edits.
function timeoutAreaForTargetCell(targetCell?: string): string {
  if (targetCell === 'tier1') return TIMEOUT_AREA_TIER1;
  if (targetCell && targetCell.startsWith('tier2')) return TIMEOUT_AREA_TIER2;
  return TIMEOUT_AREA_FALLBACK;
}

async function checkFoundationalShiftPause(opts: {
  jobId: string;
  userId: string;
  workspaceId: string;
  ctx: PartnerCtx;
  draftId: string;
  pipelineStartMs: number;
  pauseFlag: { value: boolean };
  initialTier1Text: string;
  updateStage: (stage: string) => Promise<void>;
}): Promise<ShiftPauseResult> {
  // Fast read — most boundaries have no pending shift.
  const userRow = await prisma.user.findUnique({
    where: { id: opts.userId },
    select: { settings: true },
  });
  const settings = (userRow?.settings as Record<string, any>) || {};
  const pending = settings.pendingFoundationalShift as
    | { draftId?: string; setAt?: string; targetCell?: string }
    | undefined;
  if (!pending || !pending.setAt || !pending.draftId) return { action: 'continue' };
  if (pending.draftId !== opts.draftId) return { action: 'continue' };
  const setAtMs = new Date(pending.setAt).getTime();
  if (isNaN(setAtMs) || setAtMs < opts.pipelineStartMs) return { action: 'continue' };

  const detectedTargetCell = pending.targetCell;

  // Pending shift detected on THIS draft, fresh since pipeline start.
  // Send the locked pause copy to chat exactly once, regardless of toggle —
  // the user has just edited; they need to know we're holding off.
  if (!opts.pauseFlag.value) {
    opts.pauseFlag.value = true;
    await writeMariaMessage({
      userId: opts.userId,
      workspaceId: opts.workspaceId,
      ctx: opts.ctx,
      content: PAUSE_ON_FOUNDATIONAL_SHIFT,
      kind: 'pause-narration',
    });
    await opts.updateStage('Holding for the foundation update');
  }

  // Round 3 fix — poll for resolution every 3s, max 3 minutes (was 5).
  // At the 90s midpoint, write FOUNDATIONAL_SHIFT_HOLD_MIDPOINT to chat
  // once so the user sees Maria is still holding rather than staring at
  // silence. Three messages over three minutes — pause at 0s, midpoint
  // at 90s, timeout at 180s.
  const POLL_INTERVAL_MS = 3000;
  const MAX_WAIT_MS = 3 * 60 * 1000;
  const MIDPOINT_MS = 90 * 1000;
  const waitStart = Date.now();
  let midpointFired = false;
  while (Date.now() - waitStart < MAX_WAIT_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    if (!midpointFired && Date.now() - waitStart >= MIDPOINT_MS) {
      midpointFired = true;
      await writeMariaMessage({
        userId: opts.userId,
        workspaceId: opts.workspaceId,
        ctx: opts.ctx,
        content: FOUNDATIONAL_SHIFT_HOLD_MIDPOINT,
        kind: 'pause-midpoint',
      });
    }
    const fresh = await prisma.user.findUnique({
      where: { id: opts.userId },
      select: { settings: true },
    });
    const freshSettings = (fresh?.settings as Record<string, any>) || {};
    const stillPending = freshSettings.pendingFoundationalShift as
      | { draftId?: string; setAt?: string; targetCell?: string }
      | undefined;
    if (!stillPending || stillPending.draftId !== opts.draftId) {
      // Resolved. Determine whether the tier text actually changed.
      const tier1Now = await prisma.tier1Statement.findFirst({
        where: { draftId: opts.draftId },
        select: { text: true },
      });
      if (tier1Now && tier1Now.text !== opts.initialTier1Text) {
        return { action: 'regenerate-chapters', targetCell: detectedTargetCell };
      }
      return { action: 'continue' };
    }
  }
  return { action: 'timeout', targetCell: detectedTargetCell };
}

// Missing-chapter detection. Returns the list of chapters with no source
// content backing them. Mirrors the per-chapter guardrail logic already in
// the pipeline so the user-facing soft notes line up with the silent
// guardrails underneath.
function detectMissingChaptersFromTier(opts: {
  hasSupportColumn: boolean;
  hasSocialProofColumn: boolean;
  namedCustomerCount: number;
  otherNamedSpecificCount: number;
  hasMeaningfulCta: boolean;
}): Array<3 | 4 | 5> {
  const missing: Array<3 | 4 | 5> = [];
  if (!opts.hasSupportColumn) missing.push(3);
  if (
    !opts.hasSocialProofColumn &&
    opts.namedCustomerCount === 0 &&
    opts.otherNamedSpecificCount === 0
  ) {
    missing.push(4);
  }
  if (!opts.hasMeaningfulCta) missing.push(5);
  return missing;
}

// ─── Commit: interpretation → DB rows ─────────────────
export interface CommitResult {
  jobId: string;
  draftId: string;
  offeringId: string;
  audienceId: string;
  variantCount: number;
}

export async function commitInterpretation(
  interpretation: ExpressInterpretation,
  userId: string,
  workspaceId: string,
): Promise<CommitResult> {
  if (!interpretation.audiences || interpretation.audiences.length === 0) {
    throw new Error('Express interpretation needs at least one audience.');
  }

  const cleanedDifferentiators = interpretation.offering.differentiators
    .map(d => ({ text: d.text.trim(), source: d.source }))
    .filter(d => d.text.length > 0);

  if (cleanedDifferentiators.length === 0) {
    throw new Error('Interpretation needs at least one differentiator.');
  }

  // Clean each audience's priorities in parallel. Reject audiences that have
  // zero valid priorities after trim — they cannot drive a Three Tier.
  const cleanedAudiences = interpretation.audiences
    .map(a => ({
      raw: a,
      cleanedPriorities: a.priorities
        .map(p => ({ text: p.text.trim(), source: p.source }))
        .filter(p => p.text.length > 0),
    }))
    .filter(a => a.cleanedPriorities.length > 0);

  if (cleanedAudiences.length === 0) {
    throw new Error('Interpretation needs at least one audience with priorities.');
  }

  // Single Offering shared across every audience variant.
  const offering = await prisma.offering.create({
    data: {
      userId,
      workspaceId,
      name: interpretation.offering.name.trim() || 'My offering',
      description: interpretation.offering.description.trim(),
      elements: {
        create: cleanedDifferentiators.map((d, i) => ({
          text: d.text,
          source: d.source === 'stated' ? 'manual' : 'ai_extracted',
          sortOrder: i,
        })),
      },
    },
    include: { elements: true },
  });

  // One Audience + ThreeTierDraft per variant. Drafts land at Step 5 since
  // the silent pipeline will fill the whole table. Draft IDs are collected
  // in audience order so the pipeline can iterate variants deterministically.
  const draftIds: string[] = [];
  let primaryAudienceId = '';
  for (const { raw: aud, cleanedPriorities } of cleanedAudiences) {
    const audience = await prisma.audience.create({
      data: {
        userId,
        workspaceId,
        name: aud.name.trim() || 'My audience',
        description: aud.description.trim(),
        priorities: {
          create: cleanedPriorities.map((p, i) => ({
            text: p.text,
            rank: i + 1,
            sortOrder: i,
          })),
        },
      },
    });
    const draft = await prisma.threeTierDraft.create({
      data: {
        offeringId: offering.id,
        audienceId: audience.id,
        currentStep: 5,
      },
    });
    draftIds.push(draft.id);
    if (!primaryAudienceId) primaryAudienceId = audience.id;
  }

  // Job record — primary draft + explicit variant list (null when single).
  const job = await prisma.expressJob.create({
    data: {
      userId,
      workspaceId,
      draftId: draftIds[0],
      status: 'pending',
      stage: 'Setting things up',
      progress: 3,
      interpretation: interpretation as unknown as object,
      variantDraftIds: draftIds.length > 1 ? (draftIds as unknown as object) : undefined,
    },
  });

  return {
    jobId: job.id,
    draftId: draftIds[0],
    offeringId: offering.id,
    audienceId: primaryAudienceId,
    variantCount: draftIds.length,
  };
}

// ─── Commit for wizard (no async pipeline) ─────────────
// Used when the user clicks "Take me through it step by step instead" on the
// Interpretation preview. Creates the same Offering + Audience + Priorities +
// ThreeTierDraft rows as commitInterpretation but without creating an
// ExpressJob or firing the silent pipeline. The draft lands at Step 4
// (Build Message) since the interpretation has already collected everything
// Steps 1-3 would ask for. The user can still navigate backward from there.
export interface WizardCommitResult {
  draftId: string;
  offeringId: string;
  audienceId: string;
}

export async function commitInterpretationForWizard(
  interpretation: ExpressInterpretation,
  userId: string,
  workspaceId: string,
): Promise<WizardCommitResult> {
  const primaryAudience = interpretation.audiences[0];
  if (!primaryAudience) {
    throw new Error('Interpretation needs at least one audience.');
  }

  const cleanedDifferentiators = interpretation.offering.differentiators
    .map(d => ({ text: d.text.trim(), source: d.source }))
    .filter(d => d.text.length > 0);

  const cleanedPriorities = primaryAudience.priorities
    .map(p => ({ text: p.text.trim(), source: p.source }))
    .filter(p => p.text.length > 0);

  if (cleanedDifferentiators.length === 0) {
    throw new Error('Interpretation needs at least one differentiator.');
  }
  if (cleanedPriorities.length === 0) {
    throw new Error('Interpretation needs at least one priority.');
  }

  const offering = await prisma.offering.create({
    data: {
      userId,
      workspaceId,
      name: interpretation.offering.name.trim() || 'My offering',
      description: interpretation.offering.description.trim(),
      elements: {
        create: cleanedDifferentiators.map((d, i) => ({
          text: d.text,
          source: d.source === 'stated' ? 'manual' : 'ai_extracted',
          sortOrder: i,
        })),
      },
    },
  });

  const audience = await prisma.audience.create({
    data: {
      userId,
      workspaceId,
      name: primaryAudience.name.trim() || 'My audience',
      description: primaryAudience.description.trim(),
      priorities: {
        create: cleanedPriorities.map((p, i) => ({
          text: p.text,
          rank: i + 1,
          sortOrder: i,
        })),
      },
    },
  });

  // Start the user at Step 4 — offering, audience, and priorities are already
  // captured by the interpretation, so Steps 1-3 become review screens the
  // user can navigate backward into if they want to revise. Step 4 is where
  // actual new work (mapping priorities to capabilities) begins.
  const draft = await prisma.threeTierDraft.create({
    data: {
      offeringId: offering.id,
      audienceId: audience.id,
      currentStep: 4,
    },
  });

  return {
    draftId: draft.id,
    offeringId: offering.id,
    audienceId: audience.id,
  };
}

// ─── Commit from existing data (partner chat build_deliverable) ──
// Used when Maria's partner chat triggers a full pipeline from an offering
// and audience that already exist in the DB. Unlike commitInterpretation
// (which creates new DB rows from an extraction), this creates only the
// ThreeTierDraft + ExpressJob pointing at EXISTING offering/audience IDs.
// The pipeline then loads everything through the draft's relations.
export interface ExistingCommitResult {
  jobId: string;
  draftId: string;
}

export async function commitExistingForPipeline(
  offeringId: string,
  audienceId: string,
  medium: string,
  situation: string,
  userId: string,
  workspaceId: string,
): Promise<ExistingCommitResult> {
  const offering = await prisma.offering.findFirst({
    where: { id: offeringId },
    include: { elements: { orderBy: { sortOrder: 'asc' } } },
  });
  if (!offering) throw new Error('Offering not found.');

  const audience = await prisma.audience.findFirst({
    where: { id: audienceId },
    include: { priorities: { orderBy: { sortOrder: 'asc' } } },
  });
  if (!audience) throw new Error('Audience not found.');

  if (offering.elements.length === 0) {
    throw new Error('Offering needs at least one capability before building a deliverable.');
  }
  if (audience.priorities.length === 0) {
    throw new Error('Audience needs at least one priority before building a deliverable.');
  }

  const draft = await prisma.threeTierDraft.create({
    data: {
      offeringId: offering.id,
      audienceId: audience.id,
      currentStep: 5,
    },
  });

  // Synthesize an ExpressInterpretation from the existing DB data so the
  // pipeline can use situation/medium/offering metadata without changes.
  const syntheticInterpretation = {
    offering: {
      name: offering.name,
      nameSource: 'stated' as const,
      description: offering.description || '',
      differentiators: offering.elements.map(e => ({
        text: e.text,
        source: 'stated' as const,
      })),
    },
    audiences: [{
      name: audience.name,
      description: audience.description || '',
      source: 'stated' as const,
      priorities: audience.priorities.map(p => ({
        text: p.text,
        source: 'stated' as const,
      })),
    }],
    primaryMedium: {
      value: medium || 'email',
      source: 'stated' as const,
      reasoning: 'User-selected format',
    },
    situation: situation || '',
    confidenceNotes: 'Built from existing offering and audience data.',
  };

  const job = await prisma.expressJob.create({
    data: {
      userId,
      workspaceId,
      draftId: draft.id,
      status: 'pending',
      stage: 'Setting things up',
      progress: 3,
      interpretation: syntheticInterpretation as unknown as object,
    },
  });

  return { jobId: job.id, draftId: draft.id };
}

// ─── Async pipeline runner ─────────────────────────────
// Fire-and-forget from the commit route via setImmediate(() => runPipeline(jobId)).
// Updates the ExpressJob row as it progresses so the frontend can poll status.
export async function runPipeline(jobId: string): Promise<void> {
  async function update(data: Partial<{
    status: string;
    stage: string;
    progress: number;
    error: string;
    resultStoryId: string;
  }>) {
    try {
      await prisma.expressJob.update({ where: { id: jobId }, data });
    } catch (err) {
      console.error(`[ExpressPipeline] ${jobId} failed to update job:`, err);
    }
  }

  async function fail(message: string) {
    console.error(`[ExpressPipeline] ${jobId} ${message}`);
    await update({
      status: 'error',
      error: message,
      stage: 'Something went wrong. You can try again.',
    });
  }

  try {
    const job = await prisma.expressJob.findUnique({ where: { id: jobId } });
    if (!job || !job.draftId) {
      await fail('Job or draft not found.');
      return;
    }

    const interpretation = job.interpretation as unknown as ExpressInterpretation;

    // Multi-audience variants. When the interpretation returned 2+ audiences,
    // commitInterpretation stored the full ordered list of draft IDs in
    // job.variantDraftIds. The pipeline then runs the whole mapping → tier →
    // story → blend flow once per draft, collecting one FiveChapterStory per
    // audience. The primary story (first audience) lands at resultStoryId so
    // single-variant behavior is unchanged for existing frontends.
    const variantDraftIds: string[] = Array.isArray(job.variantDraftIds)
      ? (job.variantDraftIds as unknown as string[])
      : [job.draftId];
    const variantCount = variantDraftIds.length;
    const storyIds: string[] = [];

    // Phase 2 — userId + workspaceId for milestone narration writes. Both
    // are guaranteed by the ExpressJob row.
    const pipelineUserId = job.userId;
    const pipelineWorkspaceId = job.workspaceId;
    const pipelineStartMs = Date.now();
    // One-shot pause-narration flag per pipeline run. The PAUSE_ON_FOUNDATIONAL_SHIFT
    // message fires at most once even if the user makes multiple foundation-changing
    // edits during the run.
    const shiftPauseFlag = { value: false };
    // Round 3 fix — per-pipeline stage-checkin flags. Each stage's check-in
    // fires at most once per pipeline run, even across regen cycles.
    const stageCheckinFlags = makeStageCheckinFlags();

    for (let variantIndex = 0; variantIndex < variantCount; variantIndex++) {
      const currentDraftId = variantDraftIds[variantIndex];

      // Scale per-variant progress into an even slot between 3 and 98.
      // Existing hardcoded progress values range from 10 (mapping start) to
      // 92 (pre-blend) and are treated as percentages inside the slot. The
      // outer-loop "First draft ready / 100" is written after the loop.
      const slotStart = 3 + Math.floor((variantIndex / variantCount) * 95);
      const slotEnd = 3 + Math.floor(((variantIndex + 1) / variantCount) * 95);
      const scaledProgress = (p: number): number => {
        const local = Math.max(0, Math.min(1, (p - 3) / (95 - 3)));
        return Math.round(slotStart + local * (slotEnd - slotStart));
      };
      const variantStageSuffix =
        variantCount > 1 ? ` (variant ${variantIndex + 1} of ${variantCount})` : '';

    // ─── Stage 1: Mapping ─────────────────────────────
    await update({
      status: 'mapping',
      stage: `Reading between the lines${variantStageSuffix}`,
      progress: scaledProgress(10),
    });
    // Round 3.2 Item 2 — perf logging. Marks the start of each stage so
    // Railway logs capture distributions across users + autonomous-vs-
    // guided runtimes. Format is grep-friendly: `[Perf] jobId=X stage=Y
    // elapsed_ms=Z mode=guided|autonomous variant=N`.
    const interpForPerf = (interpretation as unknown as Record<string, any>) || {};
    const pipelinePerfMode = interpForPerf.autonomousMode === true ? 'autonomous' : 'guided';
    console.log(`[Perf] jobId=${jobId} stage=mapping-start elapsed_ms=${Date.now() - pipelineStartMs} mode=${pipelinePerfMode} variant=${variantIndex + 1}/${variantCount}`);

    const draftWithElements = await prisma.threeTierDraft.findFirst({
      where: { id: currentDraftId },
      include: {
        offering: { include: { elements: { orderBy: { sortOrder: 'asc' } } } },
        audience: { include: { priorities: { orderBy: { sortOrder: 'asc' } } } },
      },
    });
    if (!draftWithElements) {
      await fail('Draft vanished before mapping step.');
      return;
    }

    const mappingMessage = `PRIORITIES (ranked by importance):
${draftWithElements.audience.priorities
  .map(p => `- [ID: ${p.id}] [Rank ${p.rank}] "${p.text}"`)
  .join('\n')}

CAPABILITIES/DIFFERENTIATORS:
${draftWithElements.offering.elements
  .map(e => `- [ID: ${e.id}] "${e.text}"`)
  .join('\n')}`;

    type MappingResult = {
      mappings: {
        priorityId: string;
        elementId: string;
        confidence: number;
        strengthSignal?: 'STRONG' | 'HONEST_BUT_THIN' | 'EXAGGERATED' | null;
        failurePattern?: string | null;
        reasoning?: string;
        mfRationale?: string;
      }[];
      orphanElements?: string[];
      priorityGaps?: string[];
      gapDescriptions?: { priorityId: string; missingCapability: string }[];
      noStrongPairings?: boolean;
    };

    const mappingResult = await callAIWithJSON<MappingResult>(
      MAPPING_SYSTEM,
      mappingMessage,
      'fast',
    );

    const validPriorityIds = new Set(
      draftWithElements.audience.priorities.map(p => p.id),
    );
    const validElementIds = new Set(
      draftWithElements.offering.elements.map(e => e.id),
    );
    const cleanMappings = (mappingResult.mappings || []).filter(
      m => validPriorityIds.has(m.priorityId) && validElementIds.has(m.elementId),
    );

    // Capture gap descriptions whose priorityIds are valid — Maria uses these
    // to interview the user for missing differentiators when Tier 1 can't
    // cleanly resolve the audience's decision-question.
    const validGapDescriptions = (mappingResult.gapDescriptions || []).filter(
      g => validPriorityIds.has(g.priorityId) && g.missingCapability,
    );

    // Audience-fit signal (Change 2): the model emits noStrongPairings=true when
    // every emitted pairing is HONEST_BUT_THIN or EXAGGERATED — none directly
    // resolves the audience's priorities. We also compute it locally as a fallback
    // in case the model omits the flag. Maria uses this downstream to fire the
    // humble-curiosity audience-fit conversation.
    const computedNoStrong = !cleanMappings.some(m => m.strengthSignal === 'STRONG');
    const noStrongPairings = mappingResult.noStrongPairings === undefined
      ? computedNoStrong
      : Boolean(mappingResult.noStrongPairings);
    await prisma.threeTierDraft.update({
      where: { id: draftWithElements.id },
      data: { noStrongPairings },
    });

    // The mapping prompt tells the model not to emit below 0.4 (post Change 2).
    // This floor stays at 0.5 as a safety net for the case where the model emits
    // a weak match anyway — we'd rather show a weak Tier 1 plus Maria's gap
    // interview than strip Rank 1 entirely and build Tier 1 from Rank 2.
    // EXAGGERATED mappings (caught failure patterns) are NOT stored as confirmed —
    // they flow through gapDescriptions to the resolution loop, like before.
    for (const m of cleanMappings.filter(
      m => m.confidence >= 0.5 && m.strengthSignal !== 'EXAGGERATED',
    )) {
      await prisma.mapping.create({
        data: {
          draftId: draftWithElements.id,
          priorityId: m.priorityId,
          elementId: m.elementId,
          confidence: m.confidence,
          status: 'confirmed',
          mfRationale: m.mfRationale || '',
          strengthSignal: m.strengthSignal || null,
          failurePattern: m.failurePattern || null,
        },
      });
    }

    // ─── Stage 2: Three Tier generation ──────────────
    await update({
      status: 'tier_generation',
      stage: `Shaping the Three Tier message${variantStageSuffix}`,
      progress: scaledProgress(25),
    });
    console.log(`[Perf] jobId=${jobId} stage=tier-generation-start elapsed_ms=${Date.now() - pipelineStartMs} mode=${pipelinePerfMode} variant=${variantIndex + 1}/${variantCount}`);

    const cancelTierCheckin = scheduleStageCheckin({
      stage: 'tier',
      message: STAGE_CHECKIN_TIER_GENERATION,
      flags: stageCheckinFlags,
      userId: pipelineUserId,
      workspaceId: pipelineWorkspaceId,
      ctx: {
        draftId: draftWithElements.id,
        offeringId: draftWithElements.offering.id,
        audienceId: draftWithElements.audience.id,
      },
    });
    // Round 3.3 Item 1 — tier-generation heartbeat. Fires once at the
    // 90s threshold if tier generation is still running. Same pattern
    // as BLEND_HEARTBEAT.
    const cancelTierHeartbeat = scheduleStageCheckin({
      stage: 'tier-heartbeat',
      message: TIER_GENERATION_HEARTBEAT,
      flags: stageCheckinFlags,
      userId: pipelineUserId,
      workspaceId: pipelineWorkspaceId,
      ctx: {
        draftId: draftWithElements.id,
        offeringId: draftWithElements.offering.id,
        audienceId: draftWithElements.audience.id,
      },
      delayMs: TIER_GENERATION_HEARTBEAT_MS,
      kind: 'tier-heartbeat',
    });

    const confirmedMappings = await prisma.mapping.findMany({
      where: { draftId: draftWithElements.id, status: 'confirmed' },
      include: { priority: true, element: true },
    });

    if (confirmedMappings.length === 0) {
      await fail('No confirmed mappings could be generated. Try editing the interpretation.');
      return;
    }

    const byPriority = new Map<
      string,
      { priority: typeof confirmedMappings[0]['priority']; elements: typeof confirmedMappings[0]['element'][] }
    >();
    for (const m of confirmedMappings) {
      if (!byPriority.has(m.priorityId)) {
        byPriority.set(m.priorityId, { priority: m.priority, elements: [] });
      }
      byPriority.get(m.priorityId)!.elements.push(m.element);
    }

    const mappedElementIds = new Set(confirmedMappings.map(m => m.elementId));
    const orphanElements = draftWithElements.offering.elements.filter(
      e => !mappedElementIds.has(e.id),
    );

    const convertMessage = `CONFIRMED MAPPINGS (grouped by priority, in rank order):
${draftWithElements.audience.priorities
  .filter(p => byPriority.has(p.id))
  .map(p => {
    const group = byPriority.get(p.id)!;
    return `Priority [ID: ${p.id}] [Rank ${p.rank}]: "${p.text}"
  Driver (why this matters to them): ${p.driver || 'not specified'}
  Mapped capabilities: ${group.elements.map(e => `"${e.text}"`).join(', ')}`;
  })
  .join('\n\n')}
${
  orphanElements.length > 0
    ? `\nORPHAN CAPABILITIES (not mapped to any priority — use for Social Proof or Focus columns):\n${orphanElements
        .map(e => `- "${e.text}"`)
        .join('\n')}`
    : ''
}
AUDIENCE: ${draftWithElements.audience.name}`;

    type TierResult = {
      tier1: { text: string; priorityId: string };
      tier2: {
        text: string;
        priorityId?: string;
        categoryLabel: string;
        tier3: string[];
      }[];
    };

    // Voice check with one retry. Matches the 2.5 build-message pattern in
    // backend/src/routes/ai.ts. Fails open on evaluator errors so the pipeline
    // still completes if the checker service hiccups.
    // Capture a non-null alias so the closure keeps TS's narrowing.
    const draftForCheck = draftWithElements;
    async function generateTierWithVoiceCheck(): Promise<TierResult> {
      const first = await callAIWithJSON<TierResult>(
        CONVERT_LINES_SYSTEM,
        convertMessage,
        'elite',
      );
      try {
        const priorityById = new Map(
          draftForCheck.audience.priorities.map(p => [p.id, p]),
        );
        const statements: StatementInput[] = [];
        if (first.tier1?.text) {
          statements.push({
            text: first.tier1.text,
            column: 'Tier 1',
            priorityText: priorityById.get(first.tier1.priorityId)?.text,
          });
        }
        for (const t2 of first.tier2 || []) {
          statements.push({
            text: t2.text,
            column: t2.categoryLabel || '',
            priorityText: t2.priorityId ? priorityById.get(t2.priorityId)?.text : undefined,
          });
        }
        const check = await checkStatements(statements);
        if (!check.passed) {
          console.log(
            `[ExpressPipeline] ${jobId} voice check found ${check.violations.length} tier violations, retrying`,
          );
          const feedback = buildViolationFeedback(check.violations);
          return await callAIWithJSON<TierResult>(
            CONVERT_LINES_SYSTEM,
            convertMessage + feedback,
            'elite',
          );
        }
      } catch (err) {
        console.error(`[ExpressPipeline] ${jobId} voice check error (fail-open):`, err);
      }
      return first;
    }

    const tierResult = await generateTierWithVoiceCheck();

    // Bundle 1A rev3 W1 — Tier 1 market-truth guard wired into the
    // autonomous-build path. The previous local generateTierWithVoiceCheck
    // ran only checkStatements (Tier 2/3 evaluator); it had no Tier 1
    // sentinel and no Opus judge. Cowork's Walk A surfaced "Make the
    // ClarityAudit partnership..." sailing through this path with no
    // Tier 1 check. The shared runTier1MarketTruthGuard helper now runs
    // the same retry budget as routes/ai.ts uses for the guided 3T flow.
    //
    // Bundle 1A rev4 — wrap the guard call in a fail-OPEN try/catch.
    // rev3 introduced a regression where any throw from the guard
    // (callAIWithJSON inside the regenerate closure, the Opus judge
    // call, JSON parse errors on retry) aborted runPipeline before
    // tier1Statement.create at line below — leaving an empty Three
    // Tier and no email. The guard layer is a quality enhancement, not
    // a gate. On any guard failure, log with jobId, KEEP the original
    // tierResult.tier1.text from the initial generateTierWithVoiceCheck,
    // and proceed to persistence. The pipeline must always produce
    // SOME persisted Three Tier even if the guard layer crashes.
    if (tierResult.tier1?.text) {
      const originalTier1Text = tierResult.tier1.text;
      try {
        const { runTier1MarketTruthGuard } = await import(
          '../services/voiceCheck.js'
        );
        tierResult.tier1.text = await runTier1MarketTruthGuard(
          tierResult.tier1.text,
          draftWithElements.offering.name,
          async (feedback) => {
            const regen = await callAIWithJSON<TierResult>(
              CONVERT_LINES_SYSTEM,
              convertMessage + feedback,
              'elite',
            );
            // Replace the WHOLE tierResult so the Tier 2/3 statements stay
            // consistent with the regenerated Tier 1. Without this, the
            // Tier 1 retry would diverge from the Tier 2 columns that
            // reference it.
            if (regen.tier1?.text) tierResult.tier1 = regen.tier1;
            if (regen.tier2) tierResult.tier2 = regen.tier2;
            return regen.tier1?.text || tierResult.tier1.text;
          },
        );
      } catch (guardErr) {
        const errMsg = guardErr instanceof Error ? guardErr.message : String(guardErr);
        const stack = guardErr instanceof Error ? guardErr.stack : '';
        console.error(
          `[ExpressPipeline] ${jobId} Tier1Guard FAIL-OPEN — keeping original Tier 1, proceeding to persistence. Error: ${errMsg}`,
          stack,
        );
        // Restore the original Tier 1 in case a partial regeneration
        // mutated tierResult.tier1.text mid-flight.
        tierResult.tier1.text = originalTier1Text;
      }
    }

    if (tierResult.tier1?.text) {
      await prisma.tier1Statement.create({
        data: { draftId: draftWithElements.id, text: tierResult.tier1.text },
      });
    }

    for (let i = 0; i < (tierResult.tier2 || []).length; i++) {
      const t2 = tierResult.tier2[i];
      const validT2Priority = t2.priorityId && validPriorityIds.has(t2.priorityId)
        ? t2.priorityId
        : null;
      const tier2 = await prisma.tier2Statement.create({
        data: {
          draftId: draftWithElements.id,
          text: t2.text,
          sortOrder: i,
          priorityId: validT2Priority,
          categoryLabel: t2.categoryLabel || '',
        },
      });
      if (Array.isArray(t2.tier3)) {
        for (let j = 0; j < t2.tier3.length; j++) {
          await prisma.tier3Bullet.create({
            data: { tier2Id: tier2.id, text: t2.tier3[j], sortOrder: j },
          });
        }
      }
    }

    await update({ progress: scaledProgress(45) });

    // Capture initial Tier 1 text BEFORE chapter generation so the
    // shift-pause helper can detect whether a mid-pipeline edit actually
    // changed the foundation.
    const initialTier1Text = (
      await prisma.tier1Statement.findFirst({
        where: { draftId: draftWithElements.id },
        select: { text: true },
      })
    )?.text || '';

    // ─── Stage 3: Five Chapter Story ─────────────────
    const mediumKey = pickInternalMedium(interpretation.primaryMedium.value);
    const mediumSpec = getMediumSpec(mediumKey);

    // Build a meaningful customName so multiple Express drafts in the same
    // workspace are distinguishable at a glance in the deliverables list.
    // "Pitch deck · Regional CFO Roundtable" is usable; "Pitch Deck Narrative"
    // repeated six times is not. Prefer a short phrase from the situation,
    // fall back to the medium label + a today's date stamp.
    function buildCustomName(): string {
      const mediumLabel = interpretation.primaryMedium.value || mediumSpec.label;
      const situation = interpretation.situation?.trim() || '';
      if (situation.length > 0) {
        // Strip leading "You need a ..." / "You need to ..." boilerplate so
        // the hint reads as a hook, not a restatement of the Express frame.
        const cleaned = situation
          .replace(/^you (?:need|want|are|have|require) (?:a |an |the |to |some )?/i, '')
          .replace(/^you'?re\s+/i, '');
        // Take the shortest meaningful span — up to the first period, comma,
        // em-dash, or 40 characters.
        const stopMatch = cleaned.match(/^([^.,\u2014—]{5,40})/);
        const snippet = (stopMatch ? stopMatch[1] : cleaned.slice(0, 40)).trim();
        if (snippet.length > 0) {
          // Sentence-case the first letter; keep the rest as extracted.
          const hook = snippet[0].toUpperCase() + snippet.slice(1);
          return `${mediumLabel} · ${hook}`;
        }
      }
      // Last resort: medium + short date stamp.
      const d = new Date();
      const dateLabel = d.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      });
      return `${mediumLabel} · ${dateLabel}`;
    }

    // Bundle 1A rev3 W2 — verbatim_ask is now extracted by the
    // autonomous-build classifier (routes/partner.ts) directly from the
    // user's input and lands on the interpretation object. The previous
    // pattern-matching scored-selector in this file was layered guessing
    // on top of Opus output. Reading interpretation.verbatim_ask is the
    // single source of truth.
    const interpretationCast = interpretation as unknown as Record<string, any>;
    const verbatimAsk = typeof interpretationCast.verbatim_ask === 'string'
      ? interpretationCast.verbatim_ask.trim()
      : '';
    const situationTrimmed = (interpretation.situation || '').trim();
    let ctaFromSituation = '';
    if (verbatimAsk.length > 0 && verbatimAsk.length < 300) {
      ctaFromSituation = verbatimAsk;
    } else if (situationTrimmed.length > 0 && situationTrimmed.length < 200) {
      // Backward-compat fallback for guided builds where verbatim_ask is
      // not produced — the situation is itself short enough to use as a
      // CTA, so use it verbatim.
      ctaFromSituation = situationTrimmed;
    }
    const ctaForStory = ctaFromSituation || `Get started with ${interpretation.offering.name || 'us'}`;
    const story = await prisma.fiveChapterStory.create({
      data: {
        draftId: draftWithElements.id,
        medium: mediumKey,
        customName: buildCustomName(),
        cta: ctaForStory,
      },
    });

    // Round 3 fix — tier-generation stage complete; cancel the check-in
    // timer so it doesn't fire after the milestone has already landed.
    cancelTierCheckin();
    // Round 3.3 Item 1 — also cancel the heartbeat.
    cancelTierHeartbeat();

    // Phase 2 — Milestone 1: Foundation confirmed. Path B narration only;
    // Path A stays silent. Live consultation read inside the helper.
    // Fires after the FCS row exists so storyId is in ctx — the chat panel
    // scopes history by storyId once it navigates to /five-chapter, and a
    // foundation message without storyId would be filtered out of view.
    await narrateMilestoneIfPathB({
      userId: pipelineUserId,
      workspaceId: pipelineWorkspaceId,
      ctx: {
        storyId: story.id,
        draftId: draftWithElements.id,
        offeringId: draftWithElements.offering.id,
        audienceId: draftWithElements.audience.id,
      },
      milestone: MILESTONE_FOUNDATION_CONFIRMED,
    });

    // Phase 2 — `let` (was `const`) so the foundational-shift pause path
    // can re-fetch this row after a foundation regeneration.
    let draftForStory = await prisma.threeTierDraft.findFirst({
      where: { id: draftWithElements.id },
      include: {
        tier1Statement: true,
        tier2Statements: {
          orderBy: { sortOrder: 'asc' },
          include: {
            tier3Bullets: { orderBy: { sortOrder: 'asc' } },
            priority: true,
          },
        },
        offering: { include: { elements: true } },
        audience: { include: { priorities: { orderBy: { sortOrder: 'asc' } } } },
      },
    });
    if (!draftForStory) {
      await fail('Draft vanished before chapter generation.');
      return;
    }
    let initialTier1TextForShift = initialTier1Text || draftForStory.tier1Statement?.text || '';

    // Detect which content is actually available in the Three Tier so we can
    // write chapter-specific anti-fabrication guardrails below. Each chapter
    // of a Five Chapter Story has a mandatory topic (Ch3 support, Ch4 social
    // proof, Ch5 direction). When the source doesn't cover that topic, the
    // LLM's natural instinct is to invent onboarding teams, dedicated contacts,
    // customer quantities, and pilot programs to fill the slot. Explicit per-
    // chapter guardrails tell it what to do instead.
    const tier2Labels = draftForStory.tier2Statements
      .map(t => (t.categoryLabel || '').toLowerCase())
      .filter(l => l.length > 0);
    const supportColumnLabel = tier2Labels.some(l =>
      /support|onboard|service|help|success|implement/.test(l),
    );
    const supportColumnTexts = draftForStory.tier2Statements
      .filter(t => /support/i.test(t.categoryLabel || ''))
      .map(t => t.text.toLowerCase());
    const supportContentIsReal = supportColumnTexts.some(text =>
      /onboard|training|implementation|migration|setup|install|dedicated team|support team|customer success|configuration|deployment plan|pilot program/.test(text)
      && !/already deployed|already validate|already running|already live|already proven/.test(text)
    );
    const hasSupportColumn = supportColumnLabel && supportContentIsReal;
    const hasSocialProofColumn = tier2Labels.some(l =>
      /social|proof|recognition|customer|testimonial|reference/.test(l),
    );
    // Typed social proof extraction — replaces the narrow customer-suffix regex
    // that was here before. The regex missed certifications, awards, named
    // publications, individuals, and adoption numbers — all valid Tier 3 proof
    // that Chapter 4 should be allowed to cite. We now ask Haiku to type every
    // named specific in Tier 3 so the Ch4 guardrail can work with the full set.
    const allTier3Bullets: string[] = [];
    for (const t2 of draftForStory.tier2Statements) {
      for (const b of t2.tier3Bullets) {
        if (b.text && b.text.trim().length > 0) {
          allTier3Bullets.push(b.text.trim());
        }
      }
    }
    const socialProof = await extractSocialProof(allTier3Bullets);
    const grouped = groupByType(socialProof.items);
    // "namedCustomers" preserves the old variable name so the Ch4 guardrail
    // keeps working for the customer-citation path. Customer + adoption_number
    // entries both read as "customers" from a citation standpoint.
    const namedCustomers = new Set<string>([
      ...grouped.customer,
      ...grouped.adoption_number,
    ]);
    // Non-customer named specifics — certifications, awards, publications,
    // individuals, regulators. These are valid Ch4 proof and must NOT be
    // suppressed just because there are no customer names.
    const otherNamedSpecifics: SocialProofItem[] = socialProof.items.filter(
      it => it.type !== 'customer' && it.type !== 'adoption_number',
    );

    function buildChapterGuardrails(chapterNum: number): string {
      // Ch3 — We'll Hold Your Hand (support/reassurance)
      if (chapterNum === 3) {
        if (!hasSupportColumn) {
          return `
CHAPTER 3 GUARDRAIL — CRITICAL — THE SOURCE HAS NO SUPPORT CONTENT.

THIS IS THE MOST IMPORTANT INSTRUCTION FOR THIS CHAPTER. The Three Tier
above does not describe ANY onboarding, migration, training, pilot program,
implementation timeline, or customer success program.

YOU MUST NOT INVENT ANY OF THESE. This is non-negotiable.

Specifically, you MUST NOT write:
- ANY timeline ("90 days", "two weeks", "within X")
- ANY pilot structure ("pilot with X reps", "small group", "test accounts")
- ANY team commitment ("we stay involved", "live support", "dedicated team",
  "weekly monitoring", "adoption monitoring")
- ANY onboarding process ("we run your first X", "we handle setup",
  "we walk you through")
- ANY number of accounts, reps, or analyses to perform

WHAT TO DO INSTEAD: Write 1-2 sentences of reassurance that come from
FACTS ALREADY IN THE THREE TIER ABOVE. The product reduces risk because
of how it is built — not because of a services layer. For example:
- The technology is already proven at scale (if the Three Tier says this)
- The data stays on-premises (if the Three Tier says this)
- The platform is owned by the same company (if the Three Tier says this)

If you cannot write a single honest sentence from the Three Tier data,
write: "The technology is already in production." That single sentence
is better than three sentences of fabrication.

A ONE-SENTENCE chapter is acceptable. Fabrication is not.`;
        }
      }
      // Ch4 — You're Not Alone (social proof / named specifics)
      if (chapterNum === 4) {
        const customerList = [...namedCustomers];
        const nonCustomerList = otherNamedSpecifics.map(s => `${s.name} (${s.type})`);
        if (customerList.length === 0 && nonCustomerList.length === 0 && !hasSocialProofColumn) {
          return `
CHAPTER 4 GUARDRAIL — THE SOURCE HAS NO NAMED SPECIFICS.

The Three Tier above names no customers, certifications, awards, publications,
or regulators. You may NOT invent any. Forbidden:
- "banks like yours are using the platform"
- "multiple community banks", "several regional institutions", "pilot
  partners", "beta customers", "early adopters"
- Any count ("over twenty banks", "dozens of hospitals")
- Any composite fiction ("a bank roughly your size")
- Made-up certifications, awards, or regulatory positions

Instead, re-anchor Chapter 4 in what the reader already knows: their OWN
situation. Write about the pressure they are under, the shape of the decision
they are making, the risk of inaction. You are giving them confidence that
they are not being sold into something exotic — you are doing that WITHOUT
naming other proof you don't have. A short chapter is fine.`;
        }
        const allowedLines: string[] = [];
        if (customerList.length > 0) {
          allowedLines.push(`Named customers / adoption: ${customerList.join(', ')}`);
        }
        if (nonCustomerList.length > 0) {
          allowedLines.push(`Other named proof (certifications/awards/publications/individuals/regulators): ${nonCustomerList.join('; ')}`);
        }
        return `
CHAPTER 4 GUARDRAIL — YOU MAY CITE ONLY THE NAMED SPECIFICS LISTED BELOW.

${allowedLines.join('\n')}

That is the complete list of citable named proof. You may NOT use phrases like
"banks like yours are already using it", "multiple regional banks", "several
community banks", "pilot partners", "beta customers", or any count or plural
reference that implies more named proof than is listed above.

Treat certifications, awards, publications, and regulatory positions as
equally valid social proof to customer names. If the Three Tier gives you
"FDA approval pending" and no customers, Chapter 4 may be anchored in the
FDA approval as proof; it does NOT need invented customers to function.

METRICS MUST BE FROM THE THREE TIER. You may NOT invent timelines, percentages,
or outcomes unless those exact facts appear in Tier 3 proof bullets. If the
proof is thin, write a shorter chapter. Two honest sentences beat four
sentences with one fabricated metric.`;
      }
      // Ch5 — Let's Get Started (direction)
      if (chapterNum === 5) {
        return `
CHAPTER 5 GUARDRAIL — DIRECTION MUST BE REAL.

Your CTA is: "${story.cta}". That is the only action you may direct the
reader to take. You may NOT invent trial options, sandbox environments,
workshops, assessments, pilot programs, free audits, or any other offer
that does not appear explicitly in the Three Tier or the Situation. If the
CTA is "get a demo", the chapter lands on "get a demo" — not on
"pick one workflow and run it in our sandbox". Specifically: do NOT invent
a number of accounts to test with ("pick 10 accounts"), do NOT invent
who will do the work ("we'll run the analyses"), do NOT invent a trial
structure that isn't in the source data.

SENIORITY: If the reader is a senior executive, NEVER give directives.
"Pick 10 accounts" is a directive. Instead, offer a path: "One way to
evaluate this: a small pilot with a handful of accounts." The reader
decides how to act — you present options.

If the honest ending is thin, make the chapter short and direct. One
sentence pointing to the CTA is better than three sentences inventing
a pilot program.`;
      }
      return '';
    }

    // Pre-generate the Chapter 1 strategic thesis — a one-sentence business
    // frame at the altitude the reader thinks about their job. This anchors
    // Chapter 1 generation so it starts from a strategic discipline, not a
    // tactical symptom.
    let ch1Thesis = '';
    try {
      const thesisPrompt = `You are writing ONE sentence — a market truth a senior executive would independently recognize.

AUDIENCE: ${draftForStory.audience.name}
TOP PRIORITY: "${draftForStory.audience.priorities[0]?.text || ''}"
DRIVER: "${draftForStory.audience.priorities[0]?.driver || ''}"

Write a single sentence: "[Category condition] means [business consequence]."
This must be a truth about the MARKET or INDUSTRY — NOT a claim about the reader's team.
GOOD: "Unmanaged device lifecycle management means lost Apple revenue." (market truth)
GOOD: "Uncoordinated pathology workflows mean delayed treatment decisions." (market truth)
BAD: "Your team has no structured way to engage accounts." (claim about their org)
BAD: "Competitors are filling the gap." (teaching them their landscape)
Return ONLY the one sentence.`;
      ch1Thesis = await callAI(thesisPrompt, '', 'elite');
      ch1Thesis = ch1Thesis.replace(/^["']|["']$/g, '').trim();
      console.log(`[Ch1 thesis] ${ch1Thesis}`);
    } catch (err) {
      console.error('[Ch1 thesis] Generation failed, proceeding without:', err);
    }

    // Phase 2 — Fix 3: chapter generation may regenerate up to MAX_REGEN_CYCLES
    // times if the user makes foundation-changing edits during the run. Each
    // edit fires its own pause + regen. The cap exists only as a runaway-loop
    // safety net; in normal use the user makes at most a couple of follow-up
    // adjustments before settling on a foundation.
    const MAX_REGEN_CYCLES = 3;
    let chapterRegenCount = 0;
    // Round 2 fix — per-chapter missing-piece descriptors extracted from
    // the chapter generators' [INSERT: <description>] markers. Survives the
    // chapter loop; resets at the top of each regen cycle. Feeds the
    // unified soft-note system after blend completes.
    let chapterMissingPieces: Record<3 | 4 | 5, string[]> = { 3: [], 4: [], 5: [] };
    // Round 3 fix — chapters stage check-in covers the full 5-chapter
    // loop. Scheduled once before the loop begins; cancelled when the
    // CHAPTERS_SEPARATED milestone lands. The flag prevents re-fire on
    // regen cycles.
    console.log(`[Perf] jobId=${jobId} stage=chapters-start elapsed_ms=${Date.now() - pipelineStartMs} mode=${pipelinePerfMode} variant=${variantIndex + 1}/${variantCount}`);
    const cancelChaptersCheckin = scheduleStageCheckin({
      stage: 'chapters',
      message: STAGE_CHECKIN_CHAPTERS,
      flags: stageCheckinFlags,
      userId: pipelineUserId,
      workspaceId: pipelineWorkspaceId,
      ctx: {
        storyId: story.id,
        draftId: draftWithElements.id,
        offeringId: draftWithElements.offering.id,
        audienceId: draftWithElements.audience.id,
      },
    });
    // Round 3.3 Item 1 — chapters heartbeat. Fires once at the 90s
    // threshold if the chapter loop is still running. Same pattern as
    // BLEND_HEARTBEAT.
    const cancelChaptersHeartbeat = scheduleStageCheckin({
      stage: 'chapters-heartbeat',
      message: CHAPTERS_HEARTBEAT,
      flags: stageCheckinFlags,
      userId: pipelineUserId,
      workspaceId: pipelineWorkspaceId,
      ctx: {
        storyId: story.id,
        draftId: draftWithElements.id,
        offeringId: draftWithElements.offering.id,
        audienceId: draftWithElements.audience.id,
      },
      delayMs: CHAPTERS_HEARTBEAT_MS,
      kind: 'chapters-heartbeat',
    });
    do {
    chapterMissingPieces = { 3: [], 4: [], 5: [] };
    for (let chapterNum = 1; chapterNum <= 5; chapterNum++) {
      // Bundle 1A rev2 W7 — wrap each chapter iteration in its own
      // try/catch so a thrown error in chapter N (network, timeout,
      // unexpected exception in a check) does not prevent chapter N+1
      // from attempting. Cowork's verification surfaced a deliverable
      // with Ch1-3 generated but Ch4/Ch5 missing — the pipeline reached
      // post-chapter-loop processing without all five chapters. The
      // most likely cause is an exception in chapter 4's body that
      // escaped the per-check catches and broke the loop iteration.
      // This wrapper catches and logs so the loop continues. If
      // chapters fail clean, "Not yet generated" rendering is the
      // accurate frontend state until the user requests regeneration.
      try {
      await update({
        status: `chapter_${chapterNum}`,
        stage: `Drafting chapter ${chapterNum} of 5${variantStageSuffix}`,
        progress: scaledProgress(45 + chapterNum * 8),
      });

      const systemPrompt = buildChapterPrompt(chapterNum, mediumKey);
      const ch = CHAPTER_CRITERIA[chapterNum - 1];
      const chapterGuardrail = buildChapterGuardrails(chapterNum);
      const prevChapters = await prisma.chapterContent.findMany({
        where: { storyId: story.id, chapterNum: { lt: chapterNum } },
        orderBy: { chapterNum: 'asc' },
      });

      const situation = interpretation.situation?.trim() || '';
      const situationBlock = situation
        ? `SITUATION — THIS IS WHAT THE DRAFT MUST DO:
${situation}

The draft must serve this specific situation. A generic value story about the
offering is not acceptable. The reader must recognize this as a draft written
FOR them, FOR this occasion, not a recycled template.

`
        : '';

      const readerDirective = `\nTHE READER: "${draftForStory.audience.name}" is the person reading this. Every sentence should be written for THIS person — their concerns, their perspective, their level of seniority. ${
        chapterNum === 1
          ? `The opening must be a BUSINESS THESIS at the strategic level, not a tactical narrative.${ch1Thesis ? ` USE THIS AS YOUR OPENING THESIS (adapt for tone but keep the strategic frame): "${ch1Thesis}"` : ' Format: "[Missing category/discipline] means [reader\'s strategic loss]."'} Then show dual value: what end customers experience translates into the reader\'s strategic outcome.`
          : chapterNum === 2
            ? 'Do NOT open with the product name as the sentence subject. Lead with what the READER gets or how their situation changes. The product is the mechanism, not the headline.'
            : chapterNum === 5
              ? 'Match tone to seniority. For senior executives: offer a path they can evaluate, never give directives. "One approach would be..." not "Pick X and do Y."'
              : ''
      }\n`;

      // Chapter 1 gets ONLY audience data + thesis — no product/Three Tier.
      // This forces the AI to write about the reader's world without product contamination.
      const threeTierBlock = chapterNum === 1 ? '' : `
THREE TIER MESSAGE:
Tier 1: "${draftForStory.tier1Statement?.text || ''}"
${draftForStory.tier2Statements
  .map(
    (t2, i) => `Tier 2 #${i + 1}: "${t2.text}" (Priority: "${t2.priority?.text || 'unlinked'}"${
      t2.priority?.driver ? `, Driver: "${t2.priority.driver}"` : ''
    })
  Proof: ${t2.tier3Bullets.map(t3 => t3.text).join(', ')}`,
  )
  .join('\n')}
`;

      // Round 3.2 Item 9 follow-up — when the user provided a specific
      // ask in their situation (now persisted as story.cta verbatim),
      // chapter-5 must include that exact phrase, not a paraphrase.
      // The prior chapter-5 generator was rewriting "reply to schedule
      // a demo" into "One way to start would be to get your team into
      // TestPilot this week" — losing the specificity. Stricter
      // directive on chapter-5 only.
      const ctaVerbatimDirective = chapterNum === 5 && story.cta
        ? `\nCTA VERBATIM REQUIREMENT — the call-to-action in this chapter must include the exact phrase "${story.cta}" verbatim. Do not paraphrase, summarize, soften, or rewrite the user's ask. Other surrounding language can be yours, but the verbatim phrase must appear in the chapter as the action the reader is invited to take.\n`
        : '';

      const userMessage = `${situationBlock}${chapterNum === 1 ? '' : `OFFERING: ${draftForStory.offering.name}\n`}AUDIENCE (THIS IS THE READER): ${draftForStory.audience.name}
CONTENT FORMAT: ${mediumSpec.label} (${mediumSpec.wordRange[0]}-${mediumSpec.wordRange[1]} words total)
${chapterNum === 1 ? '' : `CTA: ${story.cta}\n`}${readerDirective}${ctaVerbatimDirective}
${threeTierBlock}
AUDIENCE PRIORITIES:
${draftForStory.audience.priorities
  .map(
    p =>
      `[Rank ${p.rank}] "${p.text}"${p.driver ? ` — Driver: "${p.driver}"` : ''}`,
  )
  .join('\n')}

${
  prevChapters.length > 0
    ? `PREVIOUS CHAPTERS (context — do NOT repeat their facts or phrases):
${prevChapters
  .map(c => {
    const text = c.content;
    const maxLen = 500;
    if (text.length <= maxLen) return `Ch ${c.chapterNum}: ${text}`;
    const truncated = text.substring(0, maxLen);
    const lastSentenceEnd = Math.max(
      truncated.lastIndexOf('. '),
      truncated.lastIndexOf('? '),
      truncated.lastIndexOf('! '),
    );
    const clean =
      lastSentenceEnd > 100
        ? truncated.substring(0, lastSentenceEnd + 1)
        : truncated.substring(0, truncated.lastIndexOf(' '));
    return `Ch ${c.chapterNum}: ${clean}`;
  })
  .join('\n')}
`
    : ''
}
Write Chapter ${chapterNum}: "${ch.name}"

IMPORTANT: Start this chapter fresh. Do NOT begin with "..." or any continuation from a previous chapter. Each chapter is self-contained.

${chapterNum > 1 ? `CRITICAL — NO FABRICATION. You may only assert claims explicitly supported
by the THREE TIER MESSAGE, AUDIENCE PRIORITIES, or SITUATION above.
SOURCE-FIRST WRITING: Before writing each sentence, identify which Tier 2,
Tier 3, or Priority it derives from. If you cannot point to a specific source,
cut the sentence. A one-sentence chapter that is honest is better than three
sentences with one fabricated line. No invented metrics, customer names,
timelines, team commitments, pilot structures, or product features not in the
Three Tier.` : ''}

The test: if you are about to write something, and you are not sure whether
it is true, it is not true for this user — so cut it.

If the SITUATION describes an announcement, a policy change, or a specific
occasion, the chapter must be ABOUT that thing, at its center, from the
first sentence. A chapter that opens with generic framing about the
offering and ignores the occasion is a failure — regenerate before
returning.
${chapterGuardrail}`;

      let content = await callAI(systemPrompt, userMessage, 'elite');

      // Voice check with one retry. Matches 2.5 generate-chapter behavior in
      // backend/src/routes/ai.ts:1345. Fails open so pipeline continues on
      // evaluator errors.
      try {
        const proseCheck = await checkProse(
          content,
          `Chapter ${chapterNum}: ${ch.name} of a Five Chapter Story (${mediumSpec.label} format)`,
        );
        if (!proseCheck.passed && proseCheck.violations.length > 0) {
          console.log(
            `[ExpressPipeline] ${jobId} chapter ${chapterNum} voice violations: ${proseCheck.violations.length}, retrying`,
          );
          const feedback = buildProseViolationFeedback(proseCheck.violations);
          content = await callAI(systemPrompt, userMessage + feedback, 'elite');
        }
      } catch (err) {
        console.error(
          `[ExpressPipeline] ${jobId} chapter ${chapterNum} voice check error (fail-open):`,
          err,
        );
      }

      // Fabrication check with up to TWO retries. This is separate from
      // voice check: voice check evaluates HOW things are said, fabrication
      // check evaluates WHETHER things are true. Catches invented customers,
      // metrics, pricing, processes, and professional services that the
      // chapter prompt rules don't always prevent on their own.
      //
      // Why two retries instead of one: empirically one retry isn't enough.
      // The LLM's first draft typically invents several claims, the retry
      // removes some but introduces new ones (especially for Chapter 3
      // support / Chapter 4 social proof). The second retry, with cumulative
      // feedback listing every flagged claim from both earlier attempts,
      // usually converges on an honest draft. Latency cost: ~30 sec per extra
      // retry, worth it for output integrity.
      try {
        const tierTextForCheck = `Tier 1: "${draftForStory.tier1Statement?.text || ''}"
${draftForStory.tier2Statements
  .map(
    (t2, i) => `Tier 2 #${i + 1} [${t2.categoryLabel || 'unlabeled'}]: "${t2.text}"
  Proof: ${t2.tier3Bullets.map(b => b.text).join(', ') || '(no proof)'}`,
  )
  .join('\n')}`;
        const prioritiesTextForCheck = draftForStory.audience.priorities
          .map(p => `[Rank ${p.rank}] "${p.text}"`)
          .join('\n');
        const cumulativeViolations: string[] = [];
        let brokeClean = false;
        for (let attempt = 0; attempt < 2; attempt++) {
          const fabCheck = await checkChapterFabrication({
            situation,
            tierText: tierTextForCheck,
            prioritiesText: prioritiesTextForCheck,
            chapterContent: content,
          });
          if (fabCheck.passed || fabCheck.violations.length === 0) {
            if (attempt > 0) {
              console.log(
                `[ExpressPipeline] ${jobId} chapter ${chapterNum} fabrication cleared after ${attempt} retry(s)`,
              );
            }
            brokeClean = true;
            break;
          }
          console.log(
            `[ExpressPipeline] ${jobId} chapter ${chapterNum} fabrication attempt ${attempt + 1}: ${fabCheck.violations.length} unsupported claims, retrying`,
          );
          // Accumulate violations across attempts so the retry sees everything
          // that was flagged, not just the current attempt. This prevents the
          // LLM from fixing one invention and introducing a new one.
          for (const v of fabCheck.violations) cumulativeViolations.push(v);
          const feedback = buildFabricationFeedback(cumulativeViolations);
          content = await callAI(systemPrompt, userMessage + feedback, 'elite');
        }
        // Surgical redaction pass. When the 2-retry loop did NOT break
        // cleanly, the current content is the result of a post-failure
        // regeneration that has never been checked. Always run one final
        // check on it. If it still has violations, switch to EDIT mode
        // and ask Opus to remove exactly those flagged sentences — no new
        // content, shorter is fine. This is how we defeat the regenerate-
        // reinvent loop: the chapter system prompt keeps pressuring Opus
        // toward a mandated topic, so regeneration keeps producing new
        // inventions. Redaction takes the current text and only subtracts.
        if (!brokeClean) {
          const finalCheck = await checkChapterFabrication({
            situation,
            tierText: tierTextForCheck,
            prioritiesText: prioritiesTextForCheck,
            chapterContent: content,
          });
          if (finalCheck.passed || finalCheck.violations.length === 0) {
            console.log(
              `[ExpressPipeline] ${jobId} chapter ${chapterNum} post-retry regeneration was already clean`,
            );
          } else {
            console.log(
              `[ExpressPipeline] ${jobId} chapter ${chapterNum} redacting ${finalCheck.violations.length} surviving claims surgically`,
            );
            const redacted = await redactChapterViolations({
              chapterContent: content,
              violations: finalCheck.violations,
            });
            if (redacted && redacted.length > 0) content = redacted;
            const postCheck = await checkChapterFabrication({
              situation,
              tierText: tierTextForCheck,
              prioritiesText: prioritiesTextForCheck,
              chapterContent: content,
            });
            console.log(
              `[ExpressPipeline] ${jobId} chapter ${chapterNum} redaction result: ${
                postCheck.passed
                  ? 'clean'
                  : `${postCheck.violations.length} surviving`
              }`,
            );
          }
        }
      } catch (err) {
        console.error(
          `[ExpressPipeline] ${jobId} chapter ${chapterNum} fabrication check error (fail-open):`,
          err,
        );
      }

      // Altitude check for Chapter 1 only. Runs AFTER fabrication clears so we
      // evaluate the final text. Chapter 1 drifts into tactical altitude or
      // accusatory claims about the reader's org even with the pre-generated
      // thesis as an anchor — this is the final guardrail. Same retry-then-
      // surgical-edit pattern as the fabrication check.
      if (chapterNum === 1) {
        try {
          const topPriorityText = draftForStory.audience.priorities[0]?.text || '';
          const topPriorityDriver = draftForStory.audience.priorities[0]?.driver || '';
          const audienceName = draftForStory.audience.name;
          const cumulativeAltViolations: string[] = [];
          let altBrokeClean = false;
          for (let attempt = 0; attempt < 2; attempt++) {
            const altCheck = await checkChapterOneAltitude({
              audienceName,
              topPriority: topPriorityText,
              driver: topPriorityDriver,
              chapterContent: content,
            });
            if (altCheck.passed || altCheck.violations.length === 0) {
              if (attempt > 0) {
                console.log(
                  `[ExpressPipeline] ${jobId} chapter 1 altitude cleared after ${attempt} retry(s)`,
                );
              }
              altBrokeClean = true;
              break;
            }
            console.log(
              `[ExpressPipeline] ${jobId} chapter 1 altitude attempt ${attempt + 1}: ${altCheck.violations.length} violations, retrying`,
            );
            for (const v of altCheck.violations) cumulativeAltViolations.push(v);
            const feedback = buildAltitudeFeedback(cumulativeAltViolations);
            content = await callAI(systemPrompt, userMessage + feedback, 'elite');
          }
          if (!altBrokeClean) {
            const finalAlt = await checkChapterOneAltitude({
              audienceName,
              topPriority: topPriorityText,
              driver: topPriorityDriver,
              chapterContent: content,
            });
            if (finalAlt.passed || finalAlt.violations.length === 0) {
              console.log(
                `[ExpressPipeline] ${jobId} chapter 1 post-retry regeneration was already clean on altitude`,
              );
            } else {
              console.log(
                `[ExpressPipeline] ${jobId} chapter 1 elevating ${finalAlt.violations.length} surviving sentences surgically`,
              );
              const elevated = await elevateChapterOne({
                chapterContent: content,
                violations: finalAlt.violations,
                audienceName,
                topPriority: topPriorityText,
              });
              if (elevated && elevated.length > 0) content = elevated;
              const postAlt = await checkChapterOneAltitude({
                audienceName,
                topPriority: topPriorityText,
                driver: topPriorityDriver,
                chapterContent: content,
              });
              console.log(
                `[ExpressPipeline] ${jobId} chapter 1 elevation result: ${
                  postAlt.passed ? 'clean' : `${postAlt.violations.length} surviving`
                }`,
              );
            }
          }
        } catch (err) {
          console.error(
            `[ExpressPipeline] ${jobId} chapter 1 altitude check error (fail-open):`,
            err,
          );
        }
      }

      // Same post-processing as the 2.5 generate-chapter route
      content = content.replace(/^\s*\.{2,}\s*/g, '').trim();

      // Strip CTA from chapters 1-4
      if (chapterNum < 5 && story.cta) {
        const ctaLower = story.cta.toLowerCase().trim();
        content = content
          .split('\n')
          .map(line => (line.toLowerCase().trim() === ctaLower ? '' : line))
          .filter(line => line.trim())
          .join('\n')
          .trim();
      }

      // Round 2 fix — extract [INSERT: ...] marker descriptions and strip
      // marker-bearing sentences from the chapter prose. The descriptions
      // are the user-facing missing-piece labels; the stripped prose is
      // what flows into join + blend so blendedText has zero brackets.
      // Only chapters 3-5 carry methodology-required gaps that should
      // surface as soft notes; markers in 1-2 still get stripped from
      // the prose but don't drive a chat note.
      {
        const { cleanContent, missingPieces } = extractAndStripMarkers(content);
        content = cleanContent;
        if (chapterNum === 3 || chapterNum === 4 || chapterNum === 5) {
          chapterMissingPieces[chapterNum] = missingPieces;
        }
      }

      await prisma.chapterContent.upsert({
        where: { storyId_chapterNum: { storyId: story.id, chapterNum } },
        update: { title: ch.name, content },
        create: { storyId: story.id, chapterNum, title: ch.name, content },
      });

      const maxVer = await prisma.chapterVersion.aggregate({
        where: {
          chapterContentId: (await prisma.chapterContent.findFirst({
            where: { storyId: story.id, chapterNum },
          }))!.id,
        },
        _max: { versionNum: true },
      });
      const chapterRow = await prisma.chapterContent.findFirst({
        where: { storyId: story.id, chapterNum },
      });
      if (chapterRow) {
        await prisma.chapterVersion.create({
          data: {
            chapterContentId: chapterRow.id,
            title: ch.name,
            content,
            versionNum: (maxVer._max?.versionNum ?? 0) + 1,
            changeSource: 'ai_generate',
          },
        });
      }
      } catch (chapterErr) {
        // Bundle 1A rev2 W7 — log and continue to next chapter.
        const errMsg = chapterErr instanceof Error ? chapterErr.message : String(chapterErr);
        console.error(
          `[ExpressPipeline] ${jobId} CHAPTER ${chapterNum} FAILED — error caught, continuing to next chapter. Error: ${errMsg}`,
        );
      }
    }

    // Phase 2 — Foundational-shift pause check after chapter loop. If the
    // user edited the foundation mid-pipeline, this returns
    // 'regenerate-chapters' so we delete chapters and re-run the loop ONCE.
    {
      const pauseResult = await checkFoundationalShiftPause({
        jobId,
        userId: pipelineUserId,
        workspaceId: pipelineWorkspaceId,
        ctx: {
          storyId: story.id,
          draftId: draftWithElements.id,
          offeringId: draftWithElements.offering.id,
          audienceId: draftWithElements.audience.id,
        },
        draftId: draftWithElements.id,
        pipelineStartMs,
        pauseFlag: shiftPauseFlag,
        initialTier1Text: initialTier1TextForShift,
        updateStage: async (s: string) => { await update({ stage: s }); },
      });
      if (pauseResult.action === 'timeout') {
        await writeMariaMessage({
          userId: pipelineUserId,
          workspaceId: pipelineWorkspaceId,
          ctx: {
            storyId: story.id,
            draftId: draftWithElements.id,
            offeringId: draftWithElements.offering.id,
            audienceId: draftWithElements.audience.id,
          },
          content: buildFoundationalShiftTimeout(timeoutAreaForTargetCell(pauseResult.targetCell)),
          kind: 'pause-timeout',
        });
        await fail('Foundation update timed out.');
        return;
      }
      if (pauseResult.action === 'regenerate-chapters' && chapterRegenCount < MAX_REGEN_CYCLES) {
        chapterRegenCount++;
        await prisma.chapterContent.deleteMany({ where: { storyId: story.id } });
        const refreshed = await prisma.threeTierDraft.findFirst({
          where: { id: draftWithElements.id },
          include: {
            tier1Statement: true,
            tier2Statements: {
              orderBy: { sortOrder: 'asc' },
              include: {
                tier3Bullets: { orderBy: { sortOrder: 'asc' } },
                priority: true,
              },
            },
            offering: { include: { elements: true } },
            audience: { include: { priorities: { orderBy: { sortOrder: 'asc' } } } },
          },
        });
        if (!refreshed) {
          await fail('Draft vanished during foundation regeneration.');
          return;
        }
        draftForStory = refreshed;
        initialTier1TextForShift = draftForStory.tier1Statement?.text || '';
        continue;  // re-enter chapter loop with refreshed foundation
      }
      break;  // no shift, exit do-while
    }
    } while (true);

    // Round 3 fix — chapters stage complete; cancel before milestone.
    cancelChaptersCheckin();
    // Round 3.3 Item 1 — also cancel the heartbeat.
    cancelChaptersHeartbeat();

    // Phase 2 — Milestone 2: Chapters separated. Path B narration only.
    await narrateMilestoneIfPathB({
      userId: pipelineUserId,
      workspaceId: pipelineWorkspaceId,
      ctx: {
        storyId: story.id,
        draftId: draftWithElements.id,
        offeringId: draftWithElements.offering.id,
        audienceId: draftWithElements.audience.id,
      },
      milestone: MILESTONE_CHAPTERS_SEPARATED_READY,
    });

    // ─── Stage 3.5: Join (NEW in Phase 2) ────────────
    // Combine the five separately-generated chapters into one read with
    // minimal transitions. Persists `joinedText` and stage='joined' on
    // the FCS row, then narrates Milestone 3 before the blend pass runs.
    await update({
      status: 'joining',
      stage: `Joining the chapters${variantStageSuffix}`,
      progress: scaledProgress(88),
    });

    const storyWithChaptersForJoin = await prisma.fiveChapterStory.findFirst({
      where: { id: story.id },
      include: { chapters: { orderBy: { chapterNum: 'asc' } } },
    });
    if (!storyWithChaptersForJoin || storyWithChaptersForJoin.chapters.length < 5) {
      await fail('Not all chapters generated cleanly.');
      return;
    }
    const joinSourceText = storyWithChaptersForJoin.chapters
      .map(ch => ch.content)
      .join('\n\n');
    const joinMessage = `CONTENT FORMAT: ${mediumSpec.label}\n\n${joinSourceText}`;
    let joinedText = '';
    try {
      joinedText = await callAI(JOIN_CHAPTERS_SYSTEM, joinMessage, 'elite');
      try {
        const joinCheck = await checkProse(joinedText, `Joined ${mediumSpec.label}`);
        if (!joinCheck.passed && joinCheck.violations.length > 0) {
          const feedback = buildProseViolationFeedback(joinCheck.violations);
          joinedText = await callAI(JOIN_CHAPTERS_SYSTEM, joinMessage + feedback, 'elite');
        }
      } catch (err) {
        console.error(`[ExpressPipeline] ${jobId} join voice check error (fail-open):`, err);
      }
      await prisma.fiveChapterStory.update({
        where: { id: story.id },
        data: { joinedText, stage: 'joined' },
      });
    } catch (err) {
      console.error(`[ExpressPipeline] ${jobId} join failed (fail-open, blend still runs):`, err);
    }

    // Phase 2 — Milestone 3: Chapters combined. Path B narration only.
    await narrateMilestoneIfPathB({
      userId: pipelineUserId,
      workspaceId: pipelineWorkspaceId,
      ctx: {
        storyId: story.id,
        draftId: draftWithElements.id,
        offeringId: draftWithElements.offering.id,
        audienceId: draftWithElements.audience.id,
      },
      milestone: MILESTONE_CHAPTERS_COMBINED_READY,
    });

    // ─── Stage 4: Blend into final draft ─────────────
    await update({
      status: 'blending',
      stage: `Polishing the draft${variantStageSuffix}`,
      progress: scaledProgress(92),
    });
    const blendStartMs = Date.now();
    console.log(`[Perf] jobId=${jobId} stage=blend-start elapsed_ms=${blendStartMs - pipelineStartMs} mode=${pipelinePerfMode} variant=${variantIndex + 1}/${variantCount}`);

    const cancelBlendCheckin = scheduleStageCheckin({
      stage: 'blend',
      message: STAGE_CHECKIN_BLEND,
      flags: stageCheckinFlags,
      userId: pipelineUserId,
      workspaceId: pipelineWorkspaceId,
      ctx: {
        storyId: story.id,
        draftId: draftWithElements.id,
        offeringId: draftWithElements.offering.id,
        audienceId: draftWithElements.audience.id,
      },
    });
    // Round 3.1 Item 3 — blend-phase heartbeat. Fires once at the
    // BLEND_HEARTBEAT_MS threshold (default 60s) if the blend is still
    // running. Cancelled when blend completes; suppressed if blend
    // finishes under the threshold.
    const cancelBlendHeartbeat = scheduleStageCheckin({
      stage: 'blend-heartbeat',
      message: BLEND_HEARTBEAT,
      flags: stageCheckinFlags,
      userId: pipelineUserId,
      workspaceId: pipelineWorkspaceId,
      ctx: {
        storyId: story.id,
        draftId: draftWithElements.id,
        offeringId: draftWithElements.offering.id,
        audienceId: draftWithElements.audience.id,
      },
      delayMs: BLEND_HEARTBEAT_MS,
      kind: 'blend-heartbeat',
    });

    const storyWithChapters = await prisma.fiveChapterStory.findFirst({
      where: { id: story.id },
      include: { chapters: { orderBy: { chapterNum: 'asc' } } },
    });
    if (!storyWithChapters || storyWithChapters.chapters.length < 5) {
      await fail('Not all chapters generated cleanly.');
      return;
    }

    // Pass only chapter CONTENT to the blend step, never the titles. If the
    // titles go in, the blend LLM tends to mirror them as standalone headings
    // in the output (Ch1 "You Need This Category" has shown up as the first
    // line during Chrome walkthroughs). Dropping the titles entirely removes
    // the temptation.
    const sourceText = storyWithChapters.chapters
      .map(ch => ch.content)
      .join('\n\n');

    const blendSituation = interpretation.situation?.trim() || '';
    const blendMessage = `${blendSituation ? `SITUATION — WHAT THIS DRAFT MUST DO:
${blendSituation}

Do not drift away from this. If the source chapters below stray into generic
territory, pull them back toward the situation. Every paragraph must serve it.

` : ''}CONTENT FORMAT: ${mediumSpec.label} (${mediumSpec.wordRange[0]}-${mediumSpec.wordRange[1]} words)
FORMAT RULES: ${mediumSpec.format}
TONE: ${mediumSpec.tone}

${sourceText}

Polish this into a final, cohesive ${mediumSpec.label.toLowerCase()}.

CRITICAL — NO FABRICATION. The blend may only use claims present in the source
chapters above. Do not add customer references, pricing, metrics, features,
processes, or services that are not already in the source. If the source is
thinner than the word target, produce a shorter draft rather than invent
content to fill the gap.`;

    let blendedText = await callAI(BLEND_SYSTEM, blendMessage, 'elite');

    // Blend-level voice check with one retry. Matches 2.5 blend-story behavior.
    try {
      const blendCheck = await checkProse(blendedText, `Blended ${mediumSpec.label}`);
      if (!blendCheck.passed && blendCheck.violations.length > 0) {
        console.log(
          `[ExpressPipeline] ${jobId} blend voice violations: ${blendCheck.violations.length}, retrying`,
        );
        const feedback = buildProseViolationFeedback(blendCheck.violations);
        blendedText = await callAI(BLEND_SYSTEM, blendMessage + feedback, 'elite');
      }
    } catch (err) {
      console.error(`[ExpressPipeline] ${jobId} blend voice check error (fail-open):`, err);
    }

    // Blend-level fabrication check. The per-chapter fabrication check runs
    // on each chapter in isolation, but the blend LLM can still reintroduce
    // invented material while polishing (rewording a founder reference as a
    // "support team", adding examiner behavior, etc). Run the check again
    // on the final blended output. Treat the entire blended draft as the
    // "chapter" and pass the full Three Tier + priorities as the source.
    // Up to two retries with cumulative feedback.
    try {
      const blendTierTextForCheck = `Tier 1: "${draftForStory.tier1Statement?.text || ''}"
${draftForStory.tier2Statements
  .map(
    (t2, i) => `Tier 2 #${i + 1} [${t2.categoryLabel || 'unlabeled'}]: "${t2.text}"
  Proof: ${t2.tier3Bullets.map(b => b.text).join(', ') || '(no proof)'}`,
  )
  .join('\n')}`;
      const blendPrioritiesForCheck = draftForStory.audience.priorities
        .map(p => `[Rank ${p.rank}] "${p.text}"`)
        .join('\n');
      const cumulativeBlendViolations: string[] = [];
      let blendBrokeClean = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        const blendFabCheck = await checkChapterFabrication({
          situation: blendSituation,
          tierText: blendTierTextForCheck,
          prioritiesText: blendPrioritiesForCheck,
          chapterContent: blendedText,
        });
        if (blendFabCheck.passed || blendFabCheck.violations.length === 0) {
          if (attempt > 0) {
            console.log(
              `[ExpressPipeline] ${jobId} blend fabrication cleared after ${attempt} retry(s)`,
            );
          }
          blendBrokeClean = true;
          break;
        }
        console.log(
          `[ExpressPipeline] ${jobId} blend fabrication attempt ${attempt + 1}: ${blendFabCheck.violations.length} unsupported claims, retrying`,
        );
        for (const v of blendFabCheck.violations) cumulativeBlendViolations.push(v);
        const feedback = buildFabricationFeedback(cumulativeBlendViolations);
        blendedText = await callAI(BLEND_SYSTEM, blendMessage + feedback, 'elite');
      }
      // Blend-level surgical redaction. When the retry loop did not break
      // cleanly, the current blendedText was generated AFTER a failed
      // check and has never been evaluated. Always run one final check;
      // if it still has violations, redact in EDIT mode.
      if (!blendBrokeClean) {
        const finalCheck = await checkChapterFabrication({
          situation: blendSituation,
          tierText: blendTierTextForCheck,
          prioritiesText: blendPrioritiesForCheck,
          chapterContent: blendedText,
        });
        if (finalCheck.passed || finalCheck.violations.length === 0) {
          console.log(
            `[ExpressPipeline] ${jobId} blend post-retry regeneration was already clean`,
          );
        } else {
          console.log(
            `[ExpressPipeline] ${jobId} blend redacting ${finalCheck.violations.length} surviving claims surgically`,
          );
          const redacted = await redactChapterViolations({
            chapterContent: blendedText,
            violations: finalCheck.violations,
          });
          if (redacted && redacted.length > 0) blendedText = redacted;
          const postCheck = await checkChapterFabrication({
            situation: blendSituation,
            tierText: blendTierTextForCheck,
            prioritiesText: blendPrioritiesForCheck,
            chapterContent: blendedText,
          });
          console.log(
            `[ExpressPipeline] ${jobId} blend redaction result: ${
              postCheck.passed
                ? 'clean'
                : `${postCheck.violations.length} surviving`
            }`,
          );
        }
      }
    } catch (err) {
      console.error(
        `[ExpressPipeline] ${jobId} blend fabrication check error (fail-open):`,
        err,
      );
    }

    // Strip markdown artifacts. Same safety net as 2.5 blend-story, plus the
    // additional cases observed in Express pipeline output during the first
    // vignette walkthroughs (horizontal rules, blockquote markers, and
    // chapter-name lines that survived the title strip above).
    const chapterNameLineRegex = new RegExp(
      `^(?:${CHAPTER_NAMES.map(n => n.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')).join('|')})\\s*$`,
      'gm',
    );
    blendedText = blendedText
      .replace(/^#{1,6}\s+/gm, '')          // ATX headers
      .replace(/\*\*(.+?)\*\*/g, '$1')      // bold
      .replace(/\*(.+?)\*/g, '$1')          // italic
      .replace(/^[-*]\s+/gm, '')            // bullet markers at line start
      .replace(/^\d+\.\s+/gm, '')           // ordered list markers
      .replace(/^---+\s*$/gm, '')           // horizontal rules (stand-alone)
      .replace(/^>\s?/gm, '')               // blockquote markers
      .replace(chapterNameLineRegex, '')    // stray chapter-title lines
      .replace(/\n{3,}/g, '\n\n')           // collapse excessive blank lines
      .trim();

    // ─── Post-blend credibility telemetry ─────────────
    // Runs provenanceClassify (Round D) and fiveChapterCheck against the
    // final blended text. Round 2 fix — the marker-substitution rewriter
    // is removed: per Cowork's redesign, fact gaps surface as per-chapter
    // soft notes in chat, not as [INSERT: ...] markers in the prose.
    // INFERENCE flags here are logged for telemetry only; chapter-level
    // marker extraction is the path that drives user-visible gap notices.
    const postBlendTierText = `Tier 1: "${draftForStory.tier1Statement?.text || ''}"
${draftForStory.tier2Statements
  .map(
    (t2, i) => `Tier 2 #${i + 1} [${t2.categoryLabel || 'unlabeled'}]: "${t2.text}"
  Proof: ${t2.tier3Bullets.map(b => b.text).join(', ') || '(no proof)'}`,
  )
  .join('\n')}`;
    try {
      const sourceMaterials = {
        userInput: interpretation.situation || '',
        threeTier: postBlendTierText,
        userDocs: [],
        peerInfo: '',
      };
      const claims = await classifyClaims({
        chapterContent: blendedText,
        sourceMaterials,
      });
      const inferenceClaims = claims.filter(c => c.origin === 'INFERENCE');
      if (inferenceClaims.length > 0) {
        console.log(
          `[ExpressPipeline] ${jobId} provenanceClassify flagged ${inferenceClaims.length} INFERENCE-origin claim(s) post-blend (telemetry only — no rewrite)`,
        );
      } else {
        console.log(`[ExpressPipeline] ${jobId} provenanceClassify clean (no INFERENCE claims)`);
      }
    } catch (err) {
      console.error(`[ExpressPipeline] ${jobId} provenanceClassify error (fall-open):`, err);
    }

    // ─── Round 3.4 coaching-fix Finding 1 — post-blend numeric guard ────
    // Cheap deterministic check: every numeric claim in the final
    // blended chapter must trace to a number the user actually stated.
    // Lila's "30%" → "40%" survived earlier rounds because the pre-blend
    // checks didn't compare numbers and the post-blend classifier was
    // telemetry-only. This guard runs after blend and logs every
    // mismatch loud enough to surface in production logs and Cowork QA.
    // It is logged-only at THIS layer (post-blend regeneration would
    // mean re-running blend across all chapters and would risk
    // introducing new fabrications). The Three-Tier-level guard in
    // routes/ai.ts is the upstream gate that prevents the wrong number
    // from reaching the chapter prompt in the first place.
    try {
      const userInputTranscript = [
        interpretation.situation || '',
        postBlendTierText,
      ].filter(Boolean).join('\n\n');
      const { checkNumericClaims } = await import('../services/numericClaimGuard.js');
      const numCheck = checkNumericClaims({
        outputText: blendedText,
        userInputTranscript,
      });
      if (numCheck.violations.length > 0) {
        console.warn(
          `[ExpressPipeline] ${jobId} POST-BLEND NUMERIC GUARD flagged ${numCheck.violations.length} numeric mismatches:`,
          numCheck.violations.map(v => `"${v.claim.raw}" in context "${v.claim.context}"`),
        );
      } else {
        console.log(`[ExpressPipeline] ${jobId} post-blend numeric guard clean`);
      }
    } catch (err) {
      console.error(`[ExpressPipeline] ${jobId} post-blend numeric guard error (fail-open):`, err);
    }

    // Five Chapter structural check — boundary violations, missing-chapter
    // detection, persuasion-arc compliance. Logged for telemetry; does not
    // block. Full evaluator tuning is a separate cycle if its outputs are
    // wrong-shape against the build pipeline's chapter set.
    try {
      const fcInput: FiveChapterInput = {
        offeringName: draftForStory.offering?.name || '',
        audienceName: draftForStory.audience?.name || '',
        medium: mediumSpec.label,
        cta: '',
        tier1Text: draftForStory.tier1Statement?.text || '',
        chapters: storyWithChapters.chapters.map((ch) => ({
          num: ch.chapterNum,
          title: CHAPTER_NAMES[ch.chapterNum - 1] || `Chapter ${ch.chapterNum}`,
          content: ch.content || '',
        })),
      };
      const fcResult = await checkFiveChapter(fcInput);
      if (!fcResult.passed) {
        const violations = fcResult.chapters
          .filter(c => !c.pass)
          .flatMap(c => c.violations.map(v => `Ch${c.num}: ${v}`))
          .concat(fcResult.crossChecks.filter(x => !x.pass).map(x => `${x.id}: ${x.detail}`));
        console.log(
          `[ExpressPipeline] ${jobId} fiveChapterCheck flagged ${violations.length} structural issue(s): ${violations.slice(0, 5).join(' | ')}`,
        );
      } else {
        console.log(`[ExpressPipeline] ${jobId} fiveChapterCheck clean`);
      }
    } catch (err) {
      console.error(`[ExpressPipeline] ${jobId} fiveChapterCheck error (fall-open):`, err);
    }

    // Round 2 fix — defensive sweep. If any [INSERT: ...] markers somehow
    // survive into blendedText (the chapter-level strip should catch them
    // all, but blend Opus could in principle invent or echo one), strip
    // every sentence containing a marker so the deliverable surface stays
    // clean. The user gets the partial-prose; the soft-note system below
    // tells them what's missing.
    {
      const before = blendedText;
      const stripped = extractAndStripMarkers(blendedText);
      if (stripped.missingPieces.length > 0) {
        console.log(
          `[ExpressPipeline] ${jobId} defensive blend-level strip removed ${stripped.missingPieces.length} marker(s)`,
        );
        blendedText = stripped.cleanContent;
      } else {
        // No markers — leave blendedText untouched.
        blendedText = before;
      }
    }

    await prisma.fiveChapterStory.update({
      where: { id: story.id },
      data: {
        blendedText,
        stage: 'blended',
        version: { increment: 1 },
      },
    });

    // Round 3 fix — blend stage complete; cancel before milestone.
    cancelBlendCheckin();
    // Round 3.1 Item 3 — also cancel the heartbeat so it doesn't fire
    // after the milestone has already landed.
    cancelBlendHeartbeat();
    // Round 3.2 Item 2 — perf logging for blend-end. Includes blend-only
    // duration (Date.now() - blendStartMs) so we can isolate blend
    // latency from the full pipeline runtime.
    console.log(`[Perf] jobId=${jobId} stage=blend-end elapsed_ms=${Date.now() - pipelineStartMs} blend_ms=${Date.now() - blendStartMs} mode=${pipelinePerfMode} variant=${variantIndex + 1}/${variantCount}`);

    // Phase 2 — Milestone 4: Blended ready. Path B narration only.
    await narrateMilestoneIfPathB({
      userId: pipelineUserId,
      workspaceId: pipelineWorkspaceId,
      ctx: {
        storyId: story.id,
        draftId: draftWithElements.id,
        offeringId: draftWithElements.offering.id,
        audienceId: draftWithElements.audience.id,
      },
      milestone: MILESTONE_BLENDED_READY,
    });

    // Round 2 fix — Soft notes for chapter content gaps. Sent as separate
    // chat messages AFTER the blended-ready narration; never appended to
    // the deliverable body. One soft note per gappy chapter (3, 4, or 5).
    // Two signals feed the soft-note system:
    //   1. Tier-level whole-chapter empty (mirrors the silent guardrail
    //      logic): Ch3 if no support column, Ch4 if no named specifics,
    //      Ch5 if no situation. These pass missingPieces=[] so the
    //      template uses EMPTY_CASE_FILL.
    //   2. Chapter-level marker descriptions extracted in the chapter loop
    //      (chapterMissingPieces). These pass natural-language descriptors
    //      so the template lists them.
    // Whole-empty wins over partial: if a chapter is whole-empty per tier
    // rules, we use the empty-case template even if the chapter generator
    // also emitted markers.
    {
      const ctaProvided =
        typeof interpretation.situation === 'string' &&
        interpretation.situation.trim().length > 0;
      const wholeEmptyArr = detectMissingChaptersFromTier({
        hasSupportColumn,
        hasSocialProofColumn,
        namedCustomerCount: namedCustomers.size,
        otherNamedSpecificCount: otherNamedSpecifics.length,
        hasMeaningfulCta: ctaProvided,
      });
      const wholeChapterEmpty = new Set<3 | 4 | 5>(wholeEmptyArr);
      await emitChapterSoftNotes({
        userId: pipelineUserId,
        workspaceId: pipelineWorkspaceId,
        ctx: {
          storyId: story.id,
          draftId: draftWithElements.id,
          offeringId: draftWithElements.offering.id,
          audienceId: draftWithElements.audience.id,
        },
        wholeChapterEmpty,
        chapterMissingPieces,
      });
    }

    // Round 3.1 Item 2 — autonomous post-delivery offer. Fires after the
    // soft notes have completed (the stagger inside emitChapterSoftNotes
    // already paced them). The offer's chip text is persisted in the
    // assistantMessage context so the frontend can detect a click and
    // route correctly (YES navigates to the Three Tier; NO minimizes).
    {
      const interp = (interpretation as unknown as Record<string, any>) || {};
      if (interp.autonomousMode === true) {
        const deliverableType = (typeof interp.deliverableType === 'string' && interp.deliverableType.trim())
          ? interp.deliverableType
          : 'deliverable';
        const offerChips = [
          AUTONOMOUS_POST_DELIVERY_CHIP_YES,
          buildAutonomousPostDeliveryChipNo(deliverableType),
        ];
        await prisma.assistantMessage.create({
          data: {
            userId: pipelineUserId,
            role: 'assistant',
            content: buildAutonomousPostDeliveryOffer(deliverableType),
            context: {
              channel: 'partner',
              workspaceId: pipelineWorkspaceId,
              storyId: story.id,
              draftId: draftWithElements.id,
              offeringId: draftWithElements.offering.id,
              audienceId: draftWithElements.audience.id,
              kind: 'autonomous-post-delivery',
              chips: offerChips,
              autonomousDraftId: draftWithElements.id,
              autonomousStoryId: story.id,
              autonomousDeliverableType: deliverableType,
            },
          },
        });

        // Round 3.1 Item A — gap-focused inline observations on the Three
        // Tier. When the user clicks YES on the post-delivery offer, the
        // existing observation infrastructure surfaces these as inline
        // panels per cell. Suggestion text is prefixed with "[GAP] " so
        // the frontend can render the "Fill this in" input variant
        // distinct from the existing hedge-cleanup Accept/Discuss panel.
        // Detection: tier2 columns whose tier3Bullets are sparse (0 or 1)
        // are the most reliable signal that Maria's content was a best
        // guess given thin user input.
        try {
          const draftForGaps = await prisma.threeTierDraft.findFirst({
            where: { id: draftWithElements.id },
            include: {
              tier1Statement: true,
              tier2Statements: {
                orderBy: { sortOrder: 'asc' },
                include: { tier3Bullets: { orderBy: { sortOrder: 'asc' } } },
              },
            },
          });
          if (draftForGaps) {
            // Per-tier2 gap: any column with 0 or 1 proof bullets is a
            // candidate. Suggestion body is Cowork-authored locked
            // wording (Round 3.1 follow-up); {label} substitutes the
            // column label (ROI / Focus / Support / etc.).
            for (const t2 of draftForGaps.tier2Statements) {
              if (t2.tier3Bullets.length <= 1) {
                const label = (t2.categoryLabel || '').trim() || 'this column';
                const suggestion = `[GAP] I filled this with my best guess from what you gave me. A number, a named customer, or something someone could verify will tighten ${label}.`;
                await prisma.observation.create({
                  data: {
                    draftId: draftForGaps.id,
                    cellType: 'tier2',
                    cellId: t2.id,
                    suggestion,
                    state: 'OPEN',
                  },
                });
              }
            }
            // Tier 1 gap: only flagged when the situation block was empty
            // (hasMeaningfulCta proxies "user told us what they want this
            // to do"). Empty situation means Tier 1 was inferred entirely
            // from the offering+audience. Suggestion body is Cowork-
            // authored locked wording (Round 3.1 follow-up).
            const ctaProvided =
              typeof interpretation.situation === 'string' &&
              interpretation.situation.trim().length > 0;
            if (!ctaProvided && draftForGaps.tier1Statement) {
              const suggestion = `[GAP] I built the top tier from your offering and audience alone — I didn't know what you most want this draft to do. Tell me and I'll tighten it.`;
              await prisma.observation.create({
                data: {
                  draftId: draftForGaps.id,
                  cellType: 'tier1',
                  cellId: draftForGaps.tier1Statement.id,
                  suggestion,
                  state: 'OPEN',
                },
              });
            }
          }
        } catch (gapErr) {
          console.error('[ExpressPipeline] gap-observation create failed (fail-open):', gapErr);
        }
      }
    }

    storyIds.push(story.id);
    } // ─── end variant loop ─────────────────────────────

    // ─── Done ────────────────────────────────────────
    // Persist the full variant list (when multi) plus the primary story id.
    // Single-variant jobs only set resultStoryId, matching the old contract.
    await prisma.expressJob.update({
      where: { id: jobId },
      data: {
        resultStoryId: storyIds[0],
        variantStoryIds:
          storyIds.length > 1 ? (storyIds as unknown as object) : undefined,
      },
    });

    await update({
      status: 'complete',
      stage: 'First draft ready',
      progress: 100,
    });

    // Bundle 1A rev2 W4 — autonomous-build hand-off message. Cowork's
    // verification surfaced that after kicking off an autonomous build,
    // there was no follow-up chat message when the pipeline completed.
    // Path B keeps the chat as the primary surface, so the user needs
    // to know the draft is ready without auto-navigating away. Locked
    // copy: AUTONOMOUS_BUILD_COMPLETE. Fires only in autonomous mode
    // and only on full pipeline success (this code is past the
    // post-delivery offer block; if the pipeline errored, the catch
    // branch below skips this).
    try {
      const interpRef = (interpretation as unknown as Record<string, any>) || {};
      if (interpRef.autonomousMode === true) {
        await prisma.assistantMessage.create({
          data: {
            userId: pipelineUserId,
            role: 'assistant',
            content: AUTONOMOUS_BUILD_COMPLETE,
            context: {
              channel: 'partner',
              workspaceId: pipelineWorkspaceId,
              kind: 'autonomous-build-complete',
            },
          },
        });
      }
    } catch (writeErr) {
      console.error(`[ExpressPipeline] ${jobId} AUTONOMOUS_BUILD_COMPLETE write failed (non-fatal):`, writeErr);
    }

    console.log(
      `[ExpressPipeline] ${jobId} complete (${storyIds.length} variant${
        storyIds.length === 1 ? '' : 's'
      }: ${storyIds.join(', ')})`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await fail(message);
  }
}

// ═══════════════════════════════════════════════════════════════
// Guided Excellence — checkpoint-based pipeline
// ═══════════════════════════════════════════════════════════════

// Step 1: Commit confirmed inputs and build the Three Tier foundation.
// Synchronous — takes ~30-45 seconds. Creates DB rows, runs mapping,
// generates Three Tier with voice check. Returns the full draft data
// so the frontend can display the foundation for review.
export interface FoundationResult {
  draftId: string;
  offeringId: string;
  audienceId: string;
  tier1: { id: string; text: string } | null;
  tier2: {
    id: string;
    text: string;
    categoryLabel: string;
    priorityId: string | null;
    tier3: { id: string; text: string }[];
  }[];
  audienceName: string;
  // Priorities that mapping couldn't cleanly answer, each with a one-sentence
  // description of the kind of differentiator that would close the gap.
  // Maria uses these to interview the user for the missing differentiator.
  // Empty when every priority got a strict or near-strict match.
  gapDescriptions?: { priorityId: string; priorityText: string; missingCapability: string }[];
}

export async function commitAndBuildFoundation(
  interpretation: ExpressInterpretation,
  userId: string,
  workspaceId: string,
): Promise<FoundationResult> {
  if (!interpretation.audiences || interpretation.audiences.length === 0) {
    throw new Error('Need at least one audience.');
  }

  const primaryAudience = interpretation.audiences[0];
  const cleanedDiffs = interpretation.offering.differentiators
    .map(d => ({ text: d.text.trim(), source: d.source, mf: (d as any).motivatingFactor || '' }))
    .filter(d => d.text.length > 0);
  const cleanedPriorities = primaryAudience.priorities
    .map(p => ({ text: p.text.trim(), source: p.source, driver: (p as any).driver || '' }))
    .filter(p => p.text.length > 0);

  if (cleanedDiffs.length === 0) throw new Error('Need at least one differentiator.');
  if (cleanedPriorities.length === 0) throw new Error('Need at least one priority.');

  const offering = await prisma.offering.create({
    data: {
      userId,
      workspaceId,
      name: interpretation.offering.name.trim() || 'My offering',
      description: interpretation.offering.description.trim(),
      elements: {
        create: cleanedDiffs.map((d, i) => ({
          text: d.text,
          source: d.source === 'stated' ? 'manual' : 'ai_extracted',
          sortOrder: i,
          motivatingFactor: d.mf,
        })),
      },
    },
    include: { elements: { orderBy: { sortOrder: 'asc' } } },
  });

  const audience = await prisma.audience.create({
    data: {
      userId,
      workspaceId,
      name: primaryAudience.name.trim() || 'My audience',
      description: primaryAudience.description.trim(),
      priorities: {
        create: cleanedPriorities.map((p, i) => ({
          text: p.text,
          rank: i + 1,
          sortOrder: i,
          driver: p.driver,
        })),
      },
    },
    include: { priorities: { orderBy: { sortOrder: 'asc' } } },
  });

  const draft = await prisma.threeTierDraft.create({
    data: {
      offeringId: offering.id,
      audienceId: audience.id,
      currentStep: 5,
    },
  });

  // ── Mapping ────────────────────────────────────
  const mappingMessage = `PRIORITIES (ranked by importance):
${audience.priorities
  .map(p => `- [ID: ${p.id}] [Rank ${p.rank}] "${p.text}"`)
  .join('\n')}

CAPABILITIES/DIFFERENTIATORS:
${offering.elements
  .map(e => `- [ID: ${e.id}] "${e.text}"${e.motivatingFactor ? ` (MF: ${e.motivatingFactor})` : ''}`)
  .join('\n')}`;

  type MappingResult = {
    mappings: {
      priorityId: string;
      elementId: string;
      confidence: number;
      strengthSignal?: 'STRONG' | 'HONEST_BUT_THIN' | 'EXAGGERATED' | null;
      failurePattern?: string | null;
      mfRationale?: string;
    }[];
    gapDescriptions?: { priorityId: string; missingCapability: string }[];
    noStrongPairings?: boolean;
  };

  const mappingResult = await callAIWithJSON<MappingResult>(
    MAPPING_SYSTEM,
    mappingMessage,
    'fast',
  );

  const validPriorityIds = new Set(audience.priorities.map(p => p.id));
  const validElementIds = new Set(offering.elements.map(e => e.id));
  const cleanMappings = (mappingResult.mappings || []).filter(
    m => validPriorityIds.has(m.priorityId) && validElementIds.has(m.elementId),
  );

  // Mapping gaps: priorities whose Drivers no differentiator's MF can
  // honestly answer. Maria uses these to interview the user for what's
  // missing about the offering.
  const priorityById = new Map(audience.priorities.map(p => [p.id, p] as const));
  const foundationGaps = (mappingResult.gapDescriptions || [])
    .filter(g => validPriorityIds.has(g.priorityId) && g.missingCapability)
    .map(g => ({
      priorityId: g.priorityId,
      priorityText: priorityById.get(g.priorityId)?.text || '',
      missingCapability: g.missingCapability,
    }));

  // Audience-fit signal (Change 2): persist on the draft so Maria's downstream
  // context can fire the humble-curiosity audience-fit conversation when
  // every pairing is non-STRONG.
  const computedNoStrong = !cleanMappings.some(m => m.strengthSignal === 'STRONG');
  const noStrongPairings = mappingResult.noStrongPairings === undefined
    ? computedNoStrong
    : Boolean(mappingResult.noStrongPairings);
  await prisma.threeTierDraft.update({
    where: { id: draft.id },
    data: { noStrongPairings },
  });

  // The mapping prompt tells the model not to emit below 0.4. This floor
  // stays at 0.5 as a safety net for weak emissions. EXAGGERATED mappings
  // are not stored as confirmed — they flow through gapDescriptions.
  for (const m of cleanMappings.filter(
    m => m.confidence >= 0.5 && m.strengthSignal !== 'EXAGGERATED',
  )) {
    await prisma.mapping.create({
      data: {
        draftId: draft.id,
        priorityId: m.priorityId,
        elementId: m.elementId,
        confidence: m.confidence,
        status: 'confirmed',
        mfRationale: m.mfRationale || '',
        strengthSignal: m.strengthSignal || null,
        failurePattern: m.failurePattern || null,
      },
    });
  }

  // ── Three Tier generation ──────────────────────
  const confirmedMappings = await prisma.mapping.findMany({
    where: { draftId: draft.id, status: 'confirmed' },
    include: { priority: true, element: true },
  });

  if (confirmedMappings.length === 0) {
    throw new Error('No mappings could be generated. Try editing your inputs.');
  }

  const byPriority = new Map<
    string,
    { priority: typeof confirmedMappings[0]['priority']; elements: typeof confirmedMappings[0]['element'][] }
  >();
  for (const m of confirmedMappings) {
    if (!byPriority.has(m.priorityId)) {
      byPriority.set(m.priorityId, { priority: m.priority, elements: [] });
    }
    byPriority.get(m.priorityId)!.elements.push(m.element);
  }

  const mappedElementIds = new Set(confirmedMappings.map(m => m.elementId));
  const orphanElements = offering.elements.filter(e => !mappedElementIds.has(e.id));

  const convertMessage = `CONFIRMED MAPPINGS (grouped by priority, in rank order):
${audience.priorities
  .filter(p => byPriority.has(p.id))
  .map(p => {
    const group = byPriority.get(p.id)!;
    return `Priority [ID: ${p.id}] [Rank ${p.rank}]: "${p.text}"
  Driver (why this matters to them): ${p.driver || 'not specified'}
  Mapped capabilities: ${group.elements.map(e => `"${e.text}"`).join(', ')}`;
  })
  .join('\n\n')}
${
  orphanElements.length > 0
    ? `\nORPHAN CAPABILITIES (not mapped to any priority — use for Social Proof or Focus columns):\n${orphanElements
        .map(e => `- "${e.text}"`)
        .join('\n')}`
    : ''
}
AUDIENCE: ${audience.name}`;

  type TierResult = {
    tier1: { text: string; priorityId: string };
    tier2: {
      text: string;
      priorityId?: string;
      categoryLabel: string;
      tier3: string[];
    }[];
  };

  async function generateTierWithVoiceCheck(): Promise<TierResult> {
    const first = await callAIWithJSON<TierResult>(
      CONVERT_LINES_SYSTEM,
      convertMessage,
      'elite',
    );
    try {
      const priorityById = new Map(audience.priorities.map(p => [p.id, p]));
      const statements: StatementInput[] = [];
      if (first.tier1?.text) {
        statements.push({
          text: first.tier1.text,
          column: 'Tier 1',
          priorityText: priorityById.get(first.tier1.priorityId)?.text,
        });
      }
      for (const t2 of first.tier2 || []) {
        statements.push({
          text: t2.text,
          column: t2.categoryLabel || '',
          priorityText: t2.priorityId ? priorityById.get(t2.priorityId)?.text : undefined,
        });
      }
      const check = await checkStatements(statements);
      if (!check.passed) {
        console.log(`[GuidedFoundation] voice check found ${check.violations.length} violations, retrying`);
        const feedback = buildViolationFeedback(check.violations);
        return await callAIWithJSON<TierResult>(
          CONVERT_LINES_SYSTEM,
          convertMessage + feedback,
          'elite',
        );
      }
    } catch (err) {
      console.error('[GuidedFoundation] voice check error (fail-open):', err);
    }
    return first;
  }

  const tierResult = await generateTierWithVoiceCheck();

  let tier1Row: { id: string; text: string } | null = null;
  if (tierResult.tier1?.text) {
    tier1Row = await prisma.tier1Statement.create({
      data: { draftId: draft.id, text: tierResult.tier1.text },
    });
  }

  const tier2Rows: FoundationResult['tier2'] = [];
  for (let i = 0; i < (tierResult.tier2 || []).length; i++) {
    const t2 = tierResult.tier2[i];
    const validT2Priority = t2.priorityId && validPriorityIds.has(t2.priorityId)
      ? t2.priorityId
      : null;
    const tier2 = await prisma.tier2Statement.create({
      data: {
        draftId: draft.id,
        text: t2.text,
        sortOrder: i,
        priorityId: validT2Priority,
        categoryLabel: t2.categoryLabel || '',
      },
    });
    const t3Rows: { id: string; text: string }[] = [];
    if (Array.isArray(t2.tier3)) {
      for (let j = 0; j < t2.tier3.length; j++) {
        const bullet = await prisma.tier3Bullet.create({
          data: { tier2Id: tier2.id, text: t2.tier3[j], sortOrder: j },
        });
        t3Rows.push({ id: bullet.id, text: bullet.text });
      }
    }
    tier2Rows.push({
      id: tier2.id,
      text: tier2.text,
      categoryLabel: tier2.categoryLabel,
      priorityId: validT2Priority,
      tier3: t3Rows,
    });
  }

  // Phase 2 — Milestone 1 narration. Path B only (live toggle read).
  // Fires once when the foundation row is fully written and we're about to
  // hand back to the caller for the user's review.
  await narrateMilestoneIfPathB({
    userId,
    workspaceId,
    ctx: { draftId: draft.id, offeringId: offering.id, audienceId: audience.id },
    milestone: MILESTONE_FOUNDATION_CONFIRMED,
  });

  return {
    draftId: draft.id,
    offeringId: offering.id,
    audienceId: audience.id,
    tier1: tier1Row,
    tier2: tier2Rows,
    audienceName: audience.name,
    gapDescriptions: foundationGaps.length > 0 ? foundationGaps : undefined,
  };
}

// Re-run mapping + Tier generation against an existing guided draft.
// Called after Maria's gap interview adds a new differentiator to the
// offering — the user wants to see the Tier 1 with the new differentiator
// included. Wipes prior mappings and tier rows for this draft, then
// regenerates from the current DB state (so any newly-added differentiators
// are picked up). Returns the same FoundationResult shape as the initial
// build, including any remaining gapDescriptions.
//
// Note: this duplicates a substantial chunk of commitAndBuildFoundation's
// post-creation logic. A future refactor should extract the shared
// mapping + tier generation into a helper. Duplication is accepted here
// to keep scope bounded.
export async function rebuildFoundationFromDraft(
  draftId: string,
  userId: string,
  workspaceId: string,
  // leadHint: when the user gives positional direction (e.g. "lead with X"),
  // this carries their words verbatim. Tier 1 generation receives it as a
  // hard constraint: the because-clause must start with the named element.
  // Optional — undefined means no positional bias, normal generation.
  leadHint?: string,
): Promise<FoundationResult> {
  const draft = await prisma.threeTierDraft.findFirst({
    where: {
      id: draftId,
      offering: { workspaceId, userId },
    },
    include: {
      offering: { include: { elements: { orderBy: { sortOrder: 'asc' } } } },
      audience: { include: { priorities: { orderBy: { sortOrder: 'asc' } } } },
    },
  });

  if (!draft) {
    throw new Error('Draft not found, or does not belong to this workspace.');
  }

  const offering = draft.offering;
  const audience = draft.audience;

  if (offering.elements.length === 0) {
    throw new Error('Offering has no differentiators — add at least one before rebuilding.');
  }
  if (audience.priorities.length === 0) {
    throw new Error('Audience has no priorities — add at least one before rebuilding.');
  }

  // Wipe existing mappings + tier rows so we regenerate cleanly.
  await prisma.mapping.deleteMany({ where: { draftId: draft.id } });
  await prisma.tier3Bullet.deleteMany({
    where: { tier2: { draftId: draft.id } },
  });
  await prisma.tier2Statement.deleteMany({ where: { draftId: draft.id } });
  await prisma.tier1Statement.deleteMany({ where: { draftId: draft.id } });

  // ── Mapping ────────────────────────────────────
  const mappingMessage = `PRIORITIES (ranked by importance):
${audience.priorities
  .map(p => `- [ID: ${p.id}] [Rank ${p.rank}] "${p.text}"${p.driver ? ` (Driver: ${p.driver})` : ''}`)
  .join('\n')}

CAPABILITIES/DIFFERENTIATORS:
${offering.elements
  .map(e => `- [ID: ${e.id}] "${e.text}"${e.motivatingFactor ? ` (MF: ${e.motivatingFactor})` : ''}`)
  .join('\n')}`;

  type MappingResult = {
    mappings: {
      priorityId: string;
      elementId: string;
      confidence: number;
      strengthSignal?: 'STRONG' | 'HONEST_BUT_THIN' | 'EXAGGERATED' | null;
      failurePattern?: string | null;
      mfRationale?: string;
    }[];
    gapDescriptions?: { priorityId: string; missingCapability: string }[];
    noStrongPairings?: boolean;
  };

  const mappingResult = await callAIWithJSON<MappingResult>(
    MAPPING_SYSTEM,
    mappingMessage,
    'fast',
  );

  const validPriorityIds = new Set(audience.priorities.map(p => p.id));
  const validElementIds = new Set(offering.elements.map(e => e.id));
  const cleanMappings = (mappingResult.mappings || []).filter(
    m => validPriorityIds.has(m.priorityId) && validElementIds.has(m.elementId),
  );

  const priorityById = new Map(audience.priorities.map(p => [p.id, p] as const));
  const foundationGaps = (mappingResult.gapDescriptions || [])
    .filter(g => validPriorityIds.has(g.priorityId) && g.missingCapability)
    .map(g => ({
      priorityId: g.priorityId,
      priorityText: priorityById.get(g.priorityId)?.text || '',
      missingCapability: g.missingCapability,
    }));

  const computedNoStrong = !cleanMappings.some(m => m.strengthSignal === 'STRONG');
  const noStrongPairings = mappingResult.noStrongPairings === undefined
    ? computedNoStrong
    : Boolean(mappingResult.noStrongPairings);
  await prisma.threeTierDraft.update({
    where: { id: draft.id },
    data: { noStrongPairings },
  });

  for (const m of cleanMappings.filter(
    m => m.confidence >= 0.5 && m.strengthSignal !== 'EXAGGERATED',
  )) {
    await prisma.mapping.create({
      data: {
        draftId: draft.id,
        priorityId: m.priorityId,
        elementId: m.elementId,
        confidence: m.confidence,
        status: 'confirmed',
        mfRationale: m.mfRationale || '',
        strengthSignal: m.strengthSignal || null,
        failurePattern: m.failurePattern || null,
      },
    });
  }

  const confirmedMappings = await prisma.mapping.findMany({
    where: { draftId: draft.id, status: 'confirmed' },
    include: { priority: true, element: true },
  });

  if (confirmedMappings.length === 0) {
    throw new Error('No mappings could be generated. Try adding a differentiator that speaks to your audience.');
  }

  const byPriority = new Map<
    string,
    { priority: typeof confirmedMappings[0]['priority']; elements: typeof confirmedMappings[0]['element'][] }
  >();
  for (const m of confirmedMappings) {
    if (!byPriority.has(m.priorityId)) {
      byPriority.set(m.priorityId, { priority: m.priority, elements: [] });
    }
    byPriority.get(m.priorityId)!.elements.push(m.element);
  }

  const mappedElementIds = new Set(confirmedMappings.map(m => m.elementId));
  const orphanElements = offering.elements.filter(e => !mappedElementIds.has(e.id));

  const convertMessage = `CONFIRMED MAPPINGS (grouped by priority, in rank order):
${audience.priorities
  .filter(p => byPriority.has(p.id))
  .map(p => {
    const group = byPriority.get(p.id)!;
    return `Priority [ID: ${p.id}] [Rank ${p.rank}]: "${p.text}"
  Driver (why this matters to them): ${p.driver || 'not specified'}
  Mapped capabilities: ${group.elements.map(e => `"${e.text}"`).join(', ')}`;
  })
  .join('\n\n')}
${
  orphanElements.length > 0
    ? `\nORPHAN CAPABILITIES (not mapped to any priority — use for Social Proof or Focus columns):\n${orphanElements
        .map(e => `- "${e.text}"`)
        .join('\n')}`
    : ''
}${
  leadHint
    ? `\n\nLEAD DIRECTIVE FROM USER (HONOR THIS PRECISELY): The user has explicitly directed that Tier 1 lead with "${leadHint}". This is a position constraint, not a content suggestion. The Tier 1 because-clause MUST anchor on this element — start it with this idea, in the user's words or close to them. Other mapped capabilities can support but cannot displace the lead. If the directive does not align with any mapped capability, treat the directive as the lead anyway and let the Tier 2 columns carry the supporting capabilities.`
    : ''
}
AUDIENCE: ${audience.name}`;

  type TierResult = {
    tier1: { text: string; priorityId: string };
    tier2: {
      text: string;
      priorityId?: string;
      categoryLabel: string;
      tier3: string[];
    }[];
  };

  async function generateTierWithVoiceCheck(): Promise<TierResult> {
    const first = await callAIWithJSON<TierResult>(
      CONVERT_LINES_SYSTEM,
      convertMessage,
      'elite',
    );
    try {
      const pById = new Map(audience.priorities.map(p => [p.id, p]));
      const statements: StatementInput[] = [];
      if (first.tier1?.text) {
        statements.push({
          text: first.tier1.text,
          column: 'Tier 1',
          priorityText: pById.get(first.tier1.priorityId)?.text,
        });
      }
      for (const t2 of first.tier2 || []) {
        statements.push({
          text: t2.text,
          column: t2.categoryLabel || '',
          priorityText: t2.priorityId ? pById.get(t2.priorityId)?.text : undefined,
        });
      }
      const check = await checkStatements(statements);
      if (!check.passed) {
        console.log(`[GuidedRebuild] voice check found ${check.violations.length} violations, retrying`);
        const feedback = buildViolationFeedback(check.violations);
        return await callAIWithJSON<TierResult>(
          CONVERT_LINES_SYSTEM,
          convertMessage + feedback,
          'elite',
        );
      }
    } catch (err) {
      console.error('[GuidedRebuild] voice check error (fail-open):', err);
    }
    return first;
  }

  const tierResult = await generateTierWithVoiceCheck();

  let tier1Row: { id: string; text: string } | null = null;
  if (tierResult.tier1?.text) {
    tier1Row = await prisma.tier1Statement.create({
      data: { draftId: draft.id, text: tierResult.tier1.text },
    });
  }

  const tier2Rows: FoundationResult['tier2'] = [];
  for (let i = 0; i < (tierResult.tier2 || []).length; i++) {
    const t2 = tierResult.tier2[i];
    const validT2Priority = t2.priorityId && validPriorityIds.has(t2.priorityId)
      ? t2.priorityId
      : null;
    const tier2 = await prisma.tier2Statement.create({
      data: {
        draftId: draft.id,
        text: t2.text,
        sortOrder: i,
        priorityId: validT2Priority,
        categoryLabel: t2.categoryLabel || '',
      },
    });
    const t3Rows: { id: string; text: string }[] = [];
    if (Array.isArray(t2.tier3)) {
      for (let j = 0; j < t2.tier3.length; j++) {
        const bullet = await prisma.tier3Bullet.create({
          data: { tier2Id: tier2.id, text: t2.tier3[j], sortOrder: j },
        });
        t3Rows.push({ id: bullet.id, text: bullet.text });
      }
    }
    tier2Rows.push({
      id: tier2.id,
      text: tier2.text,
      categoryLabel: tier2.categoryLabel,
      priorityId: validT2Priority,
      tier3: t3Rows,
    });
  }

  return {
    draftId: draft.id,
    offeringId: offering.id,
    audienceId: audience.id,
    tier1: tier1Row,
    tier2: tier2Rows,
    audienceName: audience.name,
    gapDescriptions: foundationGaps.length > 0 ? foundationGaps : undefined,
  };
}

// Step 2: Build a Five Chapter draft from a confirmed foundation.
// Async with polling — takes ~2-3 minutes. Creates an ExpressJob,
// runs chapters + blend in the background. The frontend polls status.
export async function buildDraftFromFoundation(
  draftId: string,
  medium: string,
  cta: string,
  situation: string,
  userId: string,
  workspaceId: string,
): Promise<{ jobId: string; storyId: string }> {
  const draftForStory = await prisma.threeTierDraft.findFirst({
    where: { id: draftId },
    include: {
      tier1Statement: true,
      tier2Statements: {
        orderBy: { sortOrder: 'asc' },
        include: {
          tier3Bullets: { orderBy: { sortOrder: 'asc' } },
          priority: true,
        },
      },
      offering: { include: { elements: true } },
      audience: { include: { priorities: { orderBy: { sortOrder: 'asc' } } } },
    },
  });
  if (!draftForStory) throw new Error('Draft not found.');
  if (!draftForStory.tier1Statement) throw new Error('Foundation has no Tier 1 — build it first.');

  const mediumKey = pickInternalMedium(medium);
  const mediumSpec = getMediumSpec(mediumKey);

  const story = await prisma.fiveChapterStory.create({
    data: {
      draftId,
      medium: mediumKey,
      customName: `${medium} · ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
      cta: cta || `Get started with ${draftForStory.offering.name || 'us'}`,
    },
  });

  const job = await prisma.expressJob.create({
    data: {
      userId,
      workspaceId,
      draftId,
      status: 'pending',
      stage: 'Writing your first draft',
      progress: 5,
      resultStoryId: story.id,
      interpretation: { guided: true, medium, cta, situation } as unknown as object,
    },
  });

  // Fire the chapter generation pipeline in the background
  setImmediate(() => {
    runDraftPipeline(job.id, story.id, draftForStory, mediumKey, mediumSpec, cta, situation)
      .catch(err => console.error(`[GuidedDraft] Uncaught error for job ${job.id}:`, err));
  });

  return { jobId: job.id, storyId: story.id };
}

// Internal: runs the Five Chapter generation pipeline for a guided draft.
// Reuses the same chapter generation, voice check, and fabrication check
// logic as the autonomous pipeline but operates on a single confirmed draft.
async function runDraftPipeline(
  jobId: string,
  storyId: string,
  draftForStory: any,
  mediumKey: string,
  mediumSpec: ReturnType<typeof getMediumSpec>,
  cta: string,
  situation: string,
): Promise<void> {
  async function update(data: Partial<{
    status: string; stage: string; progress: number; error: string;
  }>) {
    try {
      await prisma.expressJob.update({ where: { id: jobId }, data });
    } catch (err) {
      console.error(`[GuidedDraft] ${jobId} failed to update job:`, err);
    }
  }

  try {
    // Phase 2 — read userId / workspaceId / draftId from the job row so the
    // helpers can write milestone narrations + soft notes into the partner
    // conversation. Capture start ms + initial Tier 1 text so the
    // foundational-shift pause helper can detect mid-pipeline edits.
    const jobRow = await prisma.expressJob.findUnique({
      where: { id: jobId },
      select: { userId: true, workspaceId: true, draftId: true },
    });
    const guidedUserId = jobRow?.userId || '';
    const guidedWorkspaceId = jobRow?.workspaceId || '';
    const guidedDraftId = jobRow?.draftId || draftForStory?.id || '';
    const guidedPipelineStartMs = Date.now();
    const guidedShiftPauseFlag = { value: false };
    let guidedInitialTier1Text = draftForStory?.tier1Statement?.text || '';
    // Round 3.2 Item 2 — perf logging (guided pipeline). Tier-generation
    // happens in commitAndBuildFoundation upstream, so this pipeline only
    // covers chapters + blend stages. We log mapping-start as a baseline
    // marker for parity with runPipeline's grep pattern.
    console.log(`[Perf] jobId=${jobId} stage=guided-pipeline-start elapsed_ms=0 mode=guided variant=1/1`);
    // Round 3 fix — per-pipeline stage-checkin flags (guided).
    const guidedStageCheckinFlags = makeStageCheckinFlags();

    // Detect support/social proof content for guardrails
    const tier2Labels = draftForStory.tier2Statements
      .map((t: any) => (t.categoryLabel || '').toLowerCase())
      .filter((l: string) => l.length > 0);
    const hasSupportColumn = tier2Labels.some((l: string) =>
      /support|onboard|service|help|success|implement/.test(l),
    );
    const hasSocialProofColumn = tier2Labels.some((l: string) =>
      /social|proof|recognition|customer|testimonial|reference/.test(l),
    );
    // Typed social proof extraction (same path as runPipeline). Replaces the
    // narrow customer-suffix regex that was here — certifications, awards,
    // publications, individuals, and adoption numbers are now also available
    // to Chapter 4 as valid citable proof.
    const allTier3BulletsGuided: string[] = [];
    for (const t2 of draftForStory.tier2Statements) {
      for (const b of t2.tier3Bullets) {
        if (b.text && b.text.trim().length > 0) {
          allTier3BulletsGuided.push(b.text.trim());
        }
      }
    }
    const socialProofGuided = await extractSocialProof(allTier3BulletsGuided);
    const groupedGuided = groupByType(socialProofGuided.items);
    const namedCustomers = new Set<string>([
      ...groupedGuided.customer,
      ...groupedGuided.adoption_number,
    ]);
    const otherNamedSpecificsGuided: SocialProofItem[] = socialProofGuided.items.filter(
      it => it.type !== 'customer' && it.type !== 'adoption_number',
    );

    function buildChapterGuardrails(chapterNum: number): string {
      if (chapterNum === 3 && !hasSupportColumn) {
        return '\nCHAPTER 3 GUARDRAIL: No support content in the Three Tier. Do NOT invent onboarding, pilots, timelines, or team commitments. Write reassurance from facts already in the Three Tier only.';
      }
      if (chapterNum === 4) {
        const customerList = [...namedCustomers];
        const otherList = otherNamedSpecificsGuided.map(s => `${s.name} (${s.type})`);
        if (customerList.length === 0 && otherList.length === 0 && !hasSocialProofColumn) {
          return '\nCHAPTER 4 GUARDRAIL: No named specifics in the Three Tier — no customers, certifications, awards, publications, or regulators. Do NOT invent customer names, counts, or composite references. Re-anchor in the reader\'s own situation. A short chapter is fine.';
        }
        const allowed: string[] = [];
        if (customerList.length > 0) allowed.push(`Customers/adoption: ${customerList.join(', ')}`);
        if (otherList.length > 0) allowed.push(`Other named specifics: ${otherList.join(', ')}`);
        return `\nCHAPTER 4 GUARDRAIL: You may cite ONLY these named specifics from the Three Tier — nothing else. No "banks like yours", no "multiple customers", no counts not listed here, no invented metrics.\n${allowed.join('\n')}`;
      }
      if (chapterNum === 5) {
        return `\nCHAPTER 5 GUARDRAIL: CTA is "${cta}". Do NOT invent trial options, sandbox environments, or pilot programs not in the source. For senior executives, offer paths, not directives.`;
      }
      return '';
    }

    // Chapter 1 strategic thesis
    let ch1Thesis = '';
    try {
      const thesisPrompt = `You are writing ONE sentence — a market truth a senior executive would independently recognize.

AUDIENCE: ${draftForStory.audience.name}
TOP PRIORITY: "${draftForStory.audience.priorities[0]?.text || ''}"
DRIVER: "${draftForStory.audience.priorities[0]?.driver || ''}"

Write a single sentence: "[Category condition] means [business consequence]."
This must be a truth about the MARKET or INDUSTRY — NOT a claim about the reader's team.
Return ONLY the one sentence.`;
      ch1Thesis = await callAI(thesisPrompt, '', 'elite');
      ch1Thesis = ch1Thesis.replace(/^["']|["']$/g, '').trim();
    } catch (err) {
      console.error('[GuidedDraft] Ch1 thesis failed:', err);
    }

    // Phase 2 — Fix 3: chapter regeneration loop. Identical pattern to runPipeline:
    // up to GUIDED_MAX_REGEN_CYCLES regeneration cycles. Cap exists only to
    // bound runaway loops; normal use rarely exceeds two follow-up edits.
    const GUIDED_MAX_REGEN_CYCLES = 3;
    let guidedChapterRegenCount = 0;
    // Round 2 fix — same per-chapter missing-piece accumulator as
    // runPipeline. Resets at the top of each regen cycle.
    let guidedChapterMissingPieces: Record<3 | 4 | 5, string[]> = { 3: [], 4: [], 5: [] };
    // Round 3 fix — chapters stage check-in (guided). Tier check-in is
    // skipped for the guided path because foundation generation runs in
    // commitAndBuildFoundation synchronously before this background
    // pipeline starts; the user is on a loading state, not chat.
    const cancelGuidedChaptersCheckin = scheduleStageCheckin({
      stage: 'chapters',
      message: STAGE_CHECKIN_CHAPTERS,
      flags: guidedStageCheckinFlags,
      userId: guidedUserId,
      workspaceId: guidedWorkspaceId,
      ctx: {
        storyId,
        draftId: guidedDraftId,
        offeringId: draftForStory.offering?.id,
        audienceId: draftForStory.audience?.id,
      },
    });
    // Round 3.3 Item 1 — chapters heartbeat for the guided pipeline.
    const cancelGuidedChaptersHeartbeat = scheduleStageCheckin({
      stage: 'chapters-heartbeat',
      message: CHAPTERS_HEARTBEAT,
      flags: guidedStageCheckinFlags,
      userId: guidedUserId,
      workspaceId: guidedWorkspaceId,
      ctx: {
        storyId,
        draftId: guidedDraftId,
        offeringId: draftForStory.offering?.id,
        audienceId: draftForStory.audience?.id,
      },
      delayMs: CHAPTERS_HEARTBEAT_MS,
      kind: 'chapters-heartbeat',
    });
    console.log(`[Perf] jobId=${jobId} stage=chapters-start elapsed_ms=${Date.now() - guidedPipelineStartMs} mode=guided variant=1/1`);
    do {
    guidedChapterMissingPieces = { 3: [], 4: [], 5: [] };
    for (let chapterNum = 1; chapterNum <= 5; chapterNum++) {
      await update({
        status: `chapter_${chapterNum}`,
        stage: `Writing section ${chapterNum} of 5`,
        progress: 10 + chapterNum * 15,
      });

      const systemPrompt = buildChapterPrompt(chapterNum, mediumKey);
      const ch = CHAPTER_CRITERIA[chapterNum - 1];
      const chapterGuardrail = buildChapterGuardrails(chapterNum);
      const prevChapters = await prisma.chapterContent.findMany({
        where: { storyId, chapterNum: { lt: chapterNum } },
        orderBy: { chapterNum: 'asc' },
      });

      const situationBlock = situation
        ? `SITUATION — THIS IS WHAT THE DRAFT MUST DO:\n${situation}\n\n`
        : '';

      const readerDirective = `\nTHE READER: "${draftForStory.audience.name}" is the person reading this.${
        chapterNum === 1
          ? ` The opening must be a BUSINESS THESIS at the strategic level.${ch1Thesis ? ` USE THIS AS YOUR OPENING THESIS: "${ch1Thesis}"` : ''}`
          : chapterNum === 2
            ? ' Do NOT open with the product name as the sentence subject.'
            : ''
      }\n`;

      const threeTierBlock = chapterNum === 1 ? '' : `
THREE TIER MESSAGE:
Tier 1: "${draftForStory.tier1Statement?.text || ''}"
${draftForStory.tier2Statements
  .map(
    (t2: any, i: number) => `Tier 2 #${i + 1}: "${t2.text}" (Priority: "${t2.priority?.text || 'unlinked'}"${
      t2.priority?.driver ? `, Driver: "${t2.priority.driver}"` : ''
    })
  Proof: ${t2.tier3Bullets.map((t3: any) => t3.text).join(', ')}`,
  )
  .join('\n')}
`;

      // Round 3.2 Item 9 follow-up — same cta-verbatim directive as
      // runPipeline's chapter-5 generator. When the user's specific
      // ask was preserved as cta, chapter-5 must include the exact
      // phrase, not a paraphrase.
      const guidedCtaVerbatimDirective = chapterNum === 5 && cta
        ? `\nCTA VERBATIM REQUIREMENT — the call-to-action in this chapter must include the exact phrase "${cta}" verbatim. Do not paraphrase, summarize, soften, or rewrite the user's ask. Other surrounding language can be yours, but the verbatim phrase must appear in the chapter as the action the reader is invited to take.\n`
        : '';

      const userMessage = `${situationBlock}${chapterNum === 1 ? '' : `OFFERING: ${draftForStory.offering.name}\n`}AUDIENCE: ${draftForStory.audience.name}
CONTENT FORMAT: ${mediumSpec.label} (${mediumSpec.wordRange[0]}-${mediumSpec.wordRange[1]} words total)
${chapterNum === 1 ? '' : `CTA: ${cta}\n`}${readerDirective}${guidedCtaVerbatimDirective}
${threeTierBlock}
AUDIENCE PRIORITIES:
${draftForStory.audience.priorities
  .map((p: any) => `[Rank ${p.rank}] "${p.text}"${p.driver ? ` — Driver: "${p.driver}"` : ''}`)
  .join('\n')}

${prevChapters.length > 0 ? `PREVIOUS CHAPTERS:\n${prevChapters.map((c: any) => `Ch ${c.chapterNum}: ${c.content.substring(0, 500)}`).join('\n')}\n` : ''}
Write Chapter ${chapterNum}: "${ch.name}"
Start fresh. Each chapter is self-contained.
${chapterNum > 1 ? 'CRITICAL — NO FABRICATION. Only assert claims from the Three Tier or Situation above.' : ''}
${chapterGuardrail}`;

      let content = await callAI(systemPrompt, userMessage, 'elite');

      // Voice check
      try {
        const proseCheck = await checkProse(content, `Chapter ${chapterNum}: ${ch.name}`);
        if (!proseCheck.passed && proseCheck.violations.length > 0) {
          const feedback = buildProseViolationFeedback(proseCheck.violations);
          content = await callAI(systemPrompt, userMessage + feedback, 'elite');
        }
      } catch (err) {
        console.error(`[GuidedDraft] ch${chapterNum} voice check error (fail-open):`, err);
      }

      // Fabrication check — matches runPipeline: 2 retries with cumulative
      // violation feedback, then surgical redaction if still dirty. Same
      // quality both paths (Q2c commitment).
      const tierTextForCheck = `Tier 1: "${draftForStory.tier1Statement?.text || ''}"
${draftForStory.tier2Statements.map((t2: any, i: number) => `Tier 2 #${i + 1}: "${t2.text}" Proof: ${t2.tier3Bullets.map((b: any) => b.text).join(', ')}`).join('\n')}`;
      const prioritiesTextForCheck = draftForStory.audience.priorities
        .map((p: any) => `[Rank ${p.rank}] "${p.text}"`)
        .join('\n');
      try {
        const cumulativeViolations: string[] = [];
        let brokeClean = false;
        for (let attempt = 0; attempt < 2; attempt++) {
          const fabCheck = await checkChapterFabrication({
            situation,
            tierText: tierTextForCheck,
            prioritiesText: prioritiesTextForCheck,
            chapterContent: content,
          });
          if (fabCheck.passed || fabCheck.violations.length === 0) {
            brokeClean = true;
            break;
          }
          for (const v of fabCheck.violations) cumulativeViolations.push(v);
          const feedback = buildFabricationFeedback(cumulativeViolations);
          content = await callAI(systemPrompt, userMessage + feedback, 'elite');
        }
        if (!brokeClean) {
          const finalCheck = await checkChapterFabrication({
            situation,
            tierText: tierTextForCheck,
            prioritiesText: prioritiesTextForCheck,
            chapterContent: content,
          });
          if (!(finalCheck.passed || finalCheck.violations.length === 0)) {
            const redacted = await redactChapterViolations({
              chapterContent: content,
              violations: finalCheck.violations,
            });
            if (redacted && redacted.length > 0) content = redacted;
          }
        }
      } catch (err) {
        console.error(`[GuidedDraft] ch${chapterNum} fabrication check error (fail-open):`, err);
      }

      // Altitude check — Chapter 1 only, matches runPipeline pattern.
      if (chapterNum === 1) {
        try {
          const topPriorityText = draftForStory.audience.priorities[0]?.text || '';
          const topPriorityDriver = draftForStory.audience.priorities[0]?.driver || '';
          const audienceName = draftForStory.audience.name;
          const cumulativeAltViolations: string[] = [];
          let altBrokeClean = false;
          for (let attempt = 0; attempt < 2; attempt++) {
            const altCheck = await checkChapterOneAltitude({
              audienceName,
              topPriority: topPriorityText,
              driver: topPriorityDriver,
              chapterContent: content,
            });
            if (altCheck.passed || altCheck.violations.length === 0) {
              altBrokeClean = true;
              break;
            }
            for (const v of altCheck.violations) cumulativeAltViolations.push(v);
            const feedback = buildAltitudeFeedback(cumulativeAltViolations);
            content = await callAI(systemPrompt, userMessage + feedback, 'elite');
          }
          if (!altBrokeClean) {
            const finalAlt = await checkChapterOneAltitude({
              audienceName,
              topPriority: topPriorityText,
              driver: topPriorityDriver,
              chapterContent: content,
            });
            if (!(finalAlt.passed || finalAlt.violations.length === 0)) {
              const elevated = await elevateChapterOne({
                chapterContent: content,
                violations: finalAlt.violations,
                audienceName,
                topPriority: topPriorityText,
              });
              if (elevated && elevated.length > 0) content = elevated;
            }
          }
        } catch (err) {
          console.error(`[GuidedDraft] ch${chapterNum} altitude check error (fail-open):`, err);
        }
      }

      content = content.replace(/^\s*\.{2,}\s*/g, '').trim();
      if (chapterNum < 5 && cta) {
        const ctaLower = cta.toLowerCase().trim();
        content = content
          .split('\n')
          .map(line => (line.toLowerCase().trim() === ctaLower ? '' : line))
          .filter(line => line.trim())
          .join('\n')
          .trim();
      }

      // Round 2 fix — extract chapter-level marker descriptions and strip
      // marker-bearing sentences before persist. Same logic as runPipeline.
      {
        const { cleanContent, missingPieces } = extractAndStripMarkers(content);
        content = cleanContent;
        if (chapterNum === 3 || chapterNum === 4 || chapterNum === 5) {
          guidedChapterMissingPieces[chapterNum] = missingPieces;
        }
      }

      await prisma.chapterContent.upsert({
        where: { storyId_chapterNum: { storyId, chapterNum } },
        update: { title: ch.name, content },
        create: { storyId, chapterNum, title: ch.name, content },
      });
    }

    // Phase 2 — Foundational-shift pause check (guided pipeline). Same
    // pattern as runPipeline: if the user edited the foundation mid-run,
    // wait for resolution and regenerate chapters once.
    {
      const pauseResult = await checkFoundationalShiftPause({
        jobId,
        userId: guidedUserId,
        workspaceId: guidedWorkspaceId,
        ctx: {
          storyId,
          draftId: guidedDraftId,
          offeringId: draftForStory.offering?.id,
          audienceId: draftForStory.audience?.id,
        },
        draftId: guidedDraftId,
        pipelineStartMs: guidedPipelineStartMs,
        pauseFlag: guidedShiftPauseFlag,
        initialTier1Text: guidedInitialTier1Text,
        updateStage: async (s: string) => { await update({ stage: s }); },
      });
      if (pauseResult.action === 'timeout') {
        await writeMariaMessage({
          userId: guidedUserId,
          workspaceId: guidedWorkspaceId,
          ctx: {
            storyId,
            draftId: guidedDraftId,
            offeringId: draftForStory.offering?.id,
            audienceId: draftForStory.audience?.id,
          },
          content: buildFoundationalShiftTimeout(timeoutAreaForTargetCell(pauseResult.targetCell)),
          kind: 'pause-timeout',
        });
        throw new Error('Foundation update timed out.');
      }
      if (pauseResult.action === 'regenerate-chapters' && guidedChapterRegenCount < GUIDED_MAX_REGEN_CYCLES) {
        guidedChapterRegenCount++;
        await prisma.chapterContent.deleteMany({ where: { storyId } });
        const refreshed = await prisma.threeTierDraft.findFirst({
          where: { id: guidedDraftId },
          include: {
            tier1Statement: true,
            tier2Statements: {
              orderBy: { sortOrder: 'asc' },
              include: {
                tier3Bullets: { orderBy: { sortOrder: 'asc' } },
                priority: true,
              },
            },
            offering: { include: { elements: true } },
            audience: { include: { priorities: { orderBy: { sortOrder: 'asc' } } } },
          },
        });
        if (!refreshed) {
          throw new Error('Draft vanished during foundation regeneration.');
        }
        draftForStory = refreshed;
        guidedInitialTier1Text = draftForStory.tier1Statement?.text || '';
        continue;
      }
      break;
    }
    } while (true);

    // Round 3 fix — chapters stage complete (guided); cancel before milestone.
    cancelGuidedChaptersCheckin();
    // Round 3.3 Item 1 — also cancel the chapters heartbeat (guided).
    cancelGuidedChaptersHeartbeat();

    // Phase 2 — Milestone 2: Chapters separated. Path B narration only.
    await narrateMilestoneIfPathB({
      userId: guidedUserId,
      workspaceId: guidedWorkspaceId,
      ctx: {
        storyId,
        draftId: guidedDraftId,
        offeringId: draftForStory.offering?.id,
        audienceId: draftForStory.audience?.id,
      },
      milestone: MILESTONE_CHAPTERS_SEPARATED_READY,
    });

    // ── Join (NEW in Phase 2) ──────────────────────
    await update({ status: 'joining', stage: 'Joining the chapters', progress: 84 });
    const guidedStoryWithChaptersForJoin = await prisma.fiveChapterStory.findFirst({
      where: { id: storyId },
      include: { chapters: { orderBy: { chapterNum: 'asc' } } },
    });
    if (!guidedStoryWithChaptersForJoin || guidedStoryWithChaptersForJoin.chapters.length < 5) {
      throw new Error('Not all chapters generated.');
    }
    const guidedJoinSourceText = guidedStoryWithChaptersForJoin.chapters
      .map(ch => ch.content)
      .join('\n\n');
    const guidedJoinMessage = `CONTENT FORMAT: ${mediumSpec.label}\n\n${guidedJoinSourceText}`;
    try {
      let guidedJoinedText = await callAI(JOIN_CHAPTERS_SYSTEM, guidedJoinMessage, 'elite');
      try {
        const joinCheck = await checkProse(guidedJoinedText, `Joined ${mediumSpec.label}`);
        if (!joinCheck.passed && joinCheck.violations.length > 0) {
          const feedback = buildProseViolationFeedback(joinCheck.violations);
          guidedJoinedText = await callAI(JOIN_CHAPTERS_SYSTEM, guidedJoinMessage + feedback, 'elite');
        }
      } catch (err) {
        console.error(`[GuidedDraft] join voice check error (fail-open):`, err);
      }
      await prisma.fiveChapterStory.update({
        where: { id: storyId },
        data: { joinedText: guidedJoinedText, stage: 'joined' },
      });
    } catch (err) {
      console.error(`[GuidedDraft] join failed (fail-open, blend still runs):`, err);
    }

    // Phase 2 — Milestone 3: Chapters combined. Path B narration only.
    await narrateMilestoneIfPathB({
      userId: guidedUserId,
      workspaceId: guidedWorkspaceId,
      ctx: {
        storyId,
        draftId: guidedDraftId,
        offeringId: draftForStory.offering?.id,
        audienceId: draftForStory.audience?.id,
      },
      milestone: MILESTONE_CHAPTERS_COMBINED_READY,
    });

    // ── Blend ──────────────────────────────────────
    await update({ status: 'blending', stage: 'Polishing the draft', progress: 88 });
    const guidedBlendStartMs = Date.now();
    console.log(`[Perf] jobId=${jobId} stage=blend-start elapsed_ms=${guidedBlendStartMs - guidedPipelineStartMs} mode=guided variant=1/1`);

    const cancelGuidedBlendCheckin = scheduleStageCheckin({
      stage: 'blend',
      message: STAGE_CHECKIN_BLEND,
      flags: guidedStageCheckinFlags,
      userId: guidedUserId,
      workspaceId: guidedWorkspaceId,
      ctx: {
        storyId,
        draftId: guidedDraftId,
        offeringId: draftForStory.offering?.id,
        audienceId: draftForStory.audience?.id,
      },
    });
    // Round 3.1 Item 3 — blend-phase heartbeat for the guided pipeline.
    const cancelGuidedBlendHeartbeat = scheduleStageCheckin({
      stage: 'blend-heartbeat',
      message: BLEND_HEARTBEAT,
      flags: guidedStageCheckinFlags,
      userId: guidedUserId,
      workspaceId: guidedWorkspaceId,
      ctx: {
        storyId,
        draftId: guidedDraftId,
        offeringId: draftForStory.offering?.id,
        audienceId: draftForStory.audience?.id,
      },
      delayMs: BLEND_HEARTBEAT_MS,
      kind: 'blend-heartbeat',
    });

    const storyWithChapters = await prisma.fiveChapterStory.findFirst({
      where: { id: storyId },
      include: { chapters: { orderBy: { chapterNum: 'asc' } } },
    });
    if (!storyWithChapters || storyWithChapters.chapters.length < 5) {
      throw new Error('Not all chapters generated.');
    }

    const sourceText = storyWithChapters.chapters.map(ch => ch.content).join('\n\n');
    const blendMessage = `${situation ? `SITUATION:\n${situation}\n\n` : ''}CONTENT FORMAT: ${mediumSpec.label} (${mediumSpec.wordRange[0]}-${mediumSpec.wordRange[1]} words)
FORMAT RULES: ${mediumSpec.format}
TONE: ${mediumSpec.tone}

${sourceText}

Polish this into a final, cohesive ${mediumSpec.label.toLowerCase()}.
CRITICAL — NO FABRICATION. Only use claims from the source chapters above.`;

    let blendedText = await callAI(BLEND_SYSTEM, blendMessage, 'elite');

    // Blend voice check
    try {
      const blendCheck = await checkProse(blendedText, `Blended ${mediumSpec.label}`);
      if (!blendCheck.passed && blendCheck.violations.length > 0) {
        const feedback = buildProseViolationFeedback(blendCheck.violations);
        blendedText = await callAI(BLEND_SYSTEM, blendMessage + feedback, 'elite');
      }
    } catch (err) {
      console.error(`[GuidedDraft] blend voice check error (fail-open):`, err);
    }

    // Strip markdown
    blendedText = blendedText
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/^[-*]\s+/gm, '')
      .replace(/^\d+\.\s+/gm, '')
      .replace(/^---+\s*$/gm, '')
      .replace(/^>\s?/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    await prisma.fiveChapterStory.update({
      where: { id: storyId },
      data: { blendedText, stage: 'blended', version: { increment: 1 } },
    });

    // Round 3 fix — blend stage complete (guided); cancel before milestone.
    cancelGuidedBlendCheckin();
    // Round 3.1 Item 3 — also cancel the heartbeat (guided pipeline).
    cancelGuidedBlendHeartbeat();
    // Round 3.2 Item 2 — perf logging for blend-end (guided pipeline).
    console.log(`[Perf] jobId=${jobId} stage=blend-end elapsed_ms=${Date.now() - guidedPipelineStartMs} blend_ms=${Date.now() - guidedBlendStartMs} mode=guided variant=1/1`);

    // Phase 2 — Milestone 4: Blended ready (guided). Path B narration only.
    await narrateMilestoneIfPathB({
      userId: guidedUserId,
      workspaceId: guidedWorkspaceId,
      ctx: {
        storyId,
        draftId: guidedDraftId,
        offeringId: draftForStory.offering?.id,
        audienceId: draftForStory.audience?.id,
      },
      milestone: MILESTONE_BLENDED_READY,
    });

    // Round 2 fix — Soft notes for chapter content gaps (guided). One soft
    // note per gappy chapter. Whole-empty (per tier rules) → empty case
    // template; partial (chapter has content but markers extracted) →
    // descriptors listed in the template. Same logic as runPipeline.
    {
      const ctaProvided = typeof cta === 'string' && cta.trim().length > 0;
      const wholeEmptyArr = detectMissingChaptersFromTier({
        hasSupportColumn,
        hasSocialProofColumn,
        namedCustomerCount: namedCustomers.size,
        otherNamedSpecificCount: otherNamedSpecificsGuided.length,
        hasMeaningfulCta: ctaProvided,
      });
      const wholeChapterEmpty = new Set<3 | 4 | 5>(wholeEmptyArr);
      await emitChapterSoftNotes({
        userId: guidedUserId,
        workspaceId: guidedWorkspaceId,
        ctx: {
          storyId,
          draftId: guidedDraftId,
          offeringId: draftForStory.offering?.id,
          audienceId: draftForStory.audience?.id,
        },
        wholeChapterEmpty,
        chapterMissingPieces: guidedChapterMissingPieces,
      });
    }

    await update({ status: 'complete', stage: 'First draft ready', progress: 100 });
    console.log(`[GuidedDraft] ${jobId} complete, story ${storyId}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[GuidedDraft] ${jobId} ${message}`);
    await prisma.expressJob.update({
      where: { id: jobId },
      data: { status: 'error', error: message, stage: 'Something went wrong' },
    }).catch(() => {});
  }
}
