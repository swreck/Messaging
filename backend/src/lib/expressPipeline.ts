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
}

export async function commitInterpretation(
  interpretation: ExpressInterpretation,
  userId: string,
  workspaceId: string,
): Promise<CommitResult> {
  const primaryAudience = interpretation.audiences[0];
  if (!primaryAudience) {
    throw new Error('Express interpretation needs at least one audience.');
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

  // Offering + elements
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

  // Audience + priorities (rank 1 is the top priority)
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
    include: { priorities: true },
  });

  // Three Tier draft — land at Step 5 since the silent pipeline will fill the whole table
  const draft = await prisma.threeTierDraft.create({
    data: {
      offeringId: offering.id,
      audienceId: audience.id,
      currentStep: 5,
    },
  });

  // Job record
  const job = await prisma.expressJob.create({
    data: {
      userId,
      workspaceId,
      draftId: draft.id,
      status: 'pending',
      stage: 'Setting things up',
      progress: 3,
      interpretation: interpretation as unknown as object,
    },
  });

  return {
    jobId: job.id,
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

    // ─── Stage 1: Mapping ─────────────────────────────
    await update({
      status: 'mapping',
      stage: 'Reading between the lines',
      progress: 10,
    });

    const draftWithElements = await prisma.threeTierDraft.findFirst({
      where: { id: job.draftId },
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
      stage: 'Building your message',
      progress: 25,
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

    await update({ progress: 45 });

    // ─── Stage 3: Five Chapter Story ─────────────────
    const mediumKey = pickInternalMedium(interpretation.primaryMedium.value);
    const mediumSpec = getMediumSpec(mediumKey);

    const story = await prisma.fiveChapterStory.create({
      data: {
        draftId: draftWithElements.id,
        medium: mediumKey,
        customName: mediumSpec.label,
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

    for (let chapterNum = 1; chapterNum <= 5; chapterNum++) {
      await update({
        status: `chapter_${chapterNum}`,
        stage: `Drafting chapter ${chapterNum} of 5`,
        progress: 45 + chapterNum * 8,
      });

      const systemPrompt = buildChapterPrompt(chapterNum, mediumKey);
      const ch = CHAPTER_CRITERIA[chapterNum - 1];
      const prevChapters = await prisma.chapterContent.findMany({
        where: { storyId: story.id, chapterNum: { lt: chapterNum } },
        orderBy: { chapterNum: 'asc' },
      });

      const userMessage = `OFFERING: ${draftForStory.offering.name}
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
IMPORTANT: Start this chapter fresh. Do NOT begin with "..." or any continuation from a previous chapter. Each chapter is self-contained.`;

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
      stage: 'Polishing the draft',
      progress: 92,
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

    const blendMessage = `CONTENT FORMAT: ${mediumSpec.label} (${mediumSpec.wordRange[0]}-${mediumSpec.wordRange[1]} words)
FORMAT RULES: ${mediumSpec.format}
TONE: ${mediumSpec.tone}

${sourceText}

Polish this into a final, cohesive ${mediumSpec.label.toLowerCase()}.`;

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

    // ─── Done ────────────────────────────────────────
    await update({
      status: 'complete',
      stage: 'First draft ready',
      progress: 100,
      resultStoryId: story.id,
    });

    console.log(`[ExpressPipeline] ${jobId} complete (story ${story.id})`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await fail(message);
  }
}
