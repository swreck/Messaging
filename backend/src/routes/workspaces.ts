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

// POST /api/workspaces/invite-standalone — invite someone who gets their own workspace
router.post('/invite-standalone', async (req: Request, res: Response) => {
  const { name, email } = req.body;
  if (!name || !name.trim()) {
    res.status(400).json({ error: 'Name is required' });
    return;
  }

  const crypto = await import('crypto');
  const fullCode = crypto.randomBytes(4).toString('hex').toUpperCase();
  const shortCode = generateShortCode(name);

  await prisma.inviteCode.create({
    data: {
      code: fullCode,
      shortCode,
      inviteeName: name.trim(),
      inviteeEmail: (email || '').trim(),
      role: 'owner', // they own their own workspace
    },
  });

  res.status(201).json({
    code: shortCode,
    link: `/join/${shortCode}`,
    inviteeName: name.trim(),
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

// Helper: generate a short human-readable invite code from a name
function generateShortCode(name: string): string {
  const prefix = name.trim().split(/\s+/)[0].toUpperCase().slice(0, 8);
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 for clarity
  let suffix = '';
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  for (let i = 0; i < 4; i++) {
    suffix += chars[bytes[i] % chars.length];
  }
  return `${prefix}-${suffix}`;
}

// POST /api/workspaces/:id/invite — invite someone to this workspace (owner only)
router.post('/:id/invite', async (req: Request, res: Response) => {
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: param(req.params.id), userId: req.user!.userId } },
  });
  if (!membership || membership.role !== 'owner') {
    res.status(403).json({ error: 'Only the workspace owner can invite members' });
    return;
  }

  // Mode 1: Add existing user by username (secondary flow)
  if (req.body.username) {
    const { username, role } = req.body;
    const targetUser = await prisma.user.findUnique({ where: { username } });
    if (!targetUser) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

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
    return;
  }

  // Mode 2: Generate a named invite code (primary flow)
  const { name, email, role } = req.body;
  if (!name || !name.trim()) {
    res.status(400).json({ error: 'Name is required' });
    return;
  }

  const crypto = await import('crypto');
  const fullCode = crypto.randomBytes(4).toString('hex').toUpperCase();
  const shortCode = generateShortCode(name);

  await prisma.inviteCode.create({
    data: {
      code: fullCode,
      shortCode,
      workspaceId: param(req.params.id),
      inviteeName: name.trim(),
      inviteeEmail: (email || '').trim(),
      role: role || 'editor',
    },
  });

  res.status(201).json({
    code: shortCode,
    link: `/join/${shortCode}`,
    inviteeName: name.trim(),
  });
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

  res.json({ codes: codes.map(c => ({
    id: c.id,
    code: c.shortCode || c.code,
    inviteeName: c.inviteeName,
    inviteeEmail: c.inviteeEmail,
    role: c.role,
    createdAt: c.createdAt.toISOString(),
  })) });
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

// POST /api/workspaces/:id/copy-audience — copy an audience + priorities to this workspace
router.post('/:id/copy-audience', async (req: Request, res: Response) => {
  const targetWorkspaceId = param(req.params.id);
  const { audienceId, sourceWorkspaceId } = req.body;
  if (!audienceId || !sourceWorkspaceId) {
    res.status(400).json({ error: 'audienceId and sourceWorkspaceId are required' });
    return;
  }

  // Verify user is a member of BOTH workspaces
  const [sourceMembership, targetMembership] = await Promise.all([
    prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: sourceWorkspaceId, userId: req.user!.userId } },
    }),
    prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: targetWorkspaceId, userId: req.user!.userId } },
    }),
  ]);
  if (!sourceMembership || !targetMembership) {
    res.status(403).json({ error: 'You must be a member of both workspaces' });
    return;
  }

  // Load the source audience with priorities
  const source = await prisma.audience.findFirst({
    where: { id: audienceId, workspaceId: sourceWorkspaceId },
    include: { priorities: { orderBy: { sortOrder: 'asc' } } },
  });
  if (!source) {
    res.status(404).json({ error: 'Audience not found in source workspace' });
    return;
  }

  // Create the copy
  const newAudience = await prisma.audience.create({
    data: {
      userId: req.user!.userId,
      workspaceId: targetWorkspaceId,
      name: source.name,
      description: source.description,
      priorities: {
        create: source.priorities.map(p => ({
          text: p.text,
          rank: p.rank,
          isSpoken: p.isSpoken,
          motivatingFactor: p.motivatingFactor,
          whatAudienceThinks: p.whatAudienceThinks,
          sortOrder: p.sortOrder,
        })),
      },
    },
    include: { priorities: true },
  });

  res.status(201).json({ audience: newAudience });
});

// POST /api/workspaces/:id/copy-offering — copy an offering + elements to this workspace
router.post('/:id/copy-offering', async (req: Request, res: Response) => {
  const targetWorkspaceId = param(req.params.id);
  const { offeringId, sourceWorkspaceId } = req.body;
  if (!offeringId || !sourceWorkspaceId) {
    res.status(400).json({ error: 'offeringId and sourceWorkspaceId are required' });
    return;
  }

  // Verify user is a member of BOTH workspaces
  const [sourceMembership, targetMembership] = await Promise.all([
    prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: sourceWorkspaceId, userId: req.user!.userId } },
    }),
    prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: targetWorkspaceId, userId: req.user!.userId } },
    }),
  ]);
  if (!sourceMembership || !targetMembership) {
    res.status(403).json({ error: 'You must be a member of both workspaces' });
    return;
  }

  // Load the source offering with elements
  const source = await prisma.offering.findFirst({
    where: { id: offeringId, workspaceId: sourceWorkspaceId },
    include: { elements: { orderBy: { sortOrder: 'asc' } } },
  });
  if (!source) {
    res.status(404).json({ error: 'Offering not found in source workspace' });
    return;
  }

  // Create the copy
  const newOffering = await prisma.offering.create({
    data: {
      userId: req.user!.userId,
      workspaceId: targetWorkspaceId,
      name: source.name,
      smeRole: source.smeRole,
      description: source.description,
      elements: {
        create: source.elements.map(e => ({
          text: e.text,
          source: e.source,
          sortOrder: e.sortOrder,
        })),
      },
    },
    include: { elements: true },
  });

  res.status(201).json({ offering: newOffering });
});

export default router;
