import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { callAI } from '../services/ai.js';
import { buildPartnerPrompt, buildIntroMessage } from '../prompts/partner.js';

const router = Router();
router.use(requireAuth);

// Channel marker to distinguish partner messages from the page assistant
const PARTNER_CHANNEL = { channel: 'partner' };

// ─── Helpers ─────────────────────────────────────────────

async function getPartnerSettings(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { username: true, settings: true },
  });
  const settings = (user?.settings as Record<string, any>) || {};
  return {
    username: user?.username || '',
    displayName: settings.partner?.displayName as string | undefined,
    introduced: !!settings.partner?.introduced,
  };
}

async function buildWorkSummary(userId: string): Promise<string> {
  const [offerings, audiences, drafts] = await Promise.all([
    prisma.offering.findMany({
      where: { userId },
      select: { name: true, description: true },
    }),
    prisma.audience.findMany({
      where: { userId },
      include: {
        priorities: {
          select: { text: true, rank: true, motivatingFactor: true },
          orderBy: { sortOrder: 'asc' },
        },
      },
    }),
    prisma.threeTierDraft.findMany({
      where: { offering: { userId } },
      include: {
        offering: { select: { name: true } },
        audience: { select: { name: true } },
        tier1Statement: { select: { text: true } },
        tier2Statements: {
          select: { text: true, categoryLabel: true },
          orderBy: { sortOrder: 'asc' },
        },
        stories: {
          select: { medium: true, stage: true, updatedAt: true },
        },
      },
    }),
  ]);

  if (offerings.length === 0) {
    return 'The user hasn\'t created any offerings yet. They\'re just getting started.';
  }

  const lines: string[] = [];

  lines.push('OFFERINGS:');
  for (const o of offerings) {
    lines.push(`- "${o.name}"${o.description ? `: ${o.description}` : ''}`);
  }

  lines.push('\nAUDIENCES:');
  for (const a of audiences) {
    const prioSummary = a.priorities.length > 0
      ? a.priorities.map((p, i) => {
          const mf = p.motivatingFactor ? ' (has motivating factor)' : '';
          return `  ${i + 1}. ${p.text}${mf}`;
        }).join('\n')
      : '  (no priorities defined yet)';
    lines.push(`- "${a.name}"${a.description ? ` — ${a.description}` : ''}`);
    lines.push(prioSummary);
  }

  if (drafts.length > 0) {
    lines.push('\nTHREE TIER DRAFTS:');
    for (const d of drafts) {
      const stepLabel = d.currentStep >= 5 ? 'complete' : `step ${d.currentStep}/5`;
      lines.push(`- ${d.offering.name} → ${d.audience.name} (${stepLabel})`);
      if (d.tier1Statement) {
        lines.push(`  Tier 1: "${d.tier1Statement.text}"`);
      }
      if (d.tier2Statements.length > 0) {
        lines.push(`  Tier 2 columns: ${d.tier2Statements.map(s => s.categoryLabel || 'unlabeled').join(', ')}`);
      }
      if (d.stories.length > 0) {
        for (const s of d.stories) {
          lines.push(`  Story: ${s.medium} (${s.stage} stage)`);
        }
      }
    }
  }

  return lines.join('\n');
}

function buildCurrentContext(context: Record<string, any>): string {
  if (!context?.page) return 'Unknown page';
  const parts = [`Page: ${context.page}`];
  if (context.draftId) parts.push('Viewing a Three Tier draft');
  if (context.storyId) parts.push('Viewing a Five Chapter Story');
  if (context.audienceId) parts.push('An audience is selected');
  if (context.offeringId) parts.push('An offering is selected');
  return parts.join('. ');
}

