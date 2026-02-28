import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { callAI, callAIWithJSON } from '../services/ai.js';
import { ALL_ABOUT_YOU_SYSTEM, ALL_ABOUT_AUDIENCE_SYSTEM, buildCoachingUserContext } from '../prompts/coaching.js';
import { MAPPING_SYSTEM, LOW_CONFIDENCE_QUESTIONS_SYSTEM } from '../prompts/mapping.js';
import { CONVERT_LINES_SYSTEM, REVIEW_SYSTEM, REVISE_FROM_EDITS_SYSTEM, DIRECTION_SYSTEM } from '../prompts/generation.js';
import { buildChapterPrompt, BLEND_SYSTEM, JOIN_CHAPTERS_SYSTEM, REFINE_CHAPTER_SYSTEM, COPY_EDIT_SYSTEM, CHAPTER_CRITERIA } from '../prompts/fiveChapter.js';
import { getMediumSpec } from '../prompts/mediums.js';
import { AUDIENCE_DISCOVERY_SYSTEM } from '../prompts/audienceDiscovery.js';

const router = Router();
router.use(requireAuth);

// ─── Conversation History ────────────────────────────────

router.get('/conversation/:draftId/:step', async (req: Request, res: Response) => {
  const draftId = req.params.draftId as string;
  const step = parseInt(req.params.step as string);
  const messages = await prisma.conversationMessage.findMany({
    where: { draftId, step },
    orderBy: { createdAt: 'asc' },
    select: { role: true, content: true },
  });
  res.json({ messages });
});

// ─── Interview (Steps 2 & 3) ────────────────────────────

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

  // Step 2 = offering interview, Step 3 (was 4) = audience interview
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

// ─── Build Message (orchestrates mapping + convert) ─────

router.post('/build-message', async (req: Request, res: Response) => {
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

  // Step 1: Suggest mappings
  const mappingMessage = `PRIORITIES (ranked by importance):
${draft.audience.priorities.map((p) => `- [ID: ${p.id}] [Rank ${p.rank}] "${p.text}" (Motivating factor: ${p.motivatingFactor || 'not specified'})`).join('\n')}

CAPABILITIES/DIFFERENTIATORS:
${draft.offering.elements.map((e) => `- [ID: ${e.id}] "${e.text}"`).join('\n')}`;

  const mappingResult = await callAIWithJSON<{
    mappings: { priorityId: string; elementId: string; confidence: number; reasoning: string }[];
    orphanElements: string[];
    priorityGaps: string[];
    clarifyingQuestions: string[];
  }>(MAPPING_SYSTEM, mappingMessage, 'fast');

  // Step 2: Auto-confirm high-confidence, collect low-confidence
  const highConfidence = mappingResult.mappings.filter(m => m.confidence >= 0.75);
  const lowConfidence = mappingResult.mappings.filter(m => m.confidence < 0.75 && m.confidence >= 0.5);

  // Save all mappings
  await prisma.mapping.deleteMany({ where: { draftId, status: 'suggested' } });
  for (const m of highConfidence) {
    await prisma.mapping.create({
      data: { draftId, priorityId: m.priorityId, elementId: m.elementId, confidence: m.confidence, status: 'confirmed' },
    });
  }
  for (const m of lowConfidence) {
    await prisma.mapping.create({
      data: { draftId, priorityId: m.priorityId, elementId: m.elementId, confidence: m.confidence, status: 'suggested' },
    });
  }

  // Step 3: If low-confidence items exist, generate natural-language questions
  let questions: { question: string; priorityId: string; elementId: string }[] = [];
  if (lowConfidence.length > 0 || mappingResult.priorityGaps.length > 0) {
    const questionContext = `UNCERTAIN MAPPINGS:
${lowConfidence.map(m => {
  const priority = draft.audience.priorities.find(p => p.id === m.priorityId);
  const element = draft.offering.elements.find(e => e.id === m.elementId);
  return `- Priority "${priority?.text}" <-> Capability "${element?.text}" (confidence: ${m.confidence})`;
}).join('\n')}

PRIORITY GAPS (no matching capability):
${mappingResult.priorityGaps.map(id => {
  const priority = draft.audience.priorities.find(p => p.id === id);
  return `- "${priority?.text}"`;
}).join('\n')}`;

    const qResult = await callAIWithJSON<{
      questions: { question: string; priorityId: string; elementId: string }[];
    }>(LOW_CONFIDENCE_QUESTIONS_SYSTEM, questionContext, 'fast');
    questions = qResult.questions || [];
  }

  // If no questions needed, auto-generate the three tier
  if (questions.length === 0) {
    // All confirmed — proceed to convert lines
    const confirmedMappings = await prisma.mapping.findMany({
      where: { draftId, status: 'confirmed' },
      include: { priority: true, element: true },
    });

    const byPriority = new Map<string, { priority: any; elements: any[] }>();
    for (const m of confirmedMappings) {
      if (!byPriority.has(m.priorityId)) {
        byPriority.set(m.priorityId, { priority: m.priority, elements: [] });
      }
      byPriority.get(m.priorityId)!.elements.push(m.element);
    }

    const convertMessage = `CONFIRMED MAPPINGS (grouped by priority, in rank order):
${draft.audience.priorities
  .filter((p) => byPriority.has(p.id))
  .map((p) => {
    const group = byPriority.get(p.id)!;
    return `Priority [ID: ${p.id}] [Rank ${p.rank}]: "${p.text}"
  Motivating factor: ${p.motivatingFactor || 'not specified'}
  Mapped capabilities: ${group.elements.map((e: any) => `"${e.text}"`).join(', ')}`;
  })
  .join('\n\n')}

AUDIENCE: ${draft.audience?.name || 'Not specified'}`;

    const tierResult = await callAIWithJSON<{
      tier1: { text: string; priorityId: string };
      tier2: { text: string; priorityId: string; categoryLabel: string; tier3: string[] }[];
    }>(CONVERT_LINES_SYSTEM, convertMessage, 'elite');

    res.json({ status: 'complete', result: tierResult, questions: [] });
    return;
  }

  res.json({ status: 'questions', questions, result: null });
});

