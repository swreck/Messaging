import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { param } from '../lib/params.js';

const router = Router();
router.use(requireAuth);

// GET /api/audiences
router.get('/', async (req: Request, res: Response) => {
  const audiences = await prisma.audience.findMany({
    where: { userId: req.user!.userId },
    include: { priorities: { orderBy: { sortOrder: 'asc' } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ audiences });
});

// POST /api/audiences
router.post('/', async (req: Request, res: Response) => {
  const { name, description } = req.body;
  if (!name) {
    res.status(400).json({ error: 'Name is required' });
    return;
  }

  const audience = await prisma.audience.create({
    data: { name, description: description || '', userId: req.user!.userId },
    include: { priorities: true },
  });
  res.status(201).json({ audience });
});

// PUT /api/audiences/:id
router.put('/:id', async (req: Request, res: Response) => {
  const { name, description } = req.body;
  const audience = await prisma.audience.findFirst({
    where: { id: param(req.params.id), userId: req.user!.userId },
  });
  if (!audience) {
    res.status(404).json({ error: 'Audience not found' });
    return;
  }

  const updated = await prisma.audience.update({
    where: { id: param(req.params.id) },
    data: { name: name ?? audience.name, description: description ?? audience.description },
    include: { priorities: { orderBy: { sortOrder: 'asc' } } },
  });
  res.json({ audience: updated });
});

// DELETE /api/audiences/:id
router.delete('/:id', async (req: Request, res: Response) => {
  const audience = await prisma.audience.findFirst({
    where: { id: param(req.params.id), userId: req.user!.userId },
  });
  if (!audience) {
    res.status(404).json({ error: 'Audience not found' });
    return;
  }

  await prisma.audience.delete({ where: { id: param(req.params.id) } });
  res.json({ success: true });
});

// POST /api/audiences/bulk — create multiple audiences at once (from discovery)
router.post('/bulk', async (req: Request, res: Response) => {
  const { audiences: audienceList } = req.body;
  if (!Array.isArray(audienceList) || audienceList.length === 0) {
    res.status(400).json({ error: 'audiences array is required' });
    return;
  }

  const created = await Promise.all(
    audienceList.map((a: { name: string; description?: string }) =>
      prisma.audience.create({
        data: { name: a.name, description: a.description || '', userId: req.user!.userId },
        include: { priorities: true },
      })
    )
  );
  res.status(201).json({ audiences: created });
});

// ─── Priorities ───────────────────────────────────────

// POST /api/audiences/:id/priorities
router.post('/:id/priorities', async (req: Request, res: Response) => {
  const audience = await prisma.audience.findFirst({
    where: { id: param(req.params.id), userId: req.user!.userId },
  });
  if (!audience) {
    res.status(404).json({ error: 'Audience not found' });
    return;
  }

  const { text, rank, isSpoken, motivatingFactor, whatAudienceThinks } = req.body;
  if (!text) {
    res.status(400).json({ error: 'Text is required' });
    return;
  }

  const maxOrder = await prisma.priority.aggregate({
    where: { audienceId: param(req.params.id) },
    _max: { sortOrder: true },
  });

  const priority = await prisma.priority.create({
    data: {
      audienceId: param(req.params.id),
      text,
      rank: rank ?? 0,
      isSpoken: isSpoken ?? true,
      motivatingFactor: motivatingFactor || '',
      whatAudienceThinks: whatAudienceThinks || '',
      sortOrder: (maxOrder._max?.sortOrder ?? -1) + 1,
    },
  });
  res.status(201).json({ priority });
});

// PUT /api/audiences/:audienceId/priorities/:priorityId
router.put('/:audienceId/priorities/:priorityId', async (req: Request, res: Response) => {
  const priority = await prisma.priority.findFirst({
    where: { id: param(req.params.priorityId), audience: { id: param(req.params.audienceId), userId: req.user!.userId } },
  });
  if (!priority) {
    res.status(404).json({ error: 'Priority not found' });
    return;
  }

  const { text, rank, isSpoken, motivatingFactor, whatAudienceThinks } = req.body;
  const updated = await prisma.priority.update({
    where: { id: param(req.params.priorityId) },
    data: {
      text: text ?? priority.text,
      rank: rank ?? priority.rank,
      isSpoken: isSpoken ?? priority.isSpoken,
      motivatingFactor: motivatingFactor ?? priority.motivatingFactor,
      whatAudienceThinks: whatAudienceThinks ?? priority.whatAudienceThinks,
    },
  });
  res.json({ priority: updated });
});

// DELETE /api/audiences/:audienceId/priorities/:priorityId
router.delete('/:audienceId/priorities/:priorityId', async (req: Request, res: Response) => {
  const priority = await prisma.priority.findFirst({
    where: { id: param(req.params.priorityId), audience: { id: param(req.params.audienceId), userId: req.user!.userId } },
  });
  if (!priority) {
    res.status(404).json({ error: 'Priority not found' });
    return;
  }

  await prisma.priority.delete({ where: { id: param(req.params.priorityId) } });
  res.json({ success: true });
});

// PUT /api/audiences/:id/priorities/reorder
router.put('/:id/priorities/reorder', async (req: Request, res: Response) => {
  const { priorityIds } = req.body;
  if (!Array.isArray(priorityIds)) {
    res.status(400).json({ error: 'priorityIds array required' });
    return;
  }

  const audience = await prisma.audience.findFirst({
    where: { id: param(req.params.id), userId: req.user!.userId },
  });
  if (!audience) {
    res.status(404).json({ error: 'Audience not found' });
    return;
  }

  await Promise.all(
    priorityIds.map((id: string, index: number) =>
      prisma.priority.update({ where: { id }, data: { sortOrder: index, rank: index + 1 } })
    )
  );

  res.json({ success: true });
});

export default router;
