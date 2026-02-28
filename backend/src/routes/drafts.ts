import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { param } from '../lib/params.js';

const router = Router();
router.use(requireAuth);

// GET /api/drafts
router.get('/', async (req: Request, res: Response) => {
  const drafts = await prisma.threeTierDraft.findMany({
    where: { offering: { userId: req.user!.userId } },
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
  const userId = req.user!.userId;

  const offerings = await prisma.offering.findMany({
    where: { userId },
    include: {
      elements: { select: { id: true } },
      drafts: {
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
    where: { userId },
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
router.post('/', async (req: Request, res: Response) => {
  const { offeringId, audienceId } = req.body;
  if (!offeringId || !audienceId) {
    res.status(400).json({ error: 'offeringId and audienceId are required' });
    return;
  }

  // Verify ownership
  const offering = await prisma.offering.findFirst({ where: { id: offeringId, userId: req.user!.userId } });
  const audience = await prisma.audience.findFirst({ where: { id: audienceId, userId: req.user!.userId } });
  if (!offering || !audience) {
    res.status(404).json({ error: 'Offering or audience not found' });
    return;
  }

  // Enforce unique per offering×audience
  const existing = await prisma.threeTierDraft.findUnique({
    where: { offeringId_audienceId: { offeringId, audienceId } },
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
    where: { id: param(req.params.id), offering: { userId: req.user!.userId } },
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
router.patch('/:id', async (req: Request, res: Response) => {
  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: param(req.params.id), offering: { userId: req.user!.userId } },
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

// DELETE /api/drafts/:id
router.delete('/:id', async (req: Request, res: Response) => {
  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: param(req.params.id), offering: { userId: req.user!.userId } },
  });
  if (!draft) {
    res.status(404).json({ error: 'Draft not found' });
    return;
  }

  await prisma.threeTierDraft.delete({ where: { id: param(req.params.id) } });
  res.json({ success: true });
});

export default router;
