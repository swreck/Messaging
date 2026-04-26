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
  // Round C S3 — the settings router does not run requireWorkspace, so
  // req.workspaceId is usually undefined here. Resolve it explicitly from the
  // x-workspace-id header (if the user is a member) or the user's first
  // membership. Without this, the workspace block is null even when the user
  // has a workspace, hiding the org-default picker from admins/owners.
  const headerWorkspaceId = (req.headers['x-workspace-id'] as string | undefined) || null;
  let workspaceId: string | null = req.workspaceId || null;
  if (!workspaceId && headerWorkspaceId) {
    const member = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: headerWorkspaceId, userId } },
      select: { workspaceId: true },
    });
    if (member) workspaceId = member.workspaceId;
  }
  if (!workspaceId) {
    const fallback = await prisma.workspaceMember.findFirst({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: { workspaceId: true },
    });
    workspaceId = fallback?.workspaceId || null;
  }
  // Global admins can read any workspace's default style (admin-viewing-as-X).
  // For non-admins, only their own workspace memberships are surfaced — already
  // ensured above by the membership lookups.
  if (!workspaceId && req.user?.isAdmin && headerWorkspaceId) {
    workspaceId = headerWorkspaceId;
  }
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
  // Resolve workspaceId the same way the GET does (settings router doesn't
  // run requireWorkspace). Header → user's first membership.
  const headerWorkspaceId = (req.headers['x-workspace-id'] as string | undefined) || null;
  let workspaceId: string | null = req.workspaceId || headerWorkspaceId;
  if (!workspaceId) {
    const fallback = await prisma.workspaceMember.findFirst({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: { workspaceId: true },
    });
    workspaceId = fallback?.workspaceId || null;
  }
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

// ─── Round E2 — UserStyleRule CRUD ────────────────────
// Rules Maria detected from repeated edit patterns and the user explicitly
// approved. Settings UI lists, edits, and deletes them; the refine/copy-edit
// pipeline reads matching rules at generation time. Stale rules (no
// lastApplied in the past 30 days) are surfaced as a Settings prompt.
router.get('/style-rules', async (req: Request, res: Response) => {
  const rules = await prisma.userStyleRule.findMany({
    where: { userId: req.user!.userId },
    orderBy: { createdAt: 'desc' },
  });
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const stale = rules.filter(r => !r.lastApplied || r.lastApplied < thirtyDaysAgo);
  res.json({ rules, staleCount: stale.length });
});

router.post('/style-rules', async (req: Request, res: Response) => {
  const rule = typeof req.body?.rule === 'string' ? req.body.rule.trim() : '';
  if (!rule) { res.status(400).json({ error: 'rule is required' }); return; }
  const scopeAudienceType = typeof req.body?.scopeAudienceType === 'string' ? req.body.scopeAudienceType.trim() : '';
  const scopeFormat = typeof req.body?.scopeFormat === 'string' ? req.body.scopeFormat.trim() : '';
  const created = await prisma.userStyleRule.create({
    data: { userId: req.user!.userId, rule, scopeAudienceType, scopeFormat },
  });
  res.status(201).json({ rule: created });
});

router.patch('/style-rules/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id || '');
  if (!id) { res.status(400).json({ error: 'id required' }); return; }
  const existing = await prisma.userStyleRule.findUnique({ where: { id } });
  if (!existing || existing.userId !== req.user!.userId) {
    res.status(404).json({ error: 'Rule not found' });
    return;
  }
  const data: Record<string, any> = {};
  if (typeof req.body?.rule === 'string') data.rule = req.body.rule.trim();
  if (typeof req.body?.scopeAudienceType === 'string') data.scopeAudienceType = req.body.scopeAudienceType.trim();
  if (typeof req.body?.scopeFormat === 'string') data.scopeFormat = req.body.scopeFormat.trim();
  const updated = await prisma.userStyleRule.update({ where: { id }, data });
  res.json({ rule: updated });
});

router.delete('/style-rules/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id || '');
  if (!id) { res.status(400).json({ error: 'id required' }); return; }
  const existing = await prisma.userStyleRule.findUnique({ where: { id } });
  if (!existing || existing.userId !== req.user!.userId) {
    res.status(404).json({ error: 'Rule not found' });
    return;
  }
  await prisma.userStyleRule.delete({ where: { id } });
  res.json({ success: true });
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