async function buildSurfacingHint(userId: string): Promise<string | undefined> {
  // Look for things worth gently mentioning
  const drafts = await prisma.threeTierDraft.findMany({
    where: { offering: { userId } },
    include: {
      offering: { select: { name: true } },
      audience: { select: { name: true } },
      stories: { select: { stage: true, medium: true } },
    },
  });

  // Stories at chapters stage (never joined/blended)
  for (const d of drafts) {
    for (const s of d.stories) {
      if (s.stage === 'chapters') {
        return `The ${s.medium} story for "${d.offering.name} → ${d.audience.name}" has chapters generated but hasn't been joined or blended yet. The user may have intentionally stopped there, or may have meant to continue.`;
      }
    }
  }

  // Audiences with no priorities
  const emptyAudiences = await prisma.audience.findMany({
    where: { userId, priorities: { none: {} } },
    select: { name: true },
  });
  if (emptyAudiences.length > 0) {
    return `The audience "${emptyAudiences[0].name}" is defined but has no priorities yet. The user may not have gotten to it.`;
  }

  return undefined;
}

// ─── Routes ──────────────────────────────────────────────

// GET /api/partner/status — check intro state + load display name
router.get('/status', async (req: Request, res: Response) => {
  const { username, displayName, introduced } = await getPartnerSettings(req.user!.userId);
  res.json({ username, displayName, introduced });
});

// PUT /api/partner/name — store display name and mark as introduced
router.put('/name', async (req: Request, res: Response) => {
  const { displayName } = req.body;
  if (!displayName || typeof displayName !== 'string') {
    res.status(400).json({ error: 'displayName is required' });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: req.user!.userId },
    select: { settings: true },
  });
  const current = (user?.settings as Record<string, any>) || {};

  await prisma.user.update({
    where: { id: req.user!.userId },
    data: {
      settings: {
        ...current,
        partner: { ...current.partner, displayName, introduced: true },
      },
    },
  });

  res.json({ success: true, displayName });
});

// GET /api/partner/history — load persistent conversation
router.get('/history', async (req: Request, res: Response) => {
  const messages = await prisma.assistantMessage.findMany({
    where: {
      userId: req.user!.userId,
      context: { path: ['channel'], equals: 'partner' },
    },
    select: { role: true, content: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ messages });
});

// POST /api/partner/message — send a message and get Maria's response
router.post('/message', async (req: Request, res: Response) => {
  const { message, context } = req.body;
  if (!message) {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  const userId = req.user!.userId;

  // Load conversation history (last 40 messages)
  const history = await prisma.assistantMessage.findMany({
    where: {
      userId,
      context: { path: ['channel'], equals: 'partner' },
    },
    select: { role: true, content: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
    take: 40,
  });

  // Get user's display name
  const { displayName } = await getPartnerSettings(userId);

  // Build work summary and context
  const [workSummary, surfacingHint] = await Promise.all([
    buildWorkSummary(userId),
    history.length === 0 ? buildSurfacingHint(userId) : Promise.resolve(undefined),
  ]);

  const currentContext = buildCurrentContext(context || {});

  const systemPrompt = buildPartnerPrompt({
    displayName,
    workSummary,
    currentContext,
    isFirstMessage: history.length === 0,
    surfacingHint: history.length === 0 ? surfacingHint : undefined,
  });

  // Build conversation history for the AI
  const conversationHistory = history.map(m => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));

  // Call Opus
  const response = await callAI(systemPrompt, message, 'elite', conversationHistory);

  // Store both messages
  await prisma.assistantMessage.createMany({
    data: [
      { userId, role: 'user', content: message, context: PARTNER_CHANNEL },
      { userId, role: 'assistant', content: response, context: PARTNER_CHANNEL },
    ],
  });

  res.json({ response });
});

// DELETE /api/partner/history — clear partner conversation only
router.delete('/history', async (req: Request, res: Response) => {
  await prisma.assistantMessage.deleteMany({
    where: {
      userId: req.user!.userId,
      context: { path: ['channel'], equals: 'partner' },
    },
  });
  res.json({ success: true });
});

export default router;
