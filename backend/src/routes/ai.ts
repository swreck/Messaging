import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { callAI, callAIWithJSON } from '../services/ai.js';
import { ALL_ABOUT_YOU_SYSTEM, ALL_ABOUT_AUDIENCE_SYSTEM, buildCoachingUserContext } from '../prompts/coaching.js';
import { MAPPING_SYSTEM } from '../prompts/mapping.js';
import { CONVERT_LINES_SYSTEM, AUDIT_SYSTEM, POETRY_PASS_SYSTEM, REFINE_LANGUAGE_SYSTEM, MAGIC_HOUR_SYSTEM } from '../prompts/generation.js';
import { buildChapterPrompt, BLEND_SYSTEM, REFINE_CHAPTER_SYSTEM, CHAPTER_CRITERIA } from '../prompts/fiveChapter.js';

const router = Router();
router.use(requireAuth);

// ─── Coaching (Steps 2 & 4) ────────────────────────────

router.post('/coach', async (req: Request, res: Response) => {
  const { draftId, step, message } = req.body;
  if (!draftId || !step || !message) {
    res.status(400).json({ error: 'draftId, step, and message are required' });
    return;
  }

  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: draftId, offering: { userId: req.user!.userId } },
    include: {
      offering: { include: { elements: true } },
      audience: { include: { priorities: { orderBy: { sortOrder: 'asc' } } } },
    },
  });
  if (!draft) {
    res.status(404).json({ error: 'Draft not found' });
    return;
  }

  // Get conversation history
  const history = await prisma.conversationMessage.findMany({
    where: { draftId, step },
    orderBy: { createdAt: 'asc' },
  });

  const systemPrompt = step === 2 ? ALL_ABOUT_YOU_SYSTEM : ALL_ABOUT_AUDIENCE_SYSTEM;
  const context = buildCoachingUserContext(
    draft.offering.name,
    draft.offering.smeRole,
    draft.offering.elements.map((e) => e.text),
    draft.audience.priorities.map((p) => ({ text: p.text, rank: p.rank, motivatingFactor: p.motivatingFactor }))
  );

  const fullMessage = history.length === 0
    ? `${context}\n\nUser's first message: ${message}`
    : message;

  const conversationHistory = history.map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));

  const response = await callAI(systemPrompt, fullMessage, 'fast', conversationHistory);

  // Save both messages
  await prisma.conversationMessage.createMany({
    data: [
      { draftId, step, role: 'user', content: message },
      { draftId, step, role: 'assistant', content: response },
    ],
  });

  res.json({ response });
});

// ─── Suggest Mappings (Step 5) ──────────────────────────

router.post('/suggest-mappings', async (req: Request, res: Response) => {
  const { draftId } = req.body;
  if (!draftId) {
    res.status(400).json({ error: 'draftId is required' });
    return;
  }

  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: draftId, offering: { userId: req.user!.userId } },
    include: {
      offering: { include: { elements: { orderBy: { sortOrder: 'asc' } } } },
      audience: { include: { priorities: { orderBy: { sortOrder: 'asc' } } } },
    },
  });
  if (!draft) {
    res.status(404).json({ error: 'Draft not found' });
    return;
  }

  const userMessage = `PRIORITIES (ranked by importance):
${draft.audience.priorities.map((p) => `- [ID: ${p.id}] [Rank ${p.rank}] "${p.text}" (Motivating factor: ${p.motivatingFactor || 'not specified'})`).join('\n')}

CAPABILITIES/DIFFERENTIATORS:
${draft.offering.elements.map((e) => `- [ID: ${e.id}] "${e.text}"`).join('\n')}`;

  const result = await callAIWithJSON<{
    mappings: { priorityId: string; elementId: string; confidence: number; reasoning: string }[];
    orphanElements: string[];
    priorityGaps: string[];
    clarifyingQuestions: string[];
  }>(MAPPING_SYSTEM, userMessage, 'fast');

  res.json(result);
});

// ─── Convert Lines (Step 6) ─────────────────────────────

