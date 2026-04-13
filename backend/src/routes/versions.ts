import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace } from '../middleware/workspace.js';
import { param } from '../lib/params.js';

const router = Router();
router.use(requireAuth);
router.use(requireWorkspace);

// GET /api/versions/cell/:cellType/:cellId — cell version history
router.get('/cell/:cellType/:cellId', async (req: Request, res: Response) => {
  const cellType = param(req.params.cellType);
  const cellId = param(req.params.cellId);
  const where = cellType === 'tier1'
    ? { tier1Id: cellId }
    : cellType === 'tier2'
    ? { tier2Id: cellId }
    : { tier3Id: cellId };

  const versions = await prisma.cellVersion.findMany({
    where,
    orderBy: { versionNum: 'asc' },
  });
  res.json({ versions });
});

// POST /api/versions/cell/:cellType/:cellId/restore/:versionNum
router.post('/cell/:cellType/:cellId/restore/:versionNum', async (req: Request, res: Response) => {
  const cellType = param(req.params.cellType);
  const cellId = param(req.params.cellId);
  const versionNum = param(req.params.versionNum);
  const where = cellType === 'tier1'
    ? { tier1Id: cellId }
    : cellType === 'tier2'
    ? { tier2Id: cellId }
    : { tier3Id: cellId };

  const version = await prisma.cellVersion.findFirst({
    where: { ...where, versionNum: parseInt(versionNum, 10) },
  });
  if (!version) {
    res.status(404).json({ error: 'Version not found' });
    return;
  }

  // Update the actual cell
  if (cellType === 'tier1') {
    await prisma.tier1Statement.update({ where: { id: cellId }, data: { text: version.text } });
  } else if (cellType === 'tier2') {
    await prisma.tier2Statement.update({ where: { id: cellId }, data: { text: version.text } });
  } else {
    await prisma.tier3Bullet.update({ where: { id: cellId }, data: { text: version.text } });
  }

  // Create a new version entry for the restore
  const maxVersion = await prisma.cellVersion.aggregate({
    where,
    _max: { versionNum: true },
  });
  await prisma.cellVersion.create({
    data: {
      ...where,
      text: version.text,
      versionNum: (maxVersion._max?.versionNum ?? 0) + 1,
      changeSource: 'manual',
    },
  });

  res.json({ text: version.text });
});

// ─── Table Versions ─────────────────────────────────────

// GET /api/versions/table/:draftId
router.get('/table/:draftId', async (req: Request, res: Response) => {
  const versions = await prisma.tableVersion.findMany({
    where: { draftId: param(req.params.draftId) },
    orderBy: { versionNum: 'desc' },
  });
  res.json({ versions });
});

// POST /api/versions/table/:draftId — create snapshot
router.post('/table/:draftId', async (req: Request, res: Response) => {
  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: param(req.params.draftId), offering: { workspaceId: req.workspaceId } },
    include: {
      tier1Statement: true,
      tier2Statements: {
        orderBy: { sortOrder: 'asc' },
        include: { tier3Bullets: { orderBy: { sortOrder: 'asc' } } },
      },
    },
  });
  if (!draft) {
    res.status(404).json({ error: 'Draft not found' });
    return;
  }

  const { label } = req.body;
  const maxVersion = await prisma.tableVersion.aggregate({
    where: { draftId: param(req.params.draftId) },
    _max: { versionNum: true },
  });

  const snapshot = {
    tier1: draft.tier1Statement?.text || '',
    tier2: draft.tier2Statements.map((t2) => ({
      text: t2.text,
      priorityId: t2.priorityId,
      categoryLabel: t2.categoryLabel || '',
      tier3: t2.tier3Bullets.map((t3) => t3.text),
    })),
  };

  const version = await prisma.tableVersion.create({
    data: {
      draftId: param(req.params.draftId),
      snapshot,
      label: label || `Snapshot ${(maxVersion._max?.versionNum ?? 0) + 1}`,
      versionNum: (maxVersion._max?.versionNum ?? 0) + 1,
    },
  });

  res.status(201).json({ version });
});

// PATCH /api/versions/table/:versionId — rename a checkpoint
router.patch('/table/:versionId', async (req: Request, res: Response) => {
  const { label } = req.body;
  if (typeof label !== 'string' || !label.trim()) {
    res.status(400).json({ error: 'label required' });
    return;
  }
  const version = await prisma.tableVersion.findFirst({
    where: { id: param(req.params.versionId), draft: { offering: { workspaceId: req.workspaceId } } },
  });
  if (!version) {
    res.status(404).json({ error: 'Version not found' });
    return;
  }
  const updated = await prisma.tableVersion.update({
    where: { id: version.id },
    data: { label: label.trim() },
  });
  res.json({ version: updated });
});

