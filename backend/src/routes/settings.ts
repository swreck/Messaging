import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { resetLearning } from '../lib/learning.js';
import { resetPersonalize } from '../lib/personalize.js';
import { validateStyleInput, resolveStyleForUser } from '../lib/styleResolver.js';

const router = Router();
router.use(requireAuth);

// ─── Round C2 — Default style (per-user + org-level) ──────────
// Empty string = unset (falls through to org default, then SYSTEM_DEFAULT).
// Values: "" | "TABLE_FOR_2" | "ENGINEERING_TABLE" | "PERSONALIZED"

router.get('/style', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const workspaceId = req.workspaceId || null;
  const [user, workspace] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { defaultStyle: true } }),
    workspaceId ? prisma.workspace.findUnique({ where: { id: workspaceId }, select: { defaultStyle: true, name: true } }) : Promise.resolve(null),
  ]);
  const effective = await resolveStyleForUser(userId, workspaceId);
  res.json({
    user: { defaultStyle: user?.defaultStyle || '' },
    workspace: workspace ? { id: workspaceId, name: workspace.name, defaultStyle: workspace.defaultStyle || '' } : null,
    effective,
  });
});

router.put('/style', async (req: Request, res: Response) => {
  const v = validateStyleInput(req.body?.defaultStyle);
  if (!v.ok) { res.status(400).json({ error: v.error }); return; }
  await prisma.user.update({
    where: { id: req.user!.userId },
    data: { defaultStyle: v.value },
  });
  const effective = await resolveStyleForUser(req.user!.userId, req.workspaceId || null);
  res.json({ defaultStyle: v.value, effective });
});

// Org-level default. Admin-only — only an admin user OR the workspace's owner
// member can set this. For v1 we allow either a global admin (User.isAdmin)
// or a workspace member with role === 'owner' to update.
router.put('/workspace-style', async (req: Request, res: Response) => {
  const v = validateStyleInput(req.body?.defaultStyle);
  if (!v.ok) { res.status(400).json({ error: v.error }); return; }
  const userId = req.user!.userId;
  const workspaceId = req.workspaceId;
  if (!workspaceId) { res.status(400).json({ error: 'No workspace in scope' }); return; }
  const isAdmin = !!req.user?.isAdmin;
  if (!isAdmin) {
    const member = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    });
    if (!member || member.role !== 'owner') {
      res.status(403).json({ error: 'Only the workspace owner can set the org default style' });
      return;
    }
  }
  await prisma.workspace.update({
    where: { id: workspaceId },
    data: { defaultStyle: v.value },
  });
  res.json({ defaultStyle: v.value });
});

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
