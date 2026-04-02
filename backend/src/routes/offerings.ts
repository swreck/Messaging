import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, requireEditor } from '../middleware/workspace.js';
import { param } from '../lib/params.js';

const router = Router();
router.use(requireAuth);
router.use(requireWorkspace);

// GET /api/offerings
router.get('/', async (req: Request, res: Response) => {
  const offerings = await prisma.offering.findMany({
    where: { workspaceId: req.workspaceId },
    include: { elements: { orderBy: { sortOrder: 'asc' } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ offerings });
});

// POST /api/offerings
router.post('/', requireEditor, async (req: Request, res: Response) => {
  const { name, smeRole, description } = req.body;
  if (!name || !name.trim()) {
    res.status(400).json({ error: 'Name is required' });
    return;
  }

  const offering = await prisma.offering.create({
    data: { name, smeRole: smeRole || '', description: description || '', userId: req.user!.userId, workspaceId: req.workspaceId! },
    include: { elements: true },
  });
  res.status(201).json({ offering });
});

// PUT /api/offerings/:id
router.put('/:id', requireEditor, async (req: Request, res: Response) => {
  const { name, smeRole, description } = req.body;
  const offering = await prisma.offering.findFirst({
    where: { id: param(req.params.id), workspaceId: req.workspaceId },
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
router.delete('/:id', requireEditor, async (req: Request, res: Response) => {
  const offering = await prisma.offering.findFirst({
    where: { id: param(req.params.id), workspaceId: req.workspaceId },
  });
  if (!offering) {
    res.status(404).json({ error: 'Offering not found' });
    return;
  }

  await prisma.offering.delete({ where: { id: param(req.params.id) } });
  res.json({ success: true });
});

// POST /api/offerings/:id/duplicate
router.post('/:id/duplicate', requireEditor, async (req: Request, res: Response) => {
  const offering = await prisma.offering.findFirst({
    where: { id: param(req.params.id), workspaceId: req.workspaceId },
    include: { elements: { orderBy: { sortOrder: 'asc' } } },
  });
  if (!offering) {
    res.status(404).json({ error: 'Offering not found' });
    return;
  }

  const newOffering = await prisma.offering.create({
    data: {
      name: `${offering.name} (copy)`,
      smeRole: offering.smeRole,
      description: offering.description,
      userId: req.user!.userId,
      workspaceId: req.workspaceId!,
      elements: {
        create: offering.elements.map(e => ({
          text: e.text,
          source: e.source,
          sortOrder: e.sortOrder,
          motivatingFactor: e.motivatingFactor,
        })),
      },
    },
    include: { elements: { orderBy: { sortOrder: 'asc' } } },
  });
  res.status(201).json({ offering: newOffering });
});

// ─── Elements ─────────────────────────────────────────

// POST /api/offerings/:id/elements
router.post('/:id/elements', requireEditor, async (req: Request, res: Response) => {
  const offering = await prisma.offering.findFirst({
    where: { id: param(req.params.id), workspaceId: req.workspaceId },
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
router.put('/:id/elements/reorder', requireEditor, async (req: Request, res: Response) => {
  const { elementIds } = req.body;
  if (!Array.isArray(elementIds)) {
    res.status(400).json({ error: 'elementIds array required' });
    return;
  }

  const offering = await prisma.offering.findFirst({
    where: { id: param(req.params.id), workspaceId: req.workspaceId },
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
router.put('/:offeringId/elements/:elementId', requireEditor, async (req: Request, res: Response) => {
  const { text, motivatingFactor } = req.body;
  const element = await prisma.offeringElement.findFirst({
    where: { id: param(req.params.elementId), offering: { id: param(req.params.offeringId), workspaceId: req.workspaceId } },
  });
  if (!element) {
    res.status(404).json({ error: 'Element not found' });
    return;
  }

  const updateData: Record<string, any> = {};
  if (text !== undefined) updateData.text = text;
  if (motivatingFactor !== undefined) updateData.motivatingFactor = motivatingFactor;

  const updated = await prisma.offeringElement.update({
    where: { id: param(req.params.elementId) },
    data: Object.keys(updateData).length > 0 ? updateData : { text: element.text },
  });
  res.json({ element: updated });
});

// DELETE /api/offerings/:offeringId/elements/:elementId
router.delete('/:offeringId/elements/:elementId', requireEditor, async (req: Request, res: Response) => {
  const element = await prisma.offeringElement.findFirst({
    where: { id: param(req.params.elementId), offering: { id: param(req.params.offeringId), workspaceId: req.workspaceId } },
  });
  if (!element) {
    res.status(404).json({ error: 'Element not found' });
    return;
  }

  await prisma.offeringElement.delete({ where: { id: param(req.params.elementId) } });
  res.json({ success: true });
});

export default router;