// POST /api/versions/table/:draftId/restore/:versionId
router.post('/table/:draftId/restore/:versionId', async (req: Request, res: Response) => {
  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: param(req.params.draftId), offering: { workspaceId: req.workspaceId } },
  });
  if (!draft) {
    res.status(404).json({ error: 'Draft not found' });
    return;
  }

  const version = await prisma.tableVersion.findFirst({
    where: { id: param(req.params.versionId), draftId: param(req.params.draftId) },
  });
  if (!version) {
    res.status(404).json({ error: 'Version not found' });
    return;
  }

  const snapshot = version.snapshot as any;

  // Auto-snapshot current state before restoring so the user can undo
  const currentDraft = await prisma.threeTierDraft.findFirst({
    where: { id: param(req.params.draftId) },
    include: {
      tier1Statement: true,
      tier2Statements: {
        orderBy: { sortOrder: 'asc' },
        include: { tier3Bullets: { orderBy: { sortOrder: 'asc' } } },
      },
    },
  });
  if (currentDraft) {
    const maxVersion = await prisma.tableVersion.aggregate({
      where: { draftId: param(req.params.draftId) },
      _max: { versionNum: true },
    });
    const nextNum = (maxVersion._max?.versionNum ?? 0) + 1;
    await prisma.tableVersion.create({
      data: {
        draftId: param(req.params.draftId),
        snapshot: {
          tier1: currentDraft.tier1Statement?.text || '',
          tier2: currentDraft.tier2Statements.map((t2) => ({
            text: t2.text,
            priorityId: t2.priorityId,
            categoryLabel: t2.categoryLabel || '',
            tier3: t2.tier3Bullets.map((t3) => t3.text),
          })),
        },
        label: `Before restore — ${new Date().toLocaleString()}`,
        versionNum: nextNum,
      },
    });
  }

  // Clear existing statements
  await prisma.tier2Statement.deleteMany({ where: { draftId: param(req.params.draftId) } });
  await prisma.tier1Statement.deleteMany({ where: { draftId: param(req.params.draftId) } });

  // Restore tier1
  if (snapshot.tier1) {
    await prisma.tier1Statement.create({
      data: { draftId: param(req.params.draftId), text: snapshot.tier1 },
    });
  }

  // Restore tier2 + tier3
  for (let i = 0; i < (snapshot.tier2 || []).length; i++) {
    const t2 = snapshot.tier2[i];
    const tier2 = await prisma.tier2Statement.create({
      data: {
        draftId: param(req.params.draftId),
        text: t2.text,
        sortOrder: i,
        priorityId: t2.priorityId || null,
        categoryLabel: t2.categoryLabel || '',
      },
    });
    for (let j = 0; j < (t2.tier3 || []).length; j++) {
      await prisma.tier3Bullet.create({
        data: { tier2Id: tier2.id, text: t2.tier3[j], sortOrder: j },
      });
    }
  }

  res.json({ success: true });
});

// ─── Chapter Versions ──────────────────────────────────

// GET /api/versions/chapter/:chapterContentId
router.get('/chapter/:chapterContentId', async (req: Request, res: Response) => {
  const versions = await prisma.chapterVersion.findMany({
    where: { chapterContentId: param(req.params.chapterContentId) },
    orderBy: { versionNum: 'asc' },
  });
  res.json({ versions });
});

// POST /api/versions/chapter/:chapterContentId/restore/:versionNum
router.post('/chapter/:chapterContentId/restore/:versionNum', async (req: Request, res: Response) => {
  const chapterContentId = param(req.params.chapterContentId);
  const versionNum = parseInt(param(req.params.versionNum), 10);

  const version = await prisma.chapterVersion.findFirst({
    where: { chapterContentId, versionNum },
  });
  if (!version) {
    res.status(404).json({ error: 'Version not found' });
    return;
  }

  // Update the chapter content
  await prisma.chapterContent.update({
    where: { id: chapterContentId },
    data: { title: version.title, content: version.content },
  });

  // Create a new version entry for the restore
  const maxVer = await prisma.chapterVersion.aggregate({
    where: { chapterContentId },
    _max: { versionNum: true },
  });
  await prisma.chapterVersion.create({
    data: {
      chapterContentId,
      title: version.title,
      content: version.content,
      versionNum: (maxVer._max?.versionNum ?? 0) + 1,
      changeSource: 'manual',
    },
  });

  res.json({ title: version.title, content: version.content });
});