// ─── Resolve Questions (follow-up to build-message) ─────

router.post('/resolve-questions', async (req: Request, res: Response) => {
  const { draftId, answers } = req.body;
  if (!draftId || !answers) {
    res.status(400).json({ error: 'draftId and answers are required' });
    return;
  }

  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: draftId, offering: { userId: req.user!.userId } },
    include: {
      audience: { include: { priorities: { orderBy: { sortOrder: 'asc' } } } },
    },
  });
  if (!draft) {
    res.status(404).json({ error: 'Draft not found' });
    return;
  }

  // Process answers: confirm or reject suggested mappings
  for (const answer of answers as { priorityId: string; elementId: string; confirmed: boolean }[]) {
    if (answer.elementId) {
      await prisma.mapping.updateMany({
        where: { draftId, priorityId: answer.priorityId, elementId: answer.elementId, status: 'suggested' },
        data: { status: answer.confirmed ? 'confirmed' : 'rejected' },
      });
    }
  }

  // Now convert all confirmed mappings to tier statements
  const confirmedMappings = await prisma.mapping.findMany({
    where: { draftId, status: 'confirmed' },
    include: { priority: true, element: true },
  });

  const byPriority = new Map<string, { priority: any; elements: any[] }>();
  for (const m of confirmedMappings) {
    if (!byPriority.has(m.priorityId)) {
      byPriority.set(m.priorityId, { priority: m.priority, elements: [] });
    }
    byPriority.get(m.priorityId)!.elements.push(m.element);
  }

  const convertMessage = `CONFIRMED MAPPINGS (grouped by priority, in rank order):
${draft.audience.priorities
  .filter((p) => byPriority.has(p.id))
  .map((p) => {
    const group = byPriority.get(p.id)!;
    return `Priority [ID: ${p.id}] [Rank ${p.rank}]: "${p.text}"
  Motivating factor: ${p.motivatingFactor || 'not specified'}
  Mapped capabilities: ${group.elements.map((e: any) => `"${e.text}"`).join(', ')}`;
  })
  .join('\n\n')}

AUDIENCE: ${draft.audience?.name || 'Not specified'}`;

  const tierResult = await callAIWithJSON<{
    tier1: { text: string; priorityId: string };
    tier2: { text: string; priorityId: string; categoryLabel: string; tier3: string[] }[];
  }>(CONVERT_LINES_SYSTEM, convertMessage, 'elite');

  res.json({ status: 'complete', result: tierResult });
});

// ─── Convert Lines (Step 6 — kept for backward compatibility) ─

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
    tier2: { text: string; priorityId: string; categoryLabel: string; tier3: string[] }[];
  }>(CONVERT_LINES_SYSTEM, userMessage, 'elite');

  res.json(result);
});

// ─── Review (inline suggestions) ────────────────────────

