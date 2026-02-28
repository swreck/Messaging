import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { param } from '../lib/params.js';

const router = Router();
router.use(requireAuth);

// GET /api/stories/all — all stories for the current user with offering/audience context
router.get('/all', async (req: Request, res: Response) => {
  const stories = await prisma.fiveChapterStory.findMany({
    where: { draft: { offering: { userId: req.user!.userId } } },
    include: {
      chapters: { orderBy: { chapterNum: 'asc' } },
      draft: {
        select: {
          id: true,
          currentStep: true,
          status: true,
          offering: { select: { id: true, name: true } },
          audience: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { updatedAt: 'desc' },
  });
  res.json({ stories });
});

// GET /api/stories?draftId=xxx
router.get('/', async (req: Request, res: Response) => {
  const { draftId } = req.query;
  if (!draftId) {
    res.status(400).json({ error: 'draftId query param required' });
    return;
  }

  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: draftId as string, offering: { userId: req.user!.userId } },
  });
  if (!draft) {
    res.status(404).json({ error: 'Draft not found' });
    return;
  }

  const stories = await prisma.fiveChapterStory.findMany({
    where: { draftId: draftId as string },
    include: { chapters: { orderBy: { chapterNum: 'asc' } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ stories });
});

// POST /api/stories
router.post('/', async (req: Request, res: Response) => {
  const { draftId, medium, cta, emphasis } = req.body;
  if (!draftId || !medium || !cta) {
    res.status(400).json({ error: 'draftId, medium, and cta are required' });
    return;
  }

  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: draftId, offering: { userId: req.user!.userId } },
  });
  if (!draft) {
    res.status(404).json({ error: 'Draft not found' });
    return;
  }

  const story = await prisma.fiveChapterStory.create({
    data: {
      draftId,
      medium,
      cta,
      emphasis: emphasis || '',
    },
    include: { chapters: true },
  });
  res.status(201).json({ story });
});

// GET /api/stories/:id
router.get('/:id', async (req: Request, res: Response) => {
  const story = await prisma.fiveChapterStory.findFirst({
    where: { id: param(req.params.id), draft: { offering: { userId: req.user!.userId } } },
    include: { chapters: { orderBy: { chapterNum: 'asc' } } },
  });
  if (!story) {
    res.status(404).json({ error: 'Story not found' });
    return;
  }
  res.json({ story });
});

// PUT /api/stories/:id
router.put('/:id', async (req: Request, res: Response) => {
  const story = await prisma.fiveChapterStory.findFirst({
    where: { id: param(req.params.id), draft: { offering: { userId: req.user!.userId } } },
  });
  if (!story) {
    res.status(404).json({ error: 'Story not found' });
    return;
  }

  const { medium, cta, emphasis, stage, joinedText, blendedText } = req.body;
  const updated = await prisma.fiveChapterStory.update({
    where: { id: param(req.params.id) },
    data: {
      medium: medium ?? story.medium,
      cta: cta ?? story.cta,
      emphasis: emphasis ?? story.emphasis,
      stage: stage ?? story.stage,
      joinedText: joinedText ?? story.joinedText,
      blendedText: blendedText ?? story.blendedText,
    },
    include: { chapters: { orderBy: { chapterNum: 'asc' } } },
  });
  res.json({ story: updated });
});

// PUT /api/stories/:storyId/chapters/:chapterNum
router.put('/:storyId/chapters/:chapterNum', async (req: Request, res: Response) => {
  const story = await prisma.fiveChapterStory.findFirst({
    where: { id: param(req.params.storyId), draft: { offering: { userId: req.user!.userId } } },
  });
  if (!story) {
    res.status(404).json({ error: 'Story not found' });
    return;
  }

  const chapterNum = parseInt(param(req.params.chapterNum), 10);
  const { title, content } = req.body;

  const chapter = await prisma.chapterContent.upsert({
    where: { storyId_chapterNum: { storyId: param(req.params.storyId), chapterNum } },
    update: { title: title ?? undefined, content: content ?? undefined },
    create: { storyId: param(req.params.storyId), chapterNum, title: title || '', content: content || '' },
  });
  res.json({ chapter });
});

// DELETE /api/stories/:id
router.delete('/:id', async (req: Request, res: Response) => {
  const story = await prisma.fiveChapterStory.findFirst({
    where: { id: param(req.params.id), draft: { offering: { userId: req.user!.userId } } },
  });
  if (!story) {
    res.status(404).json({ error: 'Story not found' });
    return;
  }

  await prisma.fiveChapterStory.delete({ where: { id: param(req.params.id) } });
  res.json({ success: true });
});

export default router;