// ─── Story Versions ────────────────────────────────────

// GET /api/versions/story/:storyId
router.get('/story/:storyId', async (req: Request, res: Response) => {
  const versions = await prisma.storyVersion.findMany({
    where: { storyId: param(req.params.storyId) },
    orderBy: { versionNum: 'desc' },
  });
  res.json({ versions });
});

// POST /api/versions/story/:storyId — create story snapshot
router.post('/story/:storyId', async (req: Request, res: Response) => {
  const story = await prisma.fiveChapterStory.findFirst({
    where: { id: param(req.params.storyId), draft: { offering: { workspaceId: req.workspaceId } } },
    include: { chapters: { orderBy: { chapterNum: 'asc' } } },
  });
  if (!story) {
    res.status(404).json({ error: 'Story not found' });
    return;
  }

  const { label } = req.body;
  const maxVersion = await prisma.storyVersion.aggregate({
    where: { storyId: param(req.params.storyId) },
    _max: { versionNum: true },
  });

  const snapshot = {
    medium: story.medium,
    cta: story.cta,
    emphasis: story.emphasis,
    stage: story.stage,
    joinedText: story.joinedText,
    blendedText: story.blendedText,
    chapters: story.chapters.map(c => ({ chapterNum: c.chapterNum, title: c.title, content: c.content })),
  };

  const version = await prisma.storyVersion.create({
    data: {
      storyId: param(req.params.storyId),
      snapshot,
      label: label || `Snapshot ${(maxVersion._max?.versionNum ?? 0) + 1}`,
      versionNum: (maxVersion._max?.versionNum ?? 0) + 1,
    },
  });

  res.status(201).json({ version });
});

// POST /api/versions/story/:storyId/restore/:versionId
router.post('/story/:storyId/restore/:versionId', async (req: Request, res: Response) => {
  const storyId = param(req.params.storyId);
  const story = await prisma.fiveChapterStory.findFirst({
    where: { id: storyId, draft: { offering: { workspaceId: req.workspaceId } } },
  });
  if (!story) {
    res.status(404).json({ error: 'Story not found' });
    return;
  }

  const version = await prisma.storyVersion.findFirst({
    where: { id: param(req.params.versionId), storyId },
  });
  if (!version) {
    res.status(404).json({ error: 'Version not found' });
    return;
  }

  const snapshot = version.snapshot as any;

  // Auto-snapshot current state before restoring so the user can undo
  const currentStory = await prisma.fiveChapterStory.findFirst({
    where: { id: storyId },
    include: { chapters: { orderBy: { chapterNum: 'asc' } } },
  });
  if (currentStory) {
    const maxVersion = await prisma.storyVersion.aggregate({
      where: { storyId },
      _max: { versionNum: true },
    });
    const nextNum = (maxVersion._max?.versionNum ?? 0) + 1;
    await prisma.storyVersion.create({
      data: {
        storyId,
        snapshot: {
          medium: currentStory.medium,
          cta: currentStory.cta,
          emphasis: currentStory.emphasis,
          stage: currentStory.stage,
          joinedText: currentStory.joinedText || '',
          blendedText: currentStory.blendedText || '',
          chapters: currentStory.chapters.map(c => ({
            chapterNum: c.chapterNum,
            title: c.title,
            content: c.content,
          })),
        },
        label: `Before restore — ${new Date().toLocaleString()}`,
        versionNum: nextNum,
      },
    });
  }

  // Restore story fields
  await prisma.fiveChapterStory.update({
    where: { id: storyId },
    data: {
      medium: snapshot.medium ?? story.medium,
      cta: snapshot.cta ?? story.cta,
      emphasis: snapshot.emphasis ?? story.emphasis,
      stage: snapshot.stage ?? story.stage,
      joinedText: snapshot.joinedText ?? '',
      blendedText: snapshot.blendedText ?? '',
    },
  });

  // Restore chapters
  if (snapshot.chapters) {
    for (const ch of snapshot.chapters) {
      await prisma.chapterContent.upsert({
        where: { storyId_chapterNum: { storyId, chapterNum: ch.chapterNum } },
        update: { title: ch.title, content: ch.content },
        create: { storyId, chapterNum: ch.chapterNum, title: ch.title, content: ch.content },
      });
    }
  }

  res.json({ success: true });
});

export default router;