router.post('/review', async (req: Request, res: Response) => {
  const { draftId } = req.body;
  if (!draftId) { res.status(400).json({ error: 'draftId required' }); return; }

  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: draftId, offering: { userId: req.user!.userId } },
    include: {
      tier1Statement: true,
      tier2Statements: { orderBy: { sortOrder: 'asc' }, include: { tier3Bullets: { orderBy: { sortOrder: 'asc' } } } },
      audience: { include: { priorities: { orderBy: { sortOrder: 'asc' } } } },
    },
  });
  if (!draft) { res.status(404).json({ error: 'Draft not found' }); return; }

  const userMessage = `THREE TIER TABLE:
Tier 1 [cell: tier1]: "${draft.tier1Statement?.text || '(empty)'}"

Tier 2 statements:
${draft.tier2Statements.map((t2, i) => `[cell: tier2-${i}] "${t2.text}"
  Tier 3 bullets: ${t2.tier3Bullets.map((t3, j) => `[cell: tier3-${i}-${j}] "${t3.text}"`).join(', ') || '(none)'}`).join('\n')}

AUDIENCE PRIORITIES:
${draft.audience.priorities.map((p) => `[Rank ${p.rank}] "${p.text}"`).join('\n')}`;

  const result = await callAIWithJSON<{ suggestions: { cell: string; suggested: string }[] }>(REVIEW_SYSTEM, userMessage, 'elite');
  res.json(result);
});

// ─── Revise from user edits ─────────────────────────────

router.post('/revise', async (req: Request, res: Response) => {
  const { draftId, previousState } = req.body;
  if (!draftId || !previousState) { res.status(400).json({ error: 'draftId and previousState are required' }); return; }

  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: draftId, offering: { userId: req.user!.userId } },
    include: {
      tier1Statement: true,
      tier2Statements: { orderBy: { sortOrder: 'asc' }, include: { tier3Bullets: { orderBy: { sortOrder: 'asc' } } } },
    },
  });
  if (!draft) { res.status(404).json({ error: 'Draft not found' }); return; }

  const userMessage = `PREVIOUS TABLE STATE:
Tier 1: "${previousState.tier1 || '(empty)'}"
${(previousState.tier2 || []).map((t2: any, i: number) => `Tier 2 #${i}: "${t2.text}"
  Tier 3: ${(t2.tier3 || []).map((t3: string, j: number) => `[${j}] "${t3}"`).join(', ') || '(none)'}`).join('\n')}

CURRENT TABLE STATE:
Tier 1 [cell: tier1]: "${draft.tier1Statement?.text || '(empty)'}"
${draft.tier2Statements.map((t2, i) => `[cell: tier2-${i}] "${t2.text}"
  Tier 3: ${t2.tier3Bullets.map((t3, j) => `[cell: tier3-${i}-${j}] "${t3.text}"`).join(', ') || '(none)'}`).join('\n')}`;

  const result = await callAIWithJSON<{ suggestions: { cell: string; suggested: string }[] }>(REVISE_FROM_EDITS_SYSTEM, userMessage, 'elite');
  res.json(result);
});

// ─── Direction (big-picture user feedback) ───────────────

router.post('/direction', async (req: Request, res: Response) => {
  const { draftId, direction } = req.body;
  if (!draftId || !direction) { res.status(400).json({ error: 'draftId and direction are required' }); return; }

  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: draftId, offering: { userId: req.user!.userId } },
    include: {
      tier1Statement: true,
      tier2Statements: { orderBy: { sortOrder: 'asc' }, include: { tier3Bullets: { orderBy: { sortOrder: 'asc' } } } },
      audience: { include: { priorities: { orderBy: { sortOrder: 'asc' } } } },
      offering: { include: { elements: true } },
    },
  });
  if (!draft) { res.status(404).json({ error: 'Draft not found' }); return; }

  const userMessage = `USER'S DIRECTION: ${direction}

CURRENT THREE TIER TABLE:
Tier 1: "${draft.tier1Statement?.text || '(empty)'}"

Tier 2 statements:
${draft.tier2Statements.map((t2, i) => `${i + 1}. [${t2.categoryLabel || 'unlabeled'}] "${t2.text}"
   Tier 3 bullets: ${t2.tier3Bullets.map((t3) => `"${t3.text}"`).join(', ') || '(none)'}`).join('\n')}

AUDIENCE PRIORITIES:
${draft.audience.priorities.map((p) => `[Rank ${p.rank}] "${p.text}"`).join('\n')}

OFFERING CAPABILITIES:
${draft.offering.elements.map((e) => `"${e.text}"`).join('\n')}`;

  const result = await callAIWithJSON<{ suggestions: { cell: string; suggested: string }[] }>(DIRECTION_SYSTEM, userMessage, 'elite');
  res.json(result);
});

