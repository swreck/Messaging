import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { resetLearning } from '../lib/learning.js';
import { resetPersonalize } from '../lib/personalize.js';

const router = Router();
router.use(requireAuth);

// GET /api/settings — return current user's settings
router.get('/', async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.userId },
    select: { settings: true },
  });
  res.json({ settings: user?.settings || {} });
});

// PUT /api/settings — merge keys into current user's settings
router.put('/', async (req: Request, res: Response) => {
  const { settings } = req.body;
  if (!settings || typeof settings !== 'object') {
    res.status(400).json({ error: 'settings object is required' });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: req.user!.userId },
    select: { settings: true },
  });

  const current = (user?.settings as Record<string, any>) || {};
  const merged = { ...current, ...settings };

  // Remove keys set to null (explicit delete)
  for (const key of Object.keys(merged)) {
    if (merged[key] === null) delete merged[key];
  }

  await prisma.user.update({
    where: { id: req.user!.userId },
    data: { settings: merged },
  });

  res.json({ settings: merged });
});

// DELETE /api/settings/learning — reset Maria's memory
router.delete('/learning', async (req: Request, res: Response) => {
  await resetLearning(req.user!.userId);
  res.json({ success: true });
});

// DELETE /api/settings/personalize — reset personalization profile
router.delete('/personalize', async (req: Request, res: Response) => {
  await resetPersonalize(req.user!.userId);
  res.json({ success: true });
});

export default router;
