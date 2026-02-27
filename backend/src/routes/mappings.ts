import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { param } from '../lib/params.js';

const router = Router();
router.use(requireAuth);

// GET /api/mappings/:draftId
router.get('/:draftId', async (req: Request, res: Response) => {
  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: param(req.params.draftId), offering: { userId: req.user!.userId } },
  });
  if (!draft) {
    res.status(404).json({ error: 'Draft not found' });
    return;
  }

  const mappings = await prisma.mapping.findMany({
    where: { draftId: param(req.params.draftId) },
    include: {
      priority: { select: { id: true, text: true, rank: true } },
      element: { select: { id: true, text: true } },
    },
  });
  res.json({ mappings });
});

// POST /api/mappings/:draftId
router.post('/:draftId', async (req: Request, res: Response) => {
  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: param(req.params.draftId), offering: { userId: req.user!.userId } },
  });
  if (!draft) {
    res.status(404).json({ error: 'Draft not found' });
    return;
  }

  const { priorityId, elementId, confidence, status } = req.body;
  if (!priorityId || !elementId) {
    res.status(400).json({ error: 'priorityId and elementId are required' });
    return;
  }

  const mapping = await prisma.mapping.create({
    data: {
      draftId: param(req.params.draftId),
      priorityId,
      elementId,
      confidence: confidence ?? 0,
      status: status || 'confirmed',
    },
    include: {
      priority: { select: { id: true, text: true, rank: true } },
      element: { select: { id: true, text: true } },
    },
  });
  res.status(201).json({ mapping });
});

// PATCH /api/mappings/:draftId/:mappingId
router.patch('/:draftId/:mappingId', async (req: Request, res: Response) => {
  const mapping = await prisma.mapping.findFirst({
    where: { id: param(req.params.mappingId), draft: { id: param(req.params.draftId), offering: { userId: req.user!.userId } } },
  });
  if (!mapping) {
    res.status(404).json({ error: 'Mapping not found' });
    return;
  }

  const { status, confidence } = req.body;
  const updated = await prisma.mapping.update({
    where: { id: param(req.params.mappingId) },
    data: {
      status: status ?? mapping.status,
      confidence: confidence ?? mapping.confidence,
    },
    include: {
      priority: { select: { id: true, text: true, rank: true } },
      element: { select: { id: true, text: true } },
    },
  });
  res.json({ mapping: updated });
});

// DELETE /api/mappings/:draftId/:mappingId
router.delete('/:draftId/:mappingId', async (req: Request, res: Response) => {
  const mapping = await prisma.mapping.findFirst({
    where: { id: param(req.params.mappingId), draft: { id: param(req.params.draftId), offering: { userId: req.user!.userId } } },
  });
  if (!mapping) {
    res.status(404).json({ error: 'Mapping not found' });
    return;
  }

  await prisma.mapping.delete({ where: { id: param(req.params.mappingId) } });
  res.json({ success: true });
});

// POST /api/mappings/:draftId/bulk — save multiple mappings at once
router.post('/:draftId/bulk', async (req: Request, res: Response) => {
  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: param(req.params.draftId), offering: { userId: req.user!.userId } },
  });
  if (!draft) {
    res.status(404).json({ error: 'Draft not found' });
    return;
  }

  const { mappings } = req.body;
  if (!Array.isArray(mappings)) {
    res.status(400).json({ error: 'mappings array required' });
    return;
  }

  // Clear existing suggested mappings
  await prisma.mapping.deleteMany({
    where: { draftId: param(req.params.draftId), status: 'suggested' },
  });

  const created = await Promise.all(
    mappings.map((m: any) =>
      prisma.mapping.create({
        data: {
          draftId: param(req.params.draftId),
          priorityId: m.priorityId,
          elementId: m.elementId,
          confidence: m.confidence ?? 0,
          status: m.status || 'suggested',
        },
        include: {
          priority: { select: { id: true, text: true, rank: true } },
          element: { select: { id: true, text: true } },
        },
      })
    )
  );

  res.status(201).json({ mappings: created });
});

export default router;