// ─── Derive Motivating Factor ───────────────────────────

router.post('/derive-motivation', async (req: Request, res: Response) => {
  const { priorityId, audienceId, offeringId } = req.body;
  if (!priorityId || !audienceId) {
    res.status(400).json({ error: 'priorityId and audienceId are required' });
    return;
  }

  const priority = await prisma.priority.findFirst({
    where: { id: priorityId, audience: { id: audienceId, userId: req.user!.userId } },
    include: { audience: true },
  });
  if (!priority) {
    res.status(404).json({ error: 'Priority not found' });
    return;
  }

  // Optionally include offering context
  let offeringContext = '';
  if (offeringId) {
    const offering = await prisma.offering.findFirst({
      where: { id: offeringId, userId: req.user!.userId },
      include: { elements: true },
    });
    if (offering) {
      offeringContext = `\nOFFERING: ${offering.name}\nCAPABILITIES: ${offering.elements.map(e => e.text).join(', ')}`;
    }
  }

  const systemPrompt = `You are a messaging strategist. Given an audience and their top priority, derive WHY this priority matters so deeply to them. Go beyond the surface — understand the domain, the stakes, the human impact. Write one clear, specific sentence that captures the real motivation.

Do NOT write "Because you want X" or narrate. Write from the perspective of understanding the business reality.

GOOD: "Reliable pathology results in minutes means clinicians can begin targeted treatment during the same visit, dramatically improving outcomes."
BAD: "Because you want faster results."
BAD: "Getting results quickly is important to clinical leads."

Return ONLY the motivating factor sentence, nothing else.`;

  const userMessage = `AUDIENCE: ${priority.audience.name}
TOP PRIORITY: "${priority.text}"${offeringContext}

Derive the motivating factor for this priority.`;

  const motivation = await callAI(systemPrompt, userMessage, 'fast');

  // Save it to the priority
  await prisma.priority.update({
    where: { id: priorityId },
    data: { motivatingFactor: motivation.trim() },
  });

  res.json({ motivatingFactor: motivation.trim() });
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

  // Check motivating factor for top priority (#1) only
  const topPriority = story.draft.audience.priorities[0];
  if (topPriority && !topPriority.motivatingFactor) {
    res.status(400).json({
      error: 'A motivating factor is required for the top priority before generating a Five Chapter Story',
      missingTopPriority: { id: topPriority.id, text: topPriority.text },
    });
    return;
  }

  // Parse emphasis chapter number if provided (e.g. "ch3" or just a string)
  const emphasisMatch = story.emphasis?.match(/^ch(\d)$/i);
  const emphasisChapter = emphasisMatch ? parseInt(emphasisMatch[1]) : undefined;
  const systemPrompt = buildChapterPrompt(chapterNum, story.medium, emphasisChapter);
  const ch = CHAPTER_CRITERIA[chapterNum - 1];
  const spec = getMediumSpec(story.medium);

  const userMessage = `OFFERING: ${story.draft.offering.name}
AUDIENCE: ${story.draft.audience.name}
CONTENT FORMAT: ${spec.label} (${spec.wordRange[0]}-${spec.wordRange[1]} words total)
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

  const content = await callAI(systemPrompt, userMessage, 'elite');

  // Save the chapter
  const chapter = await prisma.chapterContent.upsert({
    where: { storyId_chapterNum: { storyId, chapterNum } },
    update: { title: ch.name, content },
    create: { storyId, chapterNum, title: ch.name, content },
  });

  // Create chapter version
  const maxVer = await prisma.chapterVersion.aggregate({
    where: { chapterContentId: chapter.id },
    _max: { versionNum: true },
  });
  await prisma.chapterVersion.create({
    data: {
      chapterContentId: chapter.id,
      title: ch.name,
      content,
      versionNum: (maxVer._max?.versionNum ?? 0) + 1,
      changeSource: 'ai_generate',
    },
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

  // Create chapter version
  const maxVer = await prisma.chapterVersion.aggregate({
    where: { chapterContentId: chapter.id },
    _max: { versionNum: true },
  });
  await prisma.chapterVersion.create({
    data: {
      chapterContentId: chapter.id,
      title: chapter.title,
      content,
      versionNum: (maxVer._max?.versionNum ?? 0) + 1,
      changeSource: 'ai_refine',
    },
  });

  res.json({ chapter: updated });
});

// ─── Join Chapters ─────────────────────────────────────

router.post('/join-chapters', async (req: Request, res: Response) => {
  const { storyId } = req.body;
  if (!storyId) { res.status(400).json({ error: 'storyId required' }); return; }

  const story = await prisma.fiveChapterStory.findFirst({
    where: { id: storyId, draft: { offering: { userId: req.user!.userId } } },
    include: { chapters: { orderBy: { chapterNum: 'asc' } } },
  });
  if (!story) { res.status(404).json({ error: 'Story not found' }); return; }

  if (story.chapters.length < 5) {
    res.status(400).json({ error: 'All 5 chapters must be generated before joining' });
    return;
  }

  const spec = getMediumSpec(story.medium);
  const userMessage = `CONTENT FORMAT: ${spec.label} (${spec.wordRange[0]}-${spec.wordRange[1]} words)
FORMAT RULES: ${spec.format}

${story.chapters.map((ch) => `CHAPTER ${ch.chapterNum}: "${ch.title}"\n${ch.content}`).join('\n\n---\n\n')}

Join these chapters into one flowing text.`;

  const joinedText = await callAI(JOIN_CHAPTERS_SYSTEM, userMessage, 'elite');

  const updated = await prisma.fiveChapterStory.update({
    where: { id: storyId },
    data: { joinedText, stage: 'joined', version: { increment: 1 } },
    include: { chapters: { orderBy: { chapterNum: 'asc' } } },
  });

  res.json({ story: updated });
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

  // Snapshot before blend
  const maxSnapVer = await prisma.storyVersion.aggregate({
    where: { storyId },
    _max: { versionNum: true },
  });
  await prisma.storyVersion.create({
    data: {
      storyId,
      snapshot: {
        medium: story.medium, cta: story.cta, emphasis: story.emphasis,
        stage: story.stage, joinedText: story.joinedText, blendedText: story.blendedText,
        chapters: story.chapters.map(c => ({ chapterNum: c.chapterNum, title: c.title, content: c.content })),
      },
      label: 'Before blend',
      versionNum: (maxSnapVer._max?.versionNum ?? 0) + 1,
    },
  });

  // Blend can work from joined text or directly from chapters
  const sourceText = story.joinedText || story.chapters.map((ch) => `${ch.title}\n${ch.content}`).join('\n\n');
  if (!sourceText) {
    res.status(400).json({ error: 'No content to blend. Generate chapters first.' });
    return;
  }

  const spec = getMediumSpec(story.medium);
  const userMessage = `CONTENT FORMAT: ${spec.label} (${spec.wordRange[0]}-${spec.wordRange[1]} words)
FORMAT RULES: ${spec.format}
TONE: ${spec.tone}

${sourceText}

Polish this into a final, cohesive ${spec.label.toLowerCase()}.`;

  const blendedText = await callAI(BLEND_SYSTEM, userMessage, 'elite');

  const updated = await prisma.fiveChapterStory.update({
    where: { id: storyId },
    data: { blendedText, stage: 'blended', version: { increment: 1 } },
    include: { chapters: { orderBy: { chapterNum: 'asc' } } },
  });

  res.json({ story: updated });
});

// ─── Copy Edit ─────────────────────────────────────────

router.post('/copy-edit', async (req: Request, res: Response) => {
  const { storyId, content, request: editRequest } = req.body;
  if (!storyId || !content || !editRequest) {
    res.status(400).json({ error: 'storyId, content, and request are required' });
    return;
  }

  const story = await prisma.fiveChapterStory.findFirst({
    where: { id: storyId, draft: { offering: { userId: req.user!.userId } } },
  });
  if (!story) { res.status(404).json({ error: 'Story not found' }); return; }

  const spec = getMediumSpec(story.medium);
  const userMessage = `CONTENT FORMAT: ${spec.label}
USER'S REQUEST: ${editRequest}

CURRENT CONTENT:
${content}

Apply the requested changes.`;

  const revised = await callAI(COPY_EDIT_SYSTEM, userMessage, 'fast');
  res.json({ content: revised });
});

// ─── Audience Discovery ────────────────────────────────

router.post('/discover-audiences', async (req: Request, res: Response) => {
  const { description } = req.body;
  if (!description) {
    res.status(400).json({ error: 'description is required' });
    return;
  }

  const result = await callAIWithJSON<{
    audiences: { name: string; description: string }[];
    notes: string;
  }>(AUDIENCE_DISCOVERY_SYSTEM, description, 'fast');

  res.json(result);
});

export default router;
