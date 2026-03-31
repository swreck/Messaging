import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, requireEditor } from '../middleware/workspace.js';
import { param } from '../lib/params.js';

const router = Router();
router.use(requireAuth);
router.use(requireWorkspace);

// GET /api/drafts
router.get('/', async (req: Request, res: Response) => {
  const includeArchived = req.query.includeArchived === 'true';
  const drafts = await prisma.threeTierDraft.findMany({
    where: {
      offering: { workspaceId: req.workspaceId },
      ...(!includeArchived ? { archived: false } : {}),
    },
    include: {
      offering: { select: { id: true, name: true } },
      audience: { select: { id: true, name: true } },
    },
    orderBy: { updatedAt: 'desc' },
  });
  res.json({ drafts });
});

// GET /api/drafts/hierarchy — full tree: offerings → audiences → three-tiers → deliverables
router.get('/hierarchy', async (req: Request, res: Response) => {
  const includeArchived = req.query.includeArchived === 'true';
  const offerings = await prisma.offering.findMany({
    where: { workspaceId: req.workspaceId },
    include: {
      elements: { select: { id: true } },
      drafts: {
        where: includeArchived ? {} : { archived: false },
        include: {
          audience: { select: { id: true, name: true } },
          stories: {
            select: { id: true, medium: true, stage: true, updatedAt: true },
            orderBy: { updatedAt: 'desc' },
          },
        },
        orderBy: { updatedAt: 'desc' },
      },
    },
    orderBy: { updatedAt: 'desc' },
  });

  // Get audiences that don't have drafts yet (for showing "available" audiences)
  const audiences = await prisma.audience.findMany({
    where: { workspaceId: req.workspaceId },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });

  const hierarchy = offerings.map(o => ({
    id: o.id,
    name: o.name,
    elementCount: o.elements.length,
    audiences: o.drafts.map(d => ({
      id: d.audience.id,
      name: d.audience.name,
      threeTier: {
        id: d.id,
        status: d.status,
        currentStep: d.currentStep,
        archived: (d as any).archived ?? false,
      },
      deliverables: d.stories.map(s => ({
        id: s.id,
        medium: s.medium,
        stage: s.stage,
        updatedAt: s.updatedAt.toISOString(),
      })),
    })),
  }));

  res.json({ hierarchy, audiences });
});

// POST /api/drafts
router.post('/', requireEditor, async (req: Request, res: Response) => {
  const { offeringId, audienceId } = req.body;
  if (!offeringId || !audienceId) {
    res.status(400).json({ error: 'offeringId and audienceId are required' });
    return;
  }

  // Verify ownership
  const offering = await prisma.offering.findFirst({ where: { id: offeringId, workspaceId: req.workspaceId } });
  const audience = await prisma.audience.findFirst({ where: { id: audienceId, workspaceId: req.workspaceId } });
  if (!offering || !audience) {
    res.status(404).json({ error: 'Offering or audience not found' });
    return;
  }

  // Enforce unique per offering×audience (only non-archived)
  const existing = await prisma.threeTierDraft.findFirst({
    where: { offeringId, audienceId, archived: false },
  });
  if (existing) {
    res.status(409).json({ error: 'Draft already exists for this offering and audience', draft: existing });
    return;
  }

  const draft = await prisma.threeTierDraft.create({
    data: { offeringId, audienceId },
    include: {
      offering: { select: { id: true, name: true } },
      audience: { select: { id: true, name: true } },
    },
  });
  res.status(201).json({ draft });
});

// GET /api/drafts/:id — full draft with all relations
router.get('/:id', async (req: Request, res: Response) => {
  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: param(req.params.id), offering: { workspaceId: req.workspaceId } },
    include: {
      offering: { include: { elements: { orderBy: { sortOrder: 'asc' } } } },
      audience: { include: { priorities: { orderBy: { sortOrder: 'asc' } } } },
      mappings: {
        include: {
          priority: { select: { id: true, text: true, rank: true } },
          element: { select: { id: true, text: true } },
        },
      },
      tier1Statement: true,
      tier2Statements: {
        orderBy: { sortOrder: 'asc' },
        include: { tier3Bullets: { orderBy: { sortOrder: 'asc' } } },
      },
      tableVersions: { orderBy: { versionNum: 'desc' }, take: 10 },
    },
  });

  if (!draft) {
    res.status(404).json({ error: 'Draft not found' });
    return;
  }

  res.json({ draft });
});