router.post('/convert-lines', async (req: Request, res: Response) => {
  const { draftId } = req.body;
  if (!draftId) {
    res.status(400).json({ error: 'draftId is required' });
    return;
  }

  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: draftId, offering: { userId: req.user!.userId } },
    include: {
      mappings: {
        where: { status: 'confirmed' },
        include: {
          priority: true,
          element: true,
        },
      },
      audience: { include: { priorities: { orderBy: { sortOrder: 'asc' } } } },
    },
  });
  if (!draft) {
    res.status(404).json({ error: 'Draft not found' });
    return;
  }

  // Group mappings by priority
  const byPriority = new Map<string, { priority: any; elements: any[] }>();
  for (const m of draft.mappings) {
    if (!byPriority.has(m.priorityId)) {
      byPriority.set(m.priorityId, { priority: m.priority, elements: [] });
    }
    byPriority.get(m.priorityId)!.elements.push(m.element);
  }

  const userMessage = `CONFIRMED MAPPINGS (grouped by priority, in rank order):
${draft.audience.priorities
  .filter((p) => byPriority.has(p.id))
  .map((p) => {
    const group = byPriority.get(p.id)!;
    return `Priority [ID: ${p.id}] [Rank ${p.rank}]: "${p.text}"
  Motivating factor: ${p.motivatingFactor || 'not specified'}
  Mapped capabilities: ${group.elements.map((e) => `"${e.text}"`).join(', ')}`;
  })
  .join('\n\n')}

AUDIENCE: ${draft.audience?.name || 'Not specified'}`;

  const result = await callAIWithJSON<{
    tier1: { text: string; priorityId: string };
    tier2: { text: string; priorityId: string; tier3: string[] }[];
  }>(CONVERT_LINES_SYSTEM, userMessage, 'deep');

  res.json(result);
});

// ─── Audit ──────────────────────────────────────────────

router.post('/audit', async (req: Request, res: Response) => {
  const { draftId } = req.body;
  if (!draftId) { res.status(400).json({ error: 'draftId required' }); return; }

  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: draftId, offering: { userId: req.user!.userId } },
    include: {
      tier1Statement: true,
      tier2Statements: { orderBy: { sortOrder: 'asc' }, include: { tier3Bullets: { orderBy: { sortOrder: 'asc' } } } },
      mappings: { where: { status: 'confirmed' }, include: { priority: true, element: true } },
      audience: { include: { priorities: { orderBy: { sortOrder: 'asc' } } } },
      offering: { include: { elements: true } },
    },
  });
  if (!draft) { res.status(404).json({ error: 'Draft not found' }); return; }

  const userMessage = `THREE TIER TABLE:
Tier 1: "${draft.tier1Statement?.text || '(empty)'}"

Tier 2 statements:
${draft.tier2Statements.map((t2, i) => `${i + 1}. "${t2.text}"\n   Tier 3 bullets: ${t2.tier3Bullets.map((t3) => `"${t3.text}"`).join(', ') || '(none)'}`).join('\n')}

AUDIENCE PRIORITIES:
${draft.audience.priorities.map((p) => `[Rank ${p.rank}] "${p.text}"`).join('\n')}

OFFERING CAPABILITIES:
${draft.offering.elements.map((e) => `"${e.text}"`).join('\n')}`;

  const result = await callAIWithJSON(AUDIT_SYSTEM, userMessage, 'deep');
  res.json(result);
});

// ─── Poetry Pass ────────────────────────────────────────

router.post('/poetry-pass', async (req: Request, res: Response) => {
  const { draftId } = req.body;
  if (!draftId) { res.status(400).json({ error: 'draftId required' }); return; }

  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: draftId, offering: { userId: req.user!.userId } },
    include: {
      tier1Statement: true,
      tier2Statements: { orderBy: { sortOrder: 'asc' }, include: { tier3Bullets: { orderBy: { sortOrder: 'asc' } } } },
    },
  });
  if (!draft) { res.status(404).json({ error: 'Draft not found' }); return; }

  const userMessage = `THREE TIER TABLE:
{
  "tier1": { "text": "${draft.tier1Statement?.text || ''}" },
  "tier2": [${draft.tier2Statements.map((t2) => `
    { "text": "${t2.text}", "tier3": [${t2.tier3Bullets.map((t3) => `"${t3.text}"`).join(', ')}] }`).join(',')}
  ]
}`;

  const result = await callAIWithJSON(POETRY_PASS_SYSTEM, userMessage, 'fast');
  res.json(result);
});

