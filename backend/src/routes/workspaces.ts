import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { param } from '../lib/params.js';

const router = Router();
router.use(requireAuth);

// GET /api/workspaces — list user's workspaces
router.get('/', async (req: Request, res: Response) => {
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId: req.user!.userId },
    include: {
      workspace: {
        include: {
          _count: {
            select: { members: true, offerings: true },
          },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  const workspaces = memberships.map(m => ({
    id: m.workspace.id,
    name: m.workspace.name,
    role: m.role,
    memberCount: m.workspace._count.members,
    offeringCount: m.workspace._count.offerings,
    createdAt: m.workspace.createdAt.toISOString(),
  }));

  res.json({ workspaces });
});

// GET /api/workspaces/all — list ALL workspaces (admin only)
router.get('/all', requireAdmin, async (_req: Request, res: Response) => {
  const allWorkspaces = await prisma.workspace.findMany({
    include: {
      _count: { select: { members: true, offerings: true } },
      members: {
        include: { user: { select: { id: true, username: true } } },
        orderBy: { createdAt: 'asc' },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  const workspaces = allWorkspaces.map(ws => ({
    id: ws.id,
    name: ws.name,
    role: 'admin' as const,
    memberCount: ws._count.members,
    offeringCount: ws._count.offerings,
    createdAt: ws.createdAt.toISOString(),
  }));

  res.json({ workspaces });
});

// POST /api/workspaces — create a new workspace
router.post('/', async (req: Request, res: Response) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    res.status(400).json({ error: 'Name is required' });
    return;
  }

  const workspace = await prisma.workspace.create({
    data: {
      name,
      members: {
        create: {
          userId: req.user!.userId,
          role: 'owner',
        },
      },
    },
    include: {
      _count: { select: { members: true, offerings: true } },
    },
  });

  res.status(201).json({
    workspace: {
      id: workspace.id,
      name: workspace.name,
      role: 'owner',
      memberCount: workspace._count.members,
      offeringCount: workspace._count.offerings,
      createdAt: workspace.createdAt.toISOString(),
    },
  });
});

// PUT /api/workspaces/:id — rename workspace (owner only)
router.put('/:id', async (req: Request, res: Response) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    res.status(400).json({ error: 'Name is required' });
    return;
  }

  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: param(req.params.id), userId: req.user!.userId } },
  });
  if (!membership || membership.role !== 'owner') {
    res.status(403).json({ error: 'Only the workspace owner can rename it' });
    return;
  }

  const updated = await prisma.workspace.update({
    where: { id: param(req.params.id) },
    data: { name },
  });

  res.json({ workspace: { id: updated.id, name: updated.name } });
});

// DELETE /api/workspaces/:id — delete workspace (owner only, with cascade)
router.delete('/:id', async (req: Request, res: Response) => {
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: param(req.params.id), userId: req.user!.userId } },
  });
  if (!membership || membership.role !== 'owner') {
    res.status(403).json({ error: 'Only the workspace owner can delete it' });
    return;
  }

  await prisma.workspace.delete({ where: { id: param(req.params.id) } });
  res.json({ success: true });
});

// POST /api/workspaces/:id/invite — invite a user by username or generate invite code (owner only)
router.post('/:id/invite', async (req: Request, res: Response) => {
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: param(req.params.id), userId: req.user!.userId } },
  });
  if (!membership || membership.role !== 'owner') {
    res.status(403).json({ error: 'Only the workspace owner can invite members' });
    return;
  }

  // Mode 1: Generate an invite code linked to this workspace
  if (req.body.generateCode) {
    const crypto = await import('crypto');
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    await prisma.inviteCode.create({
      data: { code, workspaceId: param(req.params.id) },
    });
    res.status(201).json({ code });
    return;
  }

  // Mode 2: Add existing user by username
  const { username, role } = req.body;
  if (!username) {
    res.status(400).json({ error: 'username is required' });
    return;
  }

  const targetUser = await prisma.user.findUnique({ where: { username } });
  if (!targetUser) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  // Check if already a member
  const existing = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: param(req.params.id), userId: targetUser.id } },
  });
  if (existing) {
    res.status(409).json({ error: 'User is already a member of this workspace' });
    return;
  }

  const member = await prisma.workspaceMember.create({
    data: {
      workspaceId: param(req.params.id),
      userId: targetUser.id,
      role: role || 'editor',
    },
  });

  res.status(201).json({ member: { id: member.id, userId: targetUser.id, username, role: member.role } });
});

// GET /api/workspaces/:id/invite-codes — list active (unused) invite codes for a workspace
router.get('/:id/invite-codes', async (req: Request, res: Response) => {
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: param(req.params.id), userId: req.user!.userId } },
  });
  if (!membership || membership.role !== 'owner') {
    res.status(403).json({ error: 'Only the workspace owner can view invite codes' });
    return;
  }

  const codes = await prisma.inviteCode.findMany({
    where: {
      workspaceId: param(req.params.id),
      usedById: null,
    },
    orderBy: { createdAt: 'desc' },
  });

  res.json({ codes: codes.map(c => ({ id: c.id, code: c.code, createdAt: c.createdAt.toISOString() })) });
});

// DELETE /api/workspaces/:id/members/:userId — remove a member (owner only)
router.delete('/:id/members/:userId', async (req: Request, res: Response) => {
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: param(req.params.id), userId: req.user!.userId } },
  });
  if (!membership || membership.role !== 'owner') {
    res.status(403).json({ error: 'Only the workspace owner can remove members' });
    return;
  }

  // Can't remove yourself as owner
  if (param(req.params.userId) === req.user!.userId) {
    res.status(400).json({ error: 'Cannot remove yourself as the owner' });
    return;
  }

  const targetMembership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: param(req.params.id), userId: param(req.params.userId) } },
  });
  if (!targetMembership) {
    res.status(404).json({ error: 'Member not found' });
    return;
  }

  await prisma.workspaceMember.delete({ where: { id: targetMembership.id } });
  res.json({ success: true });
});

// GET /api/workspaces/:id/members — list workspace members
router.get('/:id/members', async (req: Request, res: Response) => {
  // Verify requesting user is a member
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: param(req.params.id), userId: req.user!.userId } },
  });
  if (!membership) {
    res.status(403).json({ error: 'Not a member of this workspace' });
    return;
  }

  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId: param(req.params.id) },
    include: { user: { select: { id: true, username: true } } },
    orderBy: { createdAt: 'asc' },
  });

  res.json({
    members: members.map(m => ({
      id: m.id,
      userId: m.user.id,
      username: m.user.username,
      role: m.role,
      createdAt: m.createdAt.toISOString(),
    })),
  });
});

export default router;
