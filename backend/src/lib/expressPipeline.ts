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

    // Express mode: accept all mappings >= 0.5 as confirmed (no clarifying questions)
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
    const hasSupportColumn = tier2Labels.some(l =>
      /support|onboard|service|help|success|implement/.test(l),
    );
    const hasSocialProofColumn = tier2Labels.some(l =>
      /social|proof|recognition|customer|testimonial|reference/.test(l),
    );
    const namedCustomers = new Set<string>();
    for (const t2 of draftForStory.tier2Statements) {
      for (const b of t2.tier3Bullets) {
        const m = b.text.match(/\b([A-Z][a-zA-Z&']*(?:\s+(?:[A-Z][a-zA-Z&']*|of|the|and|at|for)){0,4})\s+(?:Bank|Hospital|Clinic|Health|Medical|Regional|Community|Inc|LLC|Ltd|Co|Corporation|University|College|School|Center)\b/);
        if (m) namedCustomers.add(m[0].trim());
      }
    }

    function buildChapterGuardrails(chapterNum: number): string {
      // Ch3 — We'll Hold Your Hand (support/reassurance)
      if (chapterNum === 3) {
        if (!hasSupportColumn) {
          return `
CHAPTER 3 GUARDRAIL — THE SOURCE HAS NO SUPPORT CONTENT.

The Three Tier above does not describe any onboarding, migration, training,
implementation, or customer success program. You may NOT invent one.

Forbidden phrases and claims for this chapter, regardless of how natural they
feel structurally:
- "dedicated contact", "dedicated support", "dedicated account manager",
  "customer success manager", "onboarding lead", "implementation team"
- "48-hour migration", "structured onboarding", "migration in X days",
  "typical onboarding", "we handle the setup", "we walk you through"
- "one person, and you know who they are", "single point of contact"
- Any invented timeline for how long anything takes
- Any invented team role working on behalf of the customer

Instead, write reassurance that comes from the PRODUCT ITSELF, using only
facts from the Three Tier. The product removes risk because of how it is
built, not because a services layer catches mistakes. Good directions:
- "The system assumes your team is small — that is the starting point."
- "You are not learning a new framework. The guidelines you already follow
  map to the workflows you already have."
- "When the next update comes out, the change lands in the workflow you
  already use. There is nothing new to roll out."

A short, honest Chapter 3 is required. Half the word target is fine. Zero
invented services is non-negotiable.`;
        }
      }
      // Ch4 — You're Not Alone (social proof / customer references)
      if (chapterNum === 4) {
        const customerList = [...namedCustomers];
        if (customerList.length === 0 && !hasSocialProofColumn) {
          return `
CHAPTER 4 GUARDRAIL — THE SOURCE HAS NO CUSTOMER REFERENCES.

The Three Tier above names no customers and has no social-proof column. You
may NOT invent any. Forbidden:
- "banks like yours are using the platform"
- "multiple community banks", "several regional institutions", "pilot
  partners", "beta customers", "early adopters"
- Any count ("over twenty banks", "dozens of hospitals")
- Any composite fiction ("a bank roughly your size")

Instead, re-anchor Chapter 4 in what the reader already knows: their OWN
situation. Write about the pressure they are under, the shape of the decision
they are making, the risk of inaction. You are giving them confidence that
they are not being sold into something exotic — you are doing that WITHOUT
naming other customers you don't have. A short chapter is fine.`;
        }
        if (customerList.length > 0) {
          return `
CHAPTER 4 GUARDRAIL — THE SOURCE NAMES ${customerList.length} CUSTOMER${customerList.length === 1 ? '' : 'S'}.

The only customer${customerList.length === 1 ? '' : 's'} you may name in this chapter: ${customerList.join(', ')}.

You may NOT use phrases like "banks like yours are already using it",
"multiple regional banks", "several community banks", "pilot partners",
"beta customers", or any count or plural reference that implies more
customers than are named above. If you want to reinforce credibility beyond
the named customer, do it through the SPECIFIC results in the Three Tier
proof bullets — not through manufactured customer quantities.`;
        }
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
"pick one workflow and run it in our sandbox". If the honest ending is
thin, make the chapter short and direct.`;
      }
      return '';
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

      const userMessage = `${situationBlock}OFFERING: ${draftForStory.offering.name}
AUDIENCE: ${draftForStory.audience.name}
CONTENT FORMAT: ${mediumSpec.label} (${mediumSpec.wordRange[0]}-${mediumSpec.wordRange[1]} words total)
CTA: ${story.cta}

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

CRITICAL — NO FABRICATION. Read this carefully, because it is what will
cause a draft to fail or succeed:

You may only assert claims that are explicitly supported by the THREE TIER
MESSAGE, the AUDIENCE PRIORITIES, or the SITUATION above. If the fact is not
in one of those three places, you may not write it as a claim. Period.

Specifically forbidden unless explicitly supported above:
- Customer references. "Banks like yours are already on the platform." "We
  are working with community banks today." Unless Tier 3 names the customer,
  do not mention them.
- Metrics. No percentages, dollar figures, timelines, reduction claims, case
  study outcomes unless they appear as proof in Tier 3.
- Pricing. No "flat monthly subscription", no "dining is included in dues",
  no "per-seat", no dollar amounts of any kind.
- Professional services. No "dedicated onboarding lead", no "quarterly
  check-ins", no "implementation team", no "typically done in days", no
  "we handle the setup" unless stated.
- Product features. Only features listed in the Three Tier exist. Do not
  infer adjacent features the product "probably has."
- Processes, programs, and events the user did not describe. No "open comment
  period", no "written rationale to every member", no "member forum", no
  "town hall", no "Q&A session", no "feedback session", no "review board",
  no "quarterly review". If the user mentioned "send them directly to the
  board" that IS the process; do not elaborate into a formal program.
- Governance artifacts the user did not describe. No "the board published
  its reasoning in writing", no "formal vote", no "ratification session".
- Audience actions beyond what the user described. If the user said "members
  need to make reservations three days ahead", do NOT tell readers to "mark
  their calendars" or "set a reminder in your phone app" — those are
  invented specifics.

The discipline: after you write each sentence, ask yourself "is this fact
in the Three Tier, the Priorities, or the Situation?" If the answer is no
or uncertain, cut the sentence. A three-paragraph honest draft is better
than a five-paragraph draft with one fabricated line, because the reader
will copy the whole thing and ship the fabrication along with the truth.

Length discipline. If the chapter word budget requires more content than
you can honestly produce from the Three Tier, produce a shorter chapter.
Never inflate the word count by adding invented content to reach a target.

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
        let lastViolations: string[] = [];
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
            lastViolations = [];
            break;
          }
          console.log(
            `[ExpressPipeline] ${jobId} chapter ${chapterNum} fabrication attempt ${attempt + 1}: ${fabCheck.violations.length} unsupported claims, retrying`,
          );
          // Accumulate violations across attempts so the retry sees everything
          // that was flagged, not just the current attempt. This prevents the
          // LLM from fixing one invention and introducing a new one.
          for (const v of fabCheck.violations) cumulativeViolations.push(v);
          lastViolations = fabCheck.violations;
          const feedback = buildFabricationFeedback(cumulativeViolations);
          content = await callAI(systemPrompt, userMessage + feedback, 'elite');
        }
        // Surgical redaction pass. After the 2-retry loop, if fabrication
        // still hasn't cleared, ask Opus to EDIT the last draft — removing
        // exactly the flagged sentences — instead of re-GENERATING from the
        // chapter system prompt (which keeps re-inventing to fill mandated
        // topic slots). The redaction prompt forbids new content, so the
        // output can only shrink or stay the same. After redaction, run
        // one more fabrication check to confirm it worked; if violations
        // STILL remain, log and ship the redacted version anyway (honest
        // shortness beats a regenerated fabrication).
        if (lastViolations.length > 0) {
          const finalCheck = await checkChapterFabrication({
            situation,
            tierText: tierTextForCheck,
            prioritiesText: prioritiesTextForCheck,
            chapterContent: content,
          });
          if (!finalCheck.passed && finalCheck.violations.length > 0) {
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
      let lastBlendViolations: string[] = [];
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
          lastBlendViolations = [];
          break;
        }
        console.log(
          `[ExpressPipeline] ${jobId} blend fabrication attempt ${attempt + 1}: ${blendFabCheck.violations.length} unsupported claims, retrying`,
        );
        for (const v of blendFabCheck.violations) cumulativeBlendViolations.push(v);
        lastBlendViolations = blendFabCheck.violations;
        const feedback = buildFabricationFeedback(cumulativeBlendViolations);
        blendedText = await callAI(BLEND_SYSTEM, blendMessage + feedback, 'elite');
      }
      // Blend-level surgical redaction. Same logic as the per-chapter pass —
      // after 2 regeneration retries, switch to EDIT mode and ask Opus to
      // remove exactly the surviving flagged sentences without adding
      // anything new.
      if (lastBlendViolations.length > 0) {
        const finalCheck = await checkChapterFabrication({
          situation: blendSituation,
          tierText: blendTierTextForCheck,
          prioritiesText: blendPrioritiesForCheck,
          chapterContent: blendedText,
        });
        if (!finalCheck.passed && finalCheck.violations.length > 0) {
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