// ─── Refine Language ────────────────────────────────────

router.post('/refine-language', async (req: Request, res: Response) => {
  const { draftId } = req.body;
  if (!draftId) { res.status(400).json({ error: 'draftId required' }); return; }

  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: draftId, offering: { userId: req.user!.userId } },
    include: {
      tier2Statements: { orderBy: { sortOrder: 'asc' } },
    },
  });
  if (!draft) { res.status(404).json({ error: 'Draft not found' }); return; }

  const userMessage = `TIER 2 STATEMENTS (to be refined as a set):
${draft.tier2Statements.map((t2) => `{ "text": "${t2.text}", "priorityId": "${t2.priorityId || ''}" }`).join('\n')}`;

  const result = await callAIWithJSON(REFINE_LANGUAGE_SYSTEM, userMessage, 'fast');
  res.json(result);
});

// ─── Magic Hour ─────────────────────────────────────────

router.post('/magic-hour', async (req: Request, res: Response) => {
  const { draftId } = req.body;
  if (!draftId) { res.status(400).json({ error: 'draftId required' }); return; }

  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: draftId, offering: { userId: req.user!.userId } },
    include: {
      tier1Statement: true,
      tier2Statements: { orderBy: { sortOrder: 'asc' }, include: { tier3Bullets: { orderBy: { sortOrder: 'asc' } } } },
      mappings: { where: { status: 'confirmed' }, include: { priority: true, element: true } },
      audience: { include: { priorities: { orderBy: { sortOrder: 'asc' } } } },
    },
  });
  if (!draft) { res.status(404).json({ error: 'Draft not found' }); return; }

  const userMessage = `THREE TIER TABLE:
Tier 1: "${draft.tier1Statement?.text || ''}"
${draft.tier2Statements.map((t2, i) => `Tier 2 #${i + 1}: "${t2.text}" | Tier 3: ${t2.tier3Bullets.map((t3) => `"${t3.text}"`).join(', ')}`).join('\n')}

PRIORITIES: ${draft.audience.priorities.map((p) => `[Rank ${p.rank}] "${p.text}"`).join(', ')}`;

  const result = await callAIWithJSON(MAGIC_HOUR_SYSTEM, userMessage, 'deep');
  res.json(result);
});

// ─── Five Chapter Story ─────────────────────────────────

router.post('/generate-chapter', async (req: Request, res: Response) => {
  const { storyId, chapterNum } = req.body;
  if (!storyId || !chapterNum) {
    res.status(400).json({ error: 'storyId and chapterNum are required' });
    return;
  }

  const story = await prisma.fiveChapterStory.findFirst({
    where: { id: storyId, draft: { offering: { userId: req.user!.userId } } },
    include: {
      draft: {
        include: {
          tier1Statement: true,
          tier2Statements: { orderBy: { sortOrder: 'asc' }, include: { tier3Bullets: { orderBy: { sortOrder: 'asc' } }, priority: true } },
          offering: { include: { elements: true } },
          audience: { include: { priorities: { orderBy: { sortOrder: 'asc' } } } },
        },
      },
      chapters: true,
    },
  });
  if (!story) {
    res.status(404).json({ error: 'Story not found' });
    return;
  }

  // Check motivating factors
  const missingMF = story.draft.audience.priorities.filter((p) => !p.motivatingFactor);
  if (missingMF.length > 0) {
    res.status(400).json({
      error: 'Motivating factors are required for all priorities before generating a Five Chapter Story',
      missingPriorities: missingMF.map((p) => ({ id: p.id, text: p.text })),
    });
    return;
  }

  const systemPrompt = buildChapterPrompt(chapterNum);
  const ch = CHAPTER_CRITERIA[chapterNum - 1];

  const userMessage = `OFFERING: ${story.draft.offering.name}
AUDIENCE: ${story.draft.audience.name}
MEDIUM: ${story.medium} (${story.medium === '15s' ? '~40 words' : story.medium === '1m' ? '~150 words' : '~750 words'})
CTA: ${story.cta}
${story.emphasis ? `EMPHASIS: ${story.emphasis}` : ''}

