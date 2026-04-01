import { Router, Request, Response } from 'express';
import bcryptjs from 'bcryptjs';
import { prisma } from '../lib/prisma.js';
import { requireAuth, requireAdmin, signToken, AuthPayload } from '../middleware/auth.js';
import { param } from '../lib/params.js';

const router = Router();

// GET /api/auth/invite/:code — look up an invite by shortCode or full code
router.get('/invite/:code', async (req: Request, res: Response) => {
  const lookupCode = param(req.params.code);

  // Try shortCode first, then full code
  let invite = await prisma.inviteCode.findFirst({
    where: {
      OR: [
        { shortCode: lookupCode },
        { code: lookupCode },
      ],
    },
    include: { workspace: { select: { name: true } } },
  });

  if (!invite || invite.usedById) {
    res.json({ valid: false });
    return;
  }

  res.json({
    valid: true,
    inviteeName: invite.inviteeName,
    workspaceName: invite.workspace?.name || null,
    role: invite.role,
  });
});

// POST /api/auth/register
router.post('/register', async (req: Request, res: Response) => {
  const { inviteCode, username, password } = req.body;

  if (!inviteCode || !username || !password) {
    res.status(400).json({ error: 'Invite code, username, and password are required' });
    return;
  }

  if (password.length < 4) {
    res.status(400).json({ error: 'Password must be at least 4 characters' });
    return;
  }

  // Validate invite code — try shortCode first, then full code
  let code = await prisma.inviteCode.findUnique({ where: { shortCode: inviteCode } });
  if (!code) {
    code = await prisma.inviteCode.findUnique({ where: { code: inviteCode } });
  }
  if (!code) {
    res.status(400).json({ error: 'Invalid invite code' });
    return;
  }
  if (code.usedById) {
    res.status(400).json({ error: 'Invite code already used' });
    return;
  }

  // Check username uniqueness
  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    res.status(400).json({ error: 'Username already taken' });
    return;
  }

  const passwordHash = await bcryptjs.hash(password, 10);

  const user = await prisma.user.create({
    data: { username, passwordHash, isAdmin: code.role === 'admin' },
  });

  // Mark invite code as used
  await prisma.inviteCode.update({
    where: { id: code.id },
    data: { usedById: user.id },
  });

  // If the invite code is linked to a workspace, add the user as a member
  // Otherwise, create a default workspace for them
  if (code.workspaceId) {
    await prisma.workspaceMember.create({
      data: {
        workspaceId: code.workspaceId,
        userId: user.id,
        role: code.role === 'admin' ? 'owner' : (code.role || 'editor'),
      },
    });
  } else {
    await prisma.workspace.create({
      data: {
        name: `${username}'s Workspace`,
        members: {
          create: { userId: user.id, role: 'owner' },
        },
      },
    });
  }

  const payload: AuthPayload = { userId: user.id, username: user.username, isAdmin: user.isAdmin };
  const token = signToken(payload);

  res.status(201).json({ token, user: payload });
});

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response) => {
  const { username, password } = req.body;

  if (!username || !password) {
    res.status(400).json({ error: 'Username and password are required' });
    return;
  }

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const valid = await bcryptjs.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const payload: AuthPayload = { userId: user.id, username: user.username, isAdmin: user.isAdmin };
  const token = signToken(payload);

  res.json({ token, user: payload });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req: Request, res: Response) => {
  res.json({ user: req.user });
});

// POST /api/auth/invite-codes (admin only)
router.post('/invite-codes', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const { count = 5 } = req.body;
  const crypto = await import('crypto');
  const codes: string[] = [];

  for (let i = 0; i < count; i++) {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    await prisma.inviteCode.create({ data: { code } });
    codes.push(code);
  }

  res.status(201).json({ codes });
});

// GET /api/auth/invite-codes (admin only)
router.get('/invite-codes', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
  const codes = await prisma.inviteCode.findMany({
    orderBy: { createdAt: 'desc' },
    include: { usedBy: { select: { username: true } } },
  });
  res.json({ codes });
});

export default router;
