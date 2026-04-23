import { Router, Request, Response } from 'express';
import bcryptjs from 'bcryptjs';
import { prisma } from '../lib/prisma.js';
import { requireAuth, requireAdmin, signToken, AuthPayload } from '../middleware/auth.js';
import { param } from '../lib/params.js';

const router = Router();

// Pull displayName/firstName from user.settings so the client can greet by
// real name. Kept out of the JWT payload — this is presentation-only and
// can change without forcing re-login.
function presentationNames(settings: unknown): { displayName?: string; firstName?: string } {
  const s = (settings as Record<string, unknown> | null | undefined) || {};
  const displayName = typeof s.displayName === 'string' ? s.displayName : undefined;
  const firstName = typeof s.firstName === 'string' ? s.firstName : undefined;
  return { displayName, firstName };
}

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

  // Normalize username to lowercase (iPad/mobile keyboards capitalize first letter)
  const normalizedUsername = username.toLowerCase();

  // Check username uniqueness
  const existing = await prisma.user.findUnique({ where: { username: normalizedUsername } });
  if (existing) {
    res.status(400).json({ error: 'Username already taken' });
    return;
  }

  const passwordHash = await bcryptjs.hash(password, 10);

  // Display name: prefer the admin-supplied invitee name, fall back to the
  // capitalized username. This is what Maria greets with and what anchors
  // the workspace title — NOT the raw (possibly hyphenated) username.
  const displayName =
    (code.inviteeName && code.inviteeName.trim()) ||
    `${normalizedUsername.charAt(0).toUpperCase()}${normalizedUsername.slice(1)}`;
  const firstName = displayName.split(/\s+/)[0];

  const user = await prisma.user.create({
    data: {
      username: normalizedUsername,
      passwordHash,
      isAdmin: code.role === 'admin',
      // Seed both top-level (for general UI) and partner.displayName
      // (so Maria greets by the real first name, not the raw username).
      settings: {
        displayName,
        firstName,
        partner: { displayName: firstName },
      },
    },
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
        role: code.role || 'collaborator',
      },
    });
  } else {
    await prisma.workspace.create({
      data: {
        name: `${firstName}'s Workspace`,
        members: {
          create: { userId: user.id, role: 'owner' },
        },
      },
    });
  }

  const payload: AuthPayload = { userId: user.id, username: user.username, isAdmin: user.isAdmin };
  const token = signToken(payload);

  res.status(201).json({ token, user: { ...payload, displayName, firstName } });
});

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response) => {
  const { username, password } = req.body;

  if (!username || !password) {
    res.status(400).json({ error: 'Username and password are required' });
    return;
  }

  const user = await prisma.user.findUnique({ where: { username: username.toLowerCase() } });
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
  const names = presentationNames(user.settings);

  res.json({ token, user: { ...payload, ...names } });
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req: Request, res: Response) => {
  const u = req.user;
  if (!u) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  const record = await prisma.user.findUnique({
    where: { id: u.userId },
    select: { settings: true },
  });
  const names = presentationNames(record?.settings);
  res.json({ user: { ...u, ...names } });
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

// GET /api/auth/demo-count — public endpoint for login page hint
router.get('/demo-count', async (_req: Request, res: Response) => {
  const count = await prisma.user.count({
    where: { username: { startsWith: 'demo' } },
  });
  res.json({ count });
});

// ─── Demo account system ─────────────────────────────────
// Admin-only endpoints for creating, listing, renaming, and deleting
// demo accounts. Each demo is a user + workspace with a fixed password.

const DEMO_PASSWORD = 'Maria2026';
const DEMO_PREFIX = 'demo';

// GET /api/auth/demos — list all demo accounts with data counts
router.get('/demos', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
  const demoUsers = await prisma.user.findMany({
    where: { username: { startsWith: DEMO_PREFIX } },
    orderBy: { createdAt: 'desc' },
    include: {
      workspaces: {
        include: {
          workspace: {
            include: {
              _count: { select: { offerings: true, audiences: true } },
            },
          },
        },
      },
    },
  });

  const demos = demoUsers.map(u => {
    const ws = u.workspaces[0]?.workspace;
    return {
      userId: u.id,
      username: u.username,
      workspaceId: ws?.id || null,
      workspaceName: ws?.name || '(no workspace)',
      offeringCount: ws?._count?.offerings || 0,
      audienceCount: ws?._count?.audiences || 0,
      createdAt: u.createdAt,
    };
  });

  res.json({ demos, totalCreated: demoUsers.length });
});

// POST /api/auth/demos — create a new demo account
router.post('/demos', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
  // Find the next demo number
  const existing = await prisma.user.findMany({
    where: { username: { startsWith: DEMO_PREFIX } },
    select: { username: true },
  });
  const numbers = existing.map(u => {
    const n = parseInt(u.username.replace(DEMO_PREFIX, ''), 10);
    return isNaN(n) ? 0 : n;
  });
  const next = (numbers.length > 0 ? Math.max(...numbers) : 0) + 1;
  const username = `${DEMO_PREFIX}${next}`;

  const passwordHash = await bcryptjs.hash(DEMO_PASSWORD, 10);
  const user = await prisma.user.create({
    data: { username, passwordHash },
  });

  const workspace = await prisma.workspace.create({
    data: {
      name: `Demo ${next}`,
      members: { create: { userId: user.id, role: 'owner' } },
    },
  });

  res.status(201).json({
    username,
    password: DEMO_PASSWORD,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
  });
});