THREE TIER MESSAGE:
Tier 1: "${story.draft.tier1Statement?.text || ''}"
${story.draft.tier2Statements.map((t2, i) => `Tier 2 #${i + 1}: "${t2.text}" (Priority: "${t2.priority?.text || 'unlinked'}", Motivating factor: "${t2.priority?.motivatingFactor || ''}")
  Proof: ${t2.tier3Bullets.map((t3) => t3.text).join(', ')}`).join('\n')}

AUDIENCE PRIORITIES:
${story.draft.audience.priorities.map((p) => `[Rank ${p.rank}] "${p.text}" — Why important: "${p.motivatingFactor}" — Audience thinks: "${p.whatAudienceThinks}"`).join('\n')}

${story.chapters.filter((c) => c.chapterNum < chapterNum).map((c) => `CHAPTER ${c.chapterNum} (already written): ${c.content.substring(0, 200)}...`).join('\n')}

Write Chapter ${chapterNum}: "${ch.name}"`;

  const content = await callAI(systemPrompt, userMessage, 'deep');

  // Save the chapter
  const chapter = await prisma.chapterContent.upsert({
    where: { storyId_chapterNum: { storyId, chapterNum } },
    update: { title: ch.name, content },
    create: { storyId, chapterNum, title: ch.name, content },
  });

  res.json({ chapter });
});

// ─── Refine Chapter ─────────────────────────────────────

router.post('/refine-chapter', async (req: Request, res: Response) => {
  const { storyId, chapterNum, feedback } = req.body;
  if (!storyId || !chapterNum || !feedback) {
    res.status(400).json({ error: 'storyId, chapterNum, and feedback are required' });
    return;
  }

  const story = await prisma.fiveChapterStory.findFirst({
    where: { id: storyId, draft: { offering: { userId: req.user!.userId } } },
    include: { chapters: true },
  });
  if (!story) { res.status(404).json({ error: 'Story not found' }); return; }

  const chapter = story.chapters.find((c) => c.chapterNum === chapterNum);
  if (!chapter) { res.status(404).json({ error: 'Chapter not found' }); return; }

  const ch = CHAPTER_CRITERIA[chapterNum - 1];
  const userMessage = `CHAPTER ${chapterNum}: "${ch.name}"
CURRENT CONTENT:
${chapter.content}

USER FEEDBACK: ${feedback}

Please revise this chapter based on the feedback.`;

  const content = await callAI(REFINE_CHAPTER_SYSTEM, userMessage, 'fast');

  const updated = await prisma.chapterContent.update({
    where: { id: chapter.id },
    data: { content },
  });

  res.json({ chapter: updated });
});

// ─── Blend Story ────────────────────────────────────────

router.post('/blend-story', async (req: Request, res: Response) => {
  const { storyId } = req.body;
  if (!storyId) { res.status(400).json({ error: 'storyId required' }); return; }

  const story = await prisma.fiveChapterStory.findFirst({
    where: { id: storyId, draft: { offering: { userId: req.user!.userId } } },
    include: { chapters: { orderBy: { chapterNum: 'asc' } } },
  });
  if (!story) { res.status(404).json({ error: 'Story not found' }); return; }

  if (story.chapters.length < 5) {
    res.status(400).json({ error: 'All 5 chapters must be generated before blending' });
    return;
  }

  const userMessage = `MEDIUM: ${story.medium} (${story.medium === '15s' ? '~40 words' : story.medium === '1m' ? '~150 words' : '~750 words'})

${story.chapters.map((ch) => `CHAPTER ${ch.chapterNum}: "${ch.title}"\n${ch.content}`).join('\n\n---\n\n')}

Blend these into one cohesive narrative.`;

  const blendedText = await callAI(BLEND_SYSTEM, userMessage, 'deep');

  const updated = await prisma.fiveChapterStory.update({
    where: { id: storyId },
    data: { blendedText, version: { increment: 1 } },
    include: { chapters: { orderBy: { chapterNum: 'asc' } } },
  });

  res.json({ story: updated });
});

export default router;