// PATCH /api/drafts/:id — update step or status
router.patch('/:id', requireEditor, async (req: Request, res: Response) => {
  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: param(req.params.id), offering: { workspaceId: req.workspaceId } },
  });
  if (!draft) {
    res.status(404).json({ error: 'Draft not found' });
    return;
  }

  const { currentStep, status } = req.body;
  const updated = await prisma.threeTierDraft.update({
    where: { id: param(req.params.id) },
    data: {
      currentStep: currentStep ?? draft.currentStep,
      status: status ?? draft.status,
    },
  });
  res.json({ draft: updated });
});

// POST /api/drafts/:id/duplicate
router.post('/:id/duplicate', requireEditor, async (req: Request, res: Response) => {
  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: param(req.params.id), offering: { workspaceId: req.workspaceId } },
    include: {
      tier1Statement: true,
      tier2Statements: {
        orderBy: { sortOrder: 'asc' },
        include: { tier3Bullets: { orderBy: { sortOrder: 'asc' } } },
      },
      mappings: true,
    },
  });
  if (!draft) {
    res.status(404).json({ error: 'Draft not found' });
    return;
  }

  // Create the new draft at step 5 (content is already built)
  const newDraft = await prisma.threeTierDraft.create({
    data: {
      offeringId: draft.offeringId,
      audienceId: draft.audienceId,
      currentStep: 5,
      status: draft.status,
    },
  });

  // Copy tier1
  if (draft.tier1Statement) {
    await prisma.tier1Statement.create({
      data: { draftId: newDraft.id, text: draft.tier1Statement.text },
    });
  }

  // Copy tier2 + tier3
  for (const t2 of draft.tier2Statements) {
    const newT2 = await prisma.tier2Statement.create({
      data: {
        draftId: newDraft.id,
        text: t2.text,
        sortOrder: t2.sortOrder,
        priorityId: t2.priorityId,
        categoryLabel: t2.categoryLabel,
      },
    });
    for (const t3 of t2.tier3Bullets) {
      await prisma.tier3Bullet.create({
        data: { tier2Id: newT2.id, text: t3.text, sortOrder: t3.sortOrder },
      });
    }
  }

  // Copy mappings
  for (const m of draft.mappings) {
    await prisma.mapping.create({
      data: {
        draftId: newDraft.id,
        priorityId: m.priorityId,
        elementId: m.elementId,
        confidence: m.confidence,
        status: m.status,
      },
    });
  }

  const result = await prisma.threeTierDraft.findFirst({
    where: { id: newDraft.id },
    include: {
      offering: { select: { id: true, name: true } },
      audience: { select: { id: true, name: true } },
    },
  });
  res.status(201).json({ draft: result });
});

// PUT /api/drafts/:id/archive
router.put('/:id/archive', requireEditor, async (req: Request, res: Response) => {
  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: param(req.params.id), offering: { workspaceId: req.workspaceId } },
  });
  if (!draft) {
    res.status(404).json({ error: 'Draft not found' });
    return;
  }

  const updated = await prisma.threeTierDraft.update({
    where: { id: param(req.params.id) },
    data: { archived: true },
  });
  res.json({ draft: updated });
});

// PUT /api/drafts/:id/unarchive
router.put('/:id/unarchive', requireEditor, async (req: Request, res: Response) => {
  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: param(req.params.id), offering: { workspaceId: req.workspaceId } },
  });
  if (!draft) {
    res.status(404).json({ error: 'Draft not found' });
    return;
  }

  const updated = await prisma.threeTierDraft.update({
    where: { id: param(req.params.id) },
    data: { archived: false },
  });
  res.json({ draft: updated });
});

// DELETE /api/drafts/:id
router.delete('/:id', requireEditor, async (req: Request, res: Response) => {
  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: param(req.params.id), offering: { workspaceId: req.workspaceId } },
  });
  if (!draft) {
    res.status(404).json({ error: 'Draft not found' });
    return;
  }

  await prisma.threeTierDraft.delete({ where: { id: param(req.params.id) } });
  res.json({ success: true });
});

export default router;
