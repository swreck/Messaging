import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace } from '../middleware/workspace.js';
import { param } from '../lib/params.js';

const router = Router();

// POST /api/share — create a share link (requires auth + workspace)
router.post('/', requireAuth, requireWorkspace, async (req: Request, res: Response) => {
  const { draftId, storyId } = req.body;
  if (!draftId && !storyId) {
    res.status(400).json({ error: 'draftId or storyId required' });
    return;
  }

  // Verify the user has access to the draft/story in their workspace
  if (draftId) {
    const draft = await prisma.threeTierDraft.findFirst({
      where: { id: draftId, offering: { workspaceId: req.workspaceId } },
    });
    if (!draft) {
      res.status(404).json({ error: 'Draft not found in your workspace' });
      return;
    }
  }
  if (storyId) {
    const story = await prisma.fiveChapterStory.findFirst({
      where: { id: storyId, draft: { offering: { workspaceId: req.workspaceId } } },
    });
    if (!story) {
      res.status(404).json({ error: 'Story not found in your workspace' });
      return;
    }
  }

  const token = crypto.randomBytes(16).toString('hex');

  const shareLink = await prisma.shareLink.create({
    data: {
      token,
      draftId: draftId || null,
      storyId: storyId || null,
      createdBy: req.user!.userId,
    },
  });

  res.json({ token: shareLink.token, url: `/s/${shareLink.token}` });
});

// GET /api/share/:token — public endpoint, no auth required
router.get('/:token', async (req: Request, res: Response) => {
  const token = param(req.params.token);

  const shareLink = await prisma.shareLink.findUnique({
    where: { token },
  });

  if (!shareLink) {
    res.status(404).json({ error: 'Share link not found' });
    return;
  }

  if (shareLink.expiresAt && shareLink.expiresAt < new Date()) {
    res.status(410).json({ error: 'Share link has expired' });
    return;
  }

  // Return draft data
  if (shareLink.draftId) {
    const draft = await prisma.threeTierDraft.findUnique({
      where: { id: shareLink.draftId },
      include: {
        offering: { select: { name: true } },
        audience: { select: { name: true } },
        tier1Statement: true,
        tier2Statements: {
          orderBy: { sortOrder: 'asc' },
          include: {
            tier3Bullets: { orderBy: { sortOrder: 'asc' } },
          },
        },
      },
    });

    if (!draft) {
      res.status(404).json({ error: 'Draft not found' });
      return;
    }

    res.json({
      type: 'three-tier',
      offering: draft.offering.name,
      audience: draft.audience.name,
      tier1: draft.tier1Statement?.text || '',
      tier2: draft.tier2Statements.map(t2 => ({
        categoryLabel: t2.categoryLabel,
        text: t2.text,
        tier3: t2.tier3Bullets.map(t3 => t3.text),
      })),
    });
    return;
  }

  // Return story data
  if (shareLink.storyId) {
    const story = await prisma.fiveChapterStory.findUnique({
      where: { id: shareLink.storyId },
      include: {
        chapters: { orderBy: { chapterNum: 'asc' } },
        draft: {
          select: {
            offering: { select: { name: true } },
            audience: { select: { name: true } },
          },
        },
      },
    });

    if (!story) {
      res.status(404).json({ error: 'Story not found' });
      return;
    }

    res.json({
      type: 'five-chapter',
      offering: story.draft.offering.name,
      audience: story.draft.audience.name,
      medium: story.medium,
      cta: story.cta,
      blendedText: story.blendedText || null,
      chapters: story.chapters.map(c => ({
        chapterNum: c.chapterNum,
        title: c.title,
        content: c.content,
      })),
    });
    return;
  }

  res.status(404).json({ error: 'No content linked to this share' });
});

export default router;
