import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { param } from '../lib/params.js';

const router = Router();
router.use(requireAuth);

// GET /api/offerings
router.get('/', async (req: Request, res: Response) => {
  const offerings = await prisma.offering.findMany({
    where: { userId: req.user!.userId },
    include: { elements: { orderBy: { sortOrder: 'asc' } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ offerings });
});

// POST /api/offerings
router.post('/', async (req: Request, res: Response) => {
  const { name, smeRole, description } = req.body;
  if (!name) {
    res.status(400).json({ error: 'Name is required' });
    return;
  }

  const offering = await prisma.offering.create({
    data: { name, smeRole: smeRole || '', description: description || '', userId: req.user!.userId },
    include: { elements: true },
  });
  res.status(201).json({ offering });
});

// PUT /api/offerings/:id
router.put('/:id', async (req: Request, res: Response) => {
  const { name, smeRole, description } = req.body;
  const offering = await prisma.offering.findFirst({
    where: { id: param(req.params.id), userId: req.user!.userId },
  });
  if (!offering) {
    res.status(404).json({ error: 'Offering not found' });
    return;
  }

  const updated = await prisma.offering.update({
    where: { id: param(req.params.id) },
    data: { name: name ?? offering.name, smeRole: smeRole ?? offering.smeRole, description: description ?? offering.description },
    include: { elements: { orderBy: { sortOrder: 'asc' } } },
  });
  res.json({ offering: updated });
});

// DELETE /api/offerings/:id
router.delete('/:id', async (req: Request, res: Response) => {
  const offering = await prisma.offering.findFirst({
    where: { id: param(req.params.id), userId: req.user!.userId },
  });
  if (!offering) {
    res.status(404).json({ error: 'Offering not found' });
    return;
  }

  await prisma.offering.delete({ where: { id: param(req.params.id) } });
  res.json({ success: true });
});

// ─── Elements ─────────────────────────────────────────

// POST /api/offerings/:id/elements
router.post('/:id/elements', async (req: Request, res: Response) => {
  const offering = await prisma.offering.findFirst({
    where: { id: param(req.params.id), userId: req.user!.userId },
  });
  if (!offering) {
    res.status(404).json({ error: 'Offering not found' });
    return;
  }

  const { text, source } = req.body;
  if (!text) {
    res.status(400).json({ error: 'Text is required' });
    return;
  }

  const maxOrder = await prisma.offeringElement.aggregate({
    where: { offeringId: param(req.params.id) },
    _max: { sortOrder: true },
  });

  const element = await prisma.offeringElement.create({
    data: {
      offeringId: param(req.params.id),
      text,
      source: source || 'manual',
      sortOrder: (maxOrder._max?.sortOrder ?? -1) + 1,
    },
  });
  res.status(201).json({ element });
});

// PUT /api/offerings/:id/elements/reorder — must be before :elementId param route
router.put('/:id/elements/reorder', async (req: Request, res: Response) => {
  const { elementIds } = req.body;
  if (!Array.isArray(elementIds)) {
    res.status(400).json({ error: 'elementIds array required' });
    return;
  }

  const offering = await prisma.offering.findFirst({
    where: { id: param(req.params.id), userId: req.user!.userId },
  });
  if (!offering) {
    res.status(404).json({ error: 'Offering not found' });
    return;
  }

  try {
    await Promise.all(
      elementIds.map((id: string, index: number) =>
        prisma.offeringElement.update({ where: { id }, data: { sortOrder: index } })
      )
    );
    res.json({ success: true });
  } catch {
    res.status(400).json({ error: 'One or more element IDs not found' });
  }
});

// PUT /api/offerings/:offeringId/elements/:elementId
router.put('/:offeringId/elements/:elementId', async (req: Request, res: Response) => {
  const { text } = req.body;
  const element = await prisma.offeringElement.findFirst({
    where: { id: param(req.params.elementId), offering: { id: param(req.params.offeringId), userId: req.user!.userId } },
  });
  if (!element) {
    res.status(404).json({ error: 'Element not found' });
    return;
  }

  const updated = await prisma.offeringElement.update({
    where: { id: param(req.params.elementId) },
    data: { text: text ?? element.text },
  });
  res.json({ element: updated });
});

// DELETE /api/offerings/:offeringId/elements/:elementId
router.delete('/:offeringId/elements/:elementId', async (req: Request, res: Response) => {
  const element = await prisma.offeringElement.findFirst({
    where: { id: param(req.params.elementId), offering: { id: param(req.params.offeringId), userId: req.user!.userId } },
  });
  if (!element) {
    res.status(404).json({ error: 'Element not found' });
    return;
  }

  await prisma.offeringElement.delete({ where: { id: param(req.params.elementId) } });
  res.json({ success: true });
});

export default router;
