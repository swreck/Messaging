import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace } from '../middleware/workspace.js';
import { prisma } from '../lib/prisma.js';
import {
  getPersonalize,
  updatePersonalize,
  resetPersonalize,
} from '../lib/personalize.js';
import {
  synthesizeInterviewProfile,
  analyzeDocument,
  mergeStyleSignals,
  personalizeChapter,
  generateComparativeQuestion,
} from '../services/personalizeService.js';
import { INTERVIEW_QUESTIONS } from '../prompts/personalize.js';

const router = Router();
router.use(requireAuth);
router.use(requireWorkspace);

// ─── Profile CRUD ───────────────────────────────────────────

// GET /api/personalize/profile
router.get('/profile', async (req: Request, res: Response) => {
  const profile = await getPersonalize(req.user!.userId);
  res.json({ profile });
});

// PUT /api/personalize/profile — manual edits from settings
router.put('/profile', async (req: Request, res: Response) => {
  const { observations, restrictions, enabled } = req.body;
  const updates: Record<string, any> = {};
  if (observations !== undefined) updates.observations = observations;
  if (restrictions !== undefined) updates.restrictions = restrictions;
  if (enabled !== undefined) updates.enabled = enabled;

  await updatePersonalize(req.user!.userId, updates);
  const profile = await getPersonalize(req.user!.userId);
  res.json({ profile });
});

// DELETE /api/personalize/profile — reset
router.delete('/profile', async (req: Request, res: Response) => {
  await resetPersonalize(req.user!.userId);
  res.json({ success: true });
});

// PUT /api/personalize/toggle
router.put('/toggle', async (req: Request, res: Response) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled (boolean) is required' });
    return;
  }
  await updatePersonalize(req.user!.userId, { enabled });
  res.json({ success: true, enabled });
});

// ─── Interview Flow ─────────────────────────────────────────

// POST /api/personalize/interview/answer — store one answer, advance step
router.post('/interview/answer', async (req: Request, res: Response) => {
  const { step, answer } = req.body;
  if (!step || !answer) {
    res.status(400).json({ error: 'step and answer are required' });
    return;
  }

  const profile = await getPersonalize(req.user!.userId);

  // Store answer
  const answers = [...profile.interviewAnswers.filter(a => a.question !== step), { question: step, answer }];
  await updatePersonalize(req.user!.userId, {
    interviewAnswers: answers,
    interviewStep: step + 1,
  });

  // If this was question 5, generate the comparative question for Q6
  if (step === 5) {
    const comparative = await generateComparativeQuestion(answers);
    res.json({
      nextStep: 6,
      comparative,
      question: `Here are two versions of the same paragraph. Which one sounds more like something you'd say?\n\nVersion A:\n${comparative.versionA}\n\nVersion B:\n${comparative.versionB}`,
    });
    return;
  }

  // For steps 1-4, return the next question
  if (step < 5) {
    res.json({
      nextStep: step + 1,
      question: INTERVIEW_QUESTIONS[step], // 0-indexed, so step gives next question
    });
    return;
  }

  // Step 6 — interview complete, signal synthesis
  res.json({ nextStep: 7, complete: true });
});

// POST /api/personalize/interview/synthesize — build profile from answers
router.post('/interview/synthesize', async (req: Request, res: Response) => {
  const profile = await getPersonalize(req.user!.userId);

  if (profile.interviewAnswers.length < 5) {
    res.status(400).json({ error: 'Need at least 5 interview answers to synthesize' });
    return;
  }

  const result = await synthesizeInterviewProfile(profile.interviewAnswers);

  // Merge with any existing signals (from documents submitted during interview)
  const merged = mergeStyleSignals(profile, result.observations, result.restrictions);

  await updatePersonalize(req.user!.userId, {
    observations: merged.observations,
    restrictions: merged.restrictions,
    interviewStep: 7,
  });

  const updated = await getPersonalize(req.user!.userId);
  res.json({ profile: updated, summary: result.summary });
});

// ─── Document Analysis ──────────────────────────────────────

// POST /api/personalize/analyze-document
router.post('/analyze-document', async (req: Request, res: Response) => {
  const { text } = req.body;
  if (!text || typeof text !== 'string' || text.length < 50) {
    res.status(400).json({ error: 'text is required (at least 50 characters)' });
    return;
  }

  const userId = req.user!.userId;
  const result = await analyzeDocument(userId, text);
  const profile = await getPersonalize(userId);

  // Merge signals
  const merged = mergeStyleSignals(profile, result.observations, result.restrictions);

  // Store document analysis record
  const documents = [...profile.documents, {
    snippet: text.substring(0, 200),
    observationsFound: result.observations.length,
    analyzedAt: new Date().toISOString(),
  }];

  await updatePersonalize(userId, {
    observations: merged.observations,
    restrictions: merged.restrictions,
    documents,
  });

  const updated = await getPersonalize(userId);
  res.json({
    profile: updated,
    diverges: result.diverges,
    clarifyingQuestion: result.clarifyingQuestion,
    snippetSummary: result.snippetSummary,
    observationsAdded: result.observations.length,
  });
});

// ─── Apply Personalization ──────────────────────────────────