// PATCH /api/auth/demos/:userId — rename a demo account's workspace
router.patch('/demos/:userId', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const { name } = req.body as { name?: string };
  if (!name || !name.trim()) {
    res.status(400).json({ error: 'Name is required' });
    return;
  }

  const userId = param(req.params.userId);
  const membership = await prisma.workspaceMember.findFirst({
    where: { userId },
    include: { workspace: true },
  });
  if (!membership) {
    res.status(404).json({ error: 'Demo account not found' });
    return;
  }

  await prisma.workspace.update({
    where: { id: membership.workspaceId },
    data: { name: name.trim() },
  });

  res.json({ workspaceName: name.trim() });
});

// DELETE /api/auth/demos/:userId — delete a demo account + all data
router.delete('/demos/:userId', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const userId = param(req.params.userId);
  const user = await prisma.user.findFirst({
    where: { id: userId, username: { startsWith: DEMO_PREFIX } },
    include: { workspaces: true },
  });
  if (!user) {
    res.status(404).json({ error: 'Demo account not found' });
    return;
  }

  // Delete workspace data (cascade handles offerings, audiences, drafts, stories)
  for (const ws of user.workspaces) {
    await prisma.workspace.delete({ where: { id: ws.workspaceId } }).catch(() => {});
  }
  // Delete conversation history
  await prisma.assistantMessage.deleteMany({ where: { userId } });
  // Delete the user
  await prisma.user.delete({ where: { id: userId } });

  res.json({ deleted: true });
});

// ─── Simplified invites (name = URL) ─────────────────────
// Admin creates an invite by typing a name + email. The name becomes
// the URL path: /join/Brad. No hex codes.

router.post('/invite-simple', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const { name, email, workspaceId } = req.body as {
    name?: string;
    email?: string;
    workspaceId?: string;
  };
  if (!name || !name.trim()) {
    res.status(400).json({ error: 'Name is required' });
    return;
  }

  const cleanName = name.trim();
  const shortCode = cleanName.replace(/\s+/g, '');
  const crypto = await import('crypto');
  const fullCode = crypto.randomBytes(4).toString('hex').toUpperCase();

  // Only assign a workspace if explicitly provided. Otherwise the new user
  // gets their own clean workspace on registration — prevents naive users
  // from landing in the admin's workspace full of someone else's data.
  const targetWs = workspaceId || undefined;

  await prisma.inviteCode.create({
    data: {
      code: fullCode,
      shortCode,
      inviteeName: cleanName,
      inviteeEmail: email || '',
      role: 'editor',
      workspaceId: targetWs || undefined,
    },
  });

  const baseUrl = 'https://mariamessaging.up.railway.app';
  const joinUrl = `${baseUrl}/join/${shortCode}`;

  res.status(201).json({
    name: cleanName,
    joinUrl,
    shortCode,
    emailBody: `${cleanName} — I'd like you to try Maria, my messaging partner. Here's your link:\n\n${joinUrl}\n\nPick any username and password you like. See you in there.`,
  });
});

// ─── Usage monitoring ────────────────────────────────────
router.get('/usage', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
  const users = await prisma.user.findMany({
    where: { isAdmin: false },
    select: {
      id: true,
      username: true,
      createdAt: true,
      workspaces: {
        include: {
          workspace: {
            include: {
              _count: { select: { offerings: true, audiences: true } },
            },
          },
        },
      },
    },
  });

  const usage = await Promise.all(users.map(async u => {
    const msgCount = await prisma.assistantMessage.count({
      where: { userId: u.id, role: 'user' },
    });
    const lastMsg = await prisma.assistantMessage.findFirst({
      where: { userId: u.id },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    const lastDraft = await prisma.threeTierDraft.findFirst({
      where: { offering: { userId: u.id } },
      orderBy: { updatedAt: 'desc' },
      select: { updatedAt: true },
    });
    const lastStory = await prisma.fiveChapterStory.findFirst({
      where: { draft: { offering: { userId: u.id } } },
      orderBy: { updatedAt: 'desc' },
      select: { updatedAt: true },
    });
    const storyCount = await prisma.fiveChapterStory.count({
      where: {
        draft: {
          offering: {
            userId: u.id,
          },
        },
      },
    });
    const ws = u.workspaces[0]?.workspace;
    const activityDates = [
      lastMsg?.createdAt,
      lastDraft?.updatedAt,
      lastStory?.updatedAt,
      u.createdAt,
    ].filter(Boolean) as Date[];
    const latestActivity = new Date(Math.max(...activityDates.map(d => d.getTime())));
    return {
      username: u.username,
      createdAt: u.createdAt,
      lastActive: latestActivity,
      messageCount: msgCount,
      offeringCount: ws?._count?.offerings || 0,
      audienceCount: ws?._count?.audiences || 0,
      storyCount,
      isDemo: u.username.startsWith(DEMO_PREFIX),
    };
  }));

  usage.sort((a, b) => new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime());
  res.json({ usage });
});

export default router;
