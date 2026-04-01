import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace } from '../middleware/workspace.js';
import { callAIWithJSON } from '../services/ai.js';
import { buildPartnerPrompt } from '../prompts/partner.js';
import { ACTION_ALIASES, dispatchActions, readPageContent, type ActionContext } from '../lib/actions.js';

const router = Router();
router.use(requireAuth);
router.use(requireWorkspace);

// Channel marker to distinguish partner messages from the old page assistant
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
    lastVisitAt: settings.partner?.lastVisitAt as string | undefined,
  };
}

async function buildWorkSummary(workspaceId: string): Promise<string> {
  const [offerings, audiences, drafts] = await Promise.all([
    prisma.offering.findMany({
      where: { workspaceId },
      select: { name: true, description: true },
    }),
    prisma.audience.findMany({
      where: { workspaceId },
      include: {
        priorities: {
          select: { text: true, rank: true, motivatingFactor: true },
          orderBy: { sortOrder: 'asc' },
        },
      },
    }),
    prisma.threeTierDraft.findMany({
      where: { offering: { workspaceId } },
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

async function buildReturnGreeting(workspaceId: string, displayName: string): Promise<string | undefined> {
  const recentDraft = await prisma.threeTierDraft.findFirst({
    where: { offering: { workspaceId } },
    orderBy: { updatedAt: 'desc' },
    include: {
      offering: { select: { name: true } },
      audience: { select: { name: true } },
      stories: { select: { medium: true, stage: true } },
    },
  });

  const name = displayName || 'there';

  if (!recentDraft) {
    // User has no drafts — check if they have audiences/offerings started
    const [offeringCount, audienceCount] = await Promise.all([
      prisma.offering.count({ where: { workspaceId } }),
      prisma.audience.count({ where: { workspaceId } }),
    ]);
    if (offeringCount === 0 && audienceCount === 0) {
      return `Hey ${name} — good to have you back. Ready to get started on some messaging?`;
    }
    if (offeringCount > 0 && audienceCount > 0) {
      return `Hey ${name} — welcome back. You've got audiences and offerings set up but haven't started a Three Tier yet. Want to build one?`;
    }
    return undefined;
  }

  const offeringName = recentDraft.offering.name;
  const audienceName = recentDraft.audience.name;
  const step = recentDraft.currentStep;

  if (step < 5) {
    const stepDescs: Record<number, string> = {
      1: 'but hadn\'t started the coaching yet',
      2: `and we were talking about what makes ${offeringName} special`,
      3: `and we were exploring what ${audienceName} cares about most`,
      4: 'and the message was being built',
    };
    return `Hey ${name} — been a bit. You were working on your Three Tier for ${offeringName} → ${audienceName}${stepDescs[step] ? `, ${stepDescs[step]}` : ''}. Want to pick that back up?`;
  }

  // Step 5 — completed Three Tier
  const unblendedStory = recentDraft.stories.find(s => s.stage === 'chapters');
  const hasStories = recentDraft.stories.length > 0;

  if (unblendedStory) {
    return `Hey ${name} — you left off with a ${unblendedStory.medium} story for ${offeringName} → ${audienceName}. The chapters are written but haven't been blended into a final draft yet. Want to finish that?`;
  }

  if (!hasStories) {
    return `Welcome back, ${name}. Your Three Tier for ${offeringName} → ${audienceName} is looking good. Ready to turn it into something — an email, a pitch deck, a blog post?`;
  }

  return `Hey ${name} — good to see you. Your ${offeringName} work is in good shape. Anything you want to revisit or something new?`;
}

async function buildSurfacingHint(workspaceId: string): Promise<string | undefined> {
  const drafts = await prisma.threeTierDraft.findMany({
    where: { offering: { workspaceId } },
    include: {
      offering: { select: { name: true } },
      audience: { select: { name: true } },
      stories: { select: { stage: true, medium: true } },
    },
  });

  for (const d of drafts) {
    for (const s of d.stories) {
      if (s.stage === 'chapters') {
        return `The ${s.medium} story for "${d.offering.name} → ${d.audience.name}" has chapters generated but hasn't been joined or blended yet. The user may have intentionally stopped there, or may have meant to continue.`;
      }
    }
  }

  const emptyAudiences = await prisma.audience.findMany({
    where: { workspaceId, priorities: { none: {} } },
    select: { name: true },
  });
  if (emptyAudiences.length > 0) {
    return `The audience "${emptyAudiences[0].name}" is defined but has no priorities yet. The user may not have gotten to it.`;
  }

  return undefined;
}

// ─── Routes ──────────────────────────────────────────────

// GET /api/partner/status — check intro state + load display name + return greeting if away >24h
router.get('/status', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { username, displayName, introduced, lastVisitAt } = await getPartnerSettings(userId);

  let hasNewMessage = false;

  // If user has been introduced and was away >24h, generate a return greeting
  if (introduced && lastVisitAt) {
    const gap = Date.now() - new Date(lastVisitAt).getTime();
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

    if (gap > TWENTY_FOUR_HOURS) {
      try {
        const greeting = await buildReturnGreeting(req.workspaceId!, displayName || username);
        if (greeting) {
          await prisma.assistantMessage.create({
            data: { userId, role: 'assistant', content: greeting, context: PARTNER_CHANNEL },
          });
          hasNewMessage = true;
        }
      } catch {
        // Non-critical — don't block status on greeting failure
      }
    }
  }

  // Update lastVisitAt
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { settings: true },
    });
    const current = (user?.settings as Record<string, any>) || {};
    await prisma.user.update({
      where: { id: userId },
      data: {
        settings: {
          ...current,
          partner: { ...current.partner, lastVisitAt: new Date().toISOString() },
        },
      },
    });
  } catch {
    // Non-critical
  }

  res.json({ username, displayName, introduced, hasNewMessage });
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
        partner: {
          ...current.partner,
          displayName,
          introduced: true,
          lastVisitAt: new Date().toISOString(),
        },
      },
    },
  });

  // For new users (no content yet), store a proactive first message from Maria
  try {
    const [offeringCount, audienceCount] = await Promise.all([
      prisma.offering.count({ where: { workspaceId: req.workspaceId } }),
      prisma.audience.count({ where: { workspaceId: req.workspaceId } }),
    ]);
    if (offeringCount === 0 && audienceCount === 0) {
      await prisma.assistantMessage.create({
        data: {
          userId: req.user!.userId,
          role: 'assistant',
          content: `So ${displayName} — what are you working on? Tell me about the product or service you want to build messaging for, and who needs to hear about it.`,
          context: PARTNER_CHANNEL,
        },
      });
    }
  } catch {
    // Non-critical
  }

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
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  messages.reverse();
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
  const ctx: ActionContext = context || {};

  // Load conversation history (last 40 messages)
  const history = await prisma.assistantMessage.findMany({
    where: {
      userId,
      context: { path: ['channel'], equals: 'partner' },
    },
    select: { role: true, content: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 40,
  });
  history.reverse();

  // Get user's display name
  const { displayName } = await getPartnerSettings(userId);

  // Build work summary and context
  const workspaceId = req.workspaceId!;
  const [workSummary, surfacingHint, offeringCount, audienceCount] = await Promise.all([
    buildWorkSummary(workspaceId),
    history.length === 0 ? buildSurfacingHint(workspaceId) : Promise.resolve(undefined),
    prisma.offering.count({ where: { workspaceId } }),
    prisma.audience.count({ where: { workspaceId } }),
  ]);

  const currentContext = buildCurrentContext(ctx);
  const isNewUser = offeringCount === 0 && audienceCount === 0;

  const systemPrompt = buildPartnerPrompt({
    displayName,
    workSummary,
    currentContext,
    pageContext: ctx,
    isFirstMessage: history.length === 0,
    surfacingHint: history.length === 0 ? surfacingHint : undefined,
    isNewUser,
  });

  // Build conversation history for the AI
  const conversationHistory = history.map(m => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));

  // Call Opus with JSON response format
  const result = await callAIWithJSON<{
    response: string;
    action?: { type: string; params: Record<string, any> } | null;
    actions?: { type: string; params: Record<string, any> }[];
  }>(systemPrompt, message, 'elite', conversationHistory);

  // Normalize actions
  let rawActions: { type: string; params: Record<string, any> }[] = [];
  if (result.actions && Array.isArray(result.actions) && result.actions.length > 0) {
    rawActions = result.actions;
  } else if (result.action && result.action.type) {
    rawActions = [result.action];
  }

  // Check if Maria wants to read the page
  const normalizedActions = rawActions.map(a => ({
    ...a,
    type: ACTION_ALIASES[a.type] || a.type,
  }));

  if (normalizedActions.length === 1 && normalizedActions[0].type === 'read_page') {
    // Store the user message but not the response yet (will retry with page content)
    await prisma.assistantMessage.create({
      data: { userId, role: 'user', content: message, context: PARTNER_CHANNEL },
    });

    res.json({
      response: result.response,
      actionResult: null,
      refreshNeeded: false,
      needsPageContent: true,
    });
    return;
  }

  // Dispatch any actions
  let actionResult: string | null = null;
  let refreshNeeded = false;

  if (normalizedActions.length > 0) {
    const dispatch = await dispatchActions(normalizedActions, userId, ctx, workspaceId);
    refreshNeeded = dispatch.refreshNeeded;

    // Check for failures
    const failedResults = dispatch.results.filter(r =>
      r.startsWith('Could not') || r.startsWith('Action failed') || r.includes('not recognized')
    );

    actionResult = dispatch.results.length > 0 ? dispatch.results.join(' · ') : null;

    // If actions failed, override Maria's optimistic response
    if (failedResults.length > 0) {
      result.response = `I tried, but it didn't work: ${failedResults.join('. ')}`;
    }
  }

  // Store both messages — serialize response with action result for history
  const storedResponse = actionResult
    ? `${result.response}\n\n[${actionResult}]`
    : result.response;

  await prisma.assistantMessage.createMany({
    data: [
      { userId, role: 'user', content: message, context: PARTNER_CHANNEL },
      { userId, role: 'assistant', content: storedResponse, context: PARTNER_CHANNEL },
    ],
  });

  res.json({
    response: result.response,
    actionResult,
    refreshNeeded,
    needsPageContent: false,
  });
});

// POST /api/partner/page-content — fetch page content for Maria to read
router.post('/page-content', async (req: Request, res: Response) => {
  const { context } = req.body;
  const userId = req.user!.userId;
  const content = await readPageContent(req.workspaceId!, context || {});
  res.json({ content });
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
