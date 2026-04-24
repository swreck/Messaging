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
import { callAI, callAIWithJSON } from '../services/ai.js';
import { MAPPING_SYSTEM } from '../prompts/mapping.js';
import { CONVERT_LINES_SYSTEM } from '../prompts/generation.js';
import {
  buildChapterPrompt,
  BLEND_SYSTEM,
  CHAPTER_CRITERIA,
  CHAPTER_NAMES,
} from '../prompts/fiveChapter.js';
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
        reasoning?: string;
        mfRationale?: string;
      }[];
      orphanElements?: string[];
      priorityGaps?: string[];
      gapDescriptions?: { priorityId: string; missingCapability: string }[];
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

    // The mapping prompt tells the model not to emit below 0.7. If the model
    // complies, below-threshold items surface as gapDescriptions. This floor
    // stays at 0.5 as a safety net for the case where the model emits a weak
    // match anyway — we'd rather show a weak Tier 1 plus Maria's gap
    // interview than strip Rank 1 entirely and build Tier 1 from Rank 2.
    for (const m of cleanMappings.filter(m => m.confidence >= 0.5)) {
      await prisma.mapping.create({
        data: {
          draftId: draftWithElements.id,
          priorityId: m.priorityId,
          elementId: m.elementId,
          confidence: m.confidence,
          status: 'confirmed',
          mfRationale: m.mfRationale || '',
        },
      });
    }

    // ─── Stage 2: Three Tier generation ──────────────
    await update({
      status: 'tier_generation',
      stage: `Shaping the Three Tier message${variantStageSuffix}`,
      progress: scaledProgress(25),
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

    const story = await prisma.fiveChapterStory.create({
      data: {
        draftId: draftWithElements.id,
        medium: mediumKey,
        customName: buildCustomName(),
        cta: `Get started with ${interpretation.offering.name || 'us'}`,
      },
    });

    const draftForStory = await prisma.threeTierDraft.findFirst({
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

    for (let chapterNum = 1; chapterNum <= 5; chapterNum++) {
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

      const userMessage = `${situationBlock}${chapterNum === 1 ? '' : `OFFERING: ${draftForStory.offering.name}\n`}AUDIENCE (THIS IS THE READER): ${draftForStory.audience.name}
CONTENT FORMAT: ${mediumSpec.label} (${mediumSpec.wordRange[0]}-${mediumSpec.wordRange[1]} words total)
${chapterNum === 1 ? '' : `CTA: ${story.cta}\n`}${readerDirective}
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
    }

    // ─── Stage 4: Blend into final draft ─────────────
    await update({
      status: 'blending',
      stage: `Polishing the draft${variantStageSuffix}`,
      progress: scaledProgress(92),
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

    await prisma.fiveChapterStory.update({
      where: { id: story.id },
      data: {
        blendedText,
        stage: 'blended',
        version: { increment: 1 },
      },
    });

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
      mfRationale?: string;
    }[];
    gapDescriptions?: { priorityId: string; missingCapability: string }[];
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

  // The mapping prompt tells the model not to emit below 0.7. This floor
  // stays at 0.5 as a safety net for the case where the model emits a weak
  // match anyway — see the parallel comment in runPipeline for reasoning.
  for (const m of cleanMappings.filter(m => m.confidence >= 0.5)) {
    await prisma.mapping.create({
      data: {
        draftId: draft.id,
        priorityId: m.priorityId,
        elementId: m.elementId,
        confidence: m.confidence,
        status: 'confirmed',
        mfRationale: m.mfRationale || '',
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

      const userMessage = `${situationBlock}${chapterNum === 1 ? '' : `OFFERING: ${draftForStory.offering.name}\n`}AUDIENCE: ${draftForStory.audience.name}
CONTENT FORMAT: ${mediumSpec.label} (${mediumSpec.wordRange[0]}-${mediumSpec.wordRange[1]} words total)
${chapterNum === 1 ? '' : `CTA: ${cta}\n`}${readerDirective}
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

      await prisma.chapterContent.upsert({
        where: { storyId_chapterNum: { storyId, chapterNum } },
        update: { title: ch.name, content },
        create: { storyId, chapterNum, title: ch.name, content },
      });
    }

    // ── Blend ──────────────────────────────────────
    await update({ status: 'blending', stage: 'Polishing the draft', progress: 88 });

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