// POST /api/personalize/apply — personalize one chapter
router.post('/apply', async (req: Request, res: Response) => {
  const { storyId, chapterNum } = req.body;
  if (!storyId || !chapterNum) {
    res.status(400).json({ error: 'storyId and chapterNum are required' });
    return;
  }

  const userId = req.user!.userId;
  const profile = await getPersonalize(userId);

  if (profile.observations.length === 0) {
    res.status(400).json({ error: 'No personalization profile found. Complete the style interview first.' });
    return;
  }

  if (!profile.enabled) {
    res.status(400).json({ error: 'Personalization is disabled in settings.' });
    return;
  }

  // Fetch the story and chapter
  const story = await prisma.fiveChapterStory.findUnique({
    where: { id: storyId },
    include: { chapters: true },
  });

  if (!story) {
    res.status(404).json({ error: 'Story not found' });
    return;
  }

  const chapter = story.chapters.find(c => c.chapterNum === chapterNum);
  if (!chapter || !chapter.content) {
    res.status(404).json({ error: `Chapter ${chapterNum} not found or has no content` });
    return;
  }

  // Run the pipeline
  const result = await personalizeChapter(chapter.content, profile, {
    medium: story.medium,
    chapterNum,
  });

  // Update chapter content
  await prisma.chapterContent.update({
    where: { id: chapter.id },
    data: { content: result.text },
  });

  // Create version record
  const maxVersion = await prisma.chapterVersion.aggregate({
    where: { chapterContentId: chapter.id },
    _max: { versionNum: true },
  });
  await prisma.chapterVersion.create({
    data: {
      chapterContentId: chapter.id,
      title: chapter.title,
      content: result.text,
      versionNum: (maxVersion._max.versionNum || 0) + 1,
      changeSource: 'personalized',
    },
  });

  // Return updated chapter
  const updatedChapter = await prisma.chapterContent.findUnique({
    where: { id: chapter.id },
  });

  res.json({
    chapter: updatedChapter,
    passed: result.passed,
    attempts: result.attempts,
  });
});

// POST /api/personalize/apply-all — personalize the blended story text
// Includes automatic Polish if not already polished.
router.post('/apply-all', async (req: Request, res: Response) => {
  const { storyId } = req.body;
  if (!storyId) {
    res.status(400).json({ error: 'storyId is required' });
    return;
  }

  const userId = req.user!.userId;
  const profile = await getPersonalize(userId);

  if (profile.observations.length === 0) {
    res.status(400).json({ error: 'No personalization profile found.' });
    return;
  }

  if (!profile.enabled) {
    res.status(400).json({ error: 'Personalization is disabled.' });
    return;
  }

  const story = await prisma.fiveChapterStory.findFirst({
    where: { id: storyId, draft: { offering: { workspaceId: req.workspaceId } } },
    include: { chapters: { orderBy: { chapterNum: 'asc' } } },
  });

  if (!story) {
    res.status(404).json({ error: 'Story not found' });
    return;
  }

  if (!story.blendedText || !story.blendedText.trim()) {
    res.status(400).json({ error: 'Blend the story first, then personalize.' });
    return;
  }

  // Personalize operates on the blended text as a whole.
  // Step 1: Polish first (automatically) if not already polished.
  const { checkProse, buildProseViolationFeedback } = await import('../services/voiceCheck.js');
  const { callAI } = await import('../services/ai.js');

  let textToPersonalize = story.blendedText;

  const proseCheck = await checkProse(textToPersonalize, `Blended Five Chapter Story (${story.medium} format)`);
  if (!proseCheck.passed && proseCheck.violations.length > 0) {
    const feedback = buildProseViolationFeedback(proseCheck.violations);
    textToPersonalize = await callAI(
      `You are a careful editor. Rewrite this text to fix the specific voice violations listed below. Keep the same content, structure, and approximate length. Only change what needs fixing.${feedback}`,
      `TEXT TO POLISH:\n${textToPersonalize}\n\nReturn ONLY the polished text.`,
      'elite'
    );
  }

  // Step 2: Personalize the (polished) blended text
  const result = await personalizeChapter(textToPersonalize, profile, {
    medium: story.medium,
    chapterNum: 0, // 0 = blended text, not a specific chapter
  });

  // Save personalized blended text
  await prisma.fiveChapterStory.update({
    where: { id: storyId },
    data: { blendedText: result.text, stage: 'personalized', version: { increment: 1 } },
  });

  // Snapshot for version history
  const maxVer = await prisma.storyVersion.aggregate({
    where: { storyId },
    _max: { versionNum: true },
  });
  await prisma.storyVersion.create({
    data: {
      storyId,
      snapshot: { blendedText: result.text, stage: 'blended', medium: story.medium },
      label: 'Personalized',
      versionNum: (maxVer._max?.versionNum ?? 0) + 1,
    },
  });

  // Return updated story
  const updated = await prisma.fiveChapterStory.findUnique({
    where: { id: storyId },
    include: { chapters: { orderBy: { chapterNum: 'asc' } } },
  });

  res.json({ story: updated, passed: result.passed, attempts: result.attempts });
});

export default router;
