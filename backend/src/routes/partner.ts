import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace } from '../middleware/workspace.js';
import { callAIWithJSON } from '../services/ai.js';
import { buildPartnerPrompt } from '../prompts/partner.js';
import { ACTION_ALIASES, dispatchActions, readPageContent, type ActionContext } from '../lib/actions.js';
import { getPersonalize, updatePersonalize, buildPersonalizeChatBlock } from '../lib/personalize.js';

const router = Router();
router.use(requireAuth);
router.use(requireWorkspace);

// Channel marker — now includes workspaceId for conversation partitioning
function partnerChannel(workspaceId: string) {
  return { channel: 'partner', workspaceId };
}

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
    introStep: (settings.partner?.introStep as number) ?? 0,
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
          select: { text: true, rank: true, driver: true },
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
          const hasDriver = p.driver ? ' (has driver)' : '';
          return `  ${i + 1}. ${p.text}${hasDriver}`;
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

async function buildCurrentContext(context: Record<string, any>): Promise<string> {
  if (!context?.page) return 'Unknown page';
  const parts = [`Page: ${context.page}`];
  if (context.draftId) {
    // Include draft completion status so Maria knows whether work is done or in progress
    try {
      const draft = await prisma.threeTierDraft.findUnique({
        where: { id: context.draftId },
        select: {
          currentStep: true,
          status: true,
          offering: { select: { name: true } },
          audience: { select: { name: true } },
        },
      });
      if (draft) {
        const stepLabel = draft.currentStep >= 5 ? 'complete (step 5)' : `in progress (step ${draft.currentStep}/5)`;
        parts.push(`Viewing Three Tier draft: ${draft.offering.name} → ${draft.audience.name}, ${stepLabel}`);
      } else {
        parts.push('Viewing a Three Tier draft');
      }
    } catch {
      parts.push('Viewing a Three Tier draft');
    }
  }
  if (context.storyId) parts.push('Viewing a Five Chapter Story');
  if (context.audienceId) parts.push('An audience is selected');
  if (context.offeringId) parts.push('An offering is selected');
  return parts.join('. ');
}

interface ReturnContext {
  draftId: string;
  offeringName: string;
  audienceName: string;
  currentStep: number;
  hasStories: boolean;
  unblendedMedium?: string;
}

async function buildReturnContext(workspaceId: string): Promise<ReturnContext | null> {
  const recentDraft = await prisma.threeTierDraft.findFirst({
    where: { offering: { workspaceId }, archived: false },
    orderBy: { updatedAt: 'desc' },
    include: {
      offering: { select: { name: true } },
      audience: { select: { name: true } },
      stories: { select: { medium: true, stage: true } },
    },
  });

  if (!recentDraft) return null;

  const unblended = recentDraft.stories.find(s => s.stage === 'chapters');
  return {
    draftId: recentDraft.id,
    offeringName: recentDraft.offering.name,
    audienceName: recentDraft.audience.name,
    currentStep: recentDraft.currentStep,
    hasStories: recentDraft.stories.length > 0,
    unblendedMedium: unblended?.medium,
  };
}

async function buildSurfacingHint(workspaceId: string, userId?: string): Promise<string | undefined> {
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
    return `The audience "${emptyAudiences[0].name}" has no priorities yet. You could offer to draft them if the user tells you the persona — you know what most roles care about.`;
  }

  // Check for audiences where the top priority has no driver
  const audiencesNoDriver = await prisma.audience.findMany({
    where: {
      workspaceId,
      priorities: { some: { rank: 1, driver: { equals: '' } } },
    },
    select: { name: true },
  });
  if (audiencesNoDriver.length > 0) {
    return `The audience "${audiencesNoDriver[0].name}" has a top priority with no driver. You could offer to draft it — you understand the offering well enough to connect the stakes.`;
  }

  // Check if user has a Five Chapter Story but no personalization profile
  const hasStory = drafts.some(d => d.stories.length > 0);
  if (hasStory && userId) {
    const personalizeProfile = await getPersonalize(userId);
    if (personalizeProfile.observations.length === 0 && !personalizeProfile.offered) {
      // Mark as offered so this doesn't nag every session
      await updatePersonalize(userId, { offered: true });
      return `I can now try to get closer to your personal writing style. I call it "Personalization" and you'll see a new button for that on your Five Chapter Story page next to "Polish." If you personalize, you'll still get the best Five Chapter Stories I can write, but now, they'll sound more like you. I'll have to ask some questions, so we can do that now or whenever you like.`;
    }
  }

  return undefined;
}

// ─── Routes ──────────────────────────────────────────────

// GET /api/partner/status — check intro state, return context if useful
router.get('/status', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const settings = await getPartnerSettings(userId);
  const username = settings.username;
  const displayName = settings.displayName;
  const lastVisitAt = settings.lastVisitAt;

  // Migration: existing users with introduced=true but no introStep need introStep=4
  let introStep = settings.introStep;
  if (settings.introduced && introStep < 4) {
    introStep = 4;
    // Persist the migration
    try {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { settings: true } });
      const current = (user?.settings as Record<string, any>) || {};
      await prisma.user.update({
        where: { id: userId },
        data: { settings: { ...current, partner: { ...current.partner, introStep: 4 } } },
      });
    } catch { /* non-critical */ }
  }
  const introduced = introStep >= 4;

  let returnContext: ReturnContext | null = null;
  let proactiveOffer: string | null = null;

  // Check for 0-to-1 moments — blank canvases Maria can fill
  const wsId = req.workspaceId!;
  if (introduced) {
    try {
      // Audiences with 0 priorities
      const emptyAudience = await prisma.audience.findFirst({
        where: { workspaceId: wsId, priorities: { none: {} } },
        select: { name: true },
      });
      if (emptyAudience) {
        proactiveOffer = `I know what ${emptyAudience.name} typically cares about. Want me to draft the priorities?`;
      }

      // Audiences where the TOP priority has no driver, AND an offering exists
      if (!proactiveOffer) {
        const audNoDriver = await prisma.audience.findFirst({
          where: {
            workspaceId: wsId,
            priorities: { some: { rank: 1, driver: { equals: '' } } },
          },
          select: { name: true },
        });
        const hasOffering = await prisma.offering.count({ where: { workspaceId: wsId } });
        if (audNoDriver && hasOffering > 0) {
          proactiveOffer = `${audNoDriver.name}'s top priority doesn't have a driver yet. I can draft it — I understand the offering.`;
        }
      }

      // Three Tier at step 5 with sparse Tier 3 (fewer than 1 per Tier 2 on average)
      if (!proactiveOffer) {
        const draftWithTiers = await prisma.threeTierDraft.findFirst({
          where: { offering: { workspaceId: wsId }, currentStep: 5 },
          include: {
            tier2Statements: { include: { tier3Bullets: true } },
            audience: { select: { name: true } },
          },
          orderBy: { updatedAt: 'desc' },
        });
        if (draftWithTiers && draftWithTiers.tier2Statements.length > 0) {
          const avgT3 = draftWithTiers.tier2Statements.reduce((sum, t2) => sum + t2.tier3Bullets.length, 0) / draftWithTiers.tier2Statements.length;
          if (avgT3 < 1) {
            proactiveOffer = `Your Three Tier for ${draftWithTiers.audience.name} needs proof points. Want me to fill in what I can from the offering?`;
          }
        }
      }
    } catch {
      // Non-critical
    }
  }

  // If user has been introduced and was away >24h, build return context (no stored message)
  if (introduced && lastVisitAt) {
    const gap = Date.now() - new Date(lastVisitAt).getTime();
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

    if (gap > TWENTY_FOUR_HOURS) {
      try {
        returnContext = await buildReturnContext(req.workspaceId!);
      } catch {
        // Non-critical
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

  res.json({ username, displayName, introduced, introStep, returnContext, proactiveOffer });
});

// PUT /api/partner/name — store display name (does NOT complete intro)
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
          introStep: Math.max(current.partner?.introStep || 0, 1),
          lastVisitAt: new Date().toISOString(),
        },
      },
    },
  });

  res.json({ success: true, displayName });
});

// PUT /api/partner/intro-step — advance or complete the intro
router.put('/intro-step', async (req: Request, res: Response) => {
  const { step, dismiss } = req.body;

  const user = await prisma.user.findUnique({
    where: { id: req.user!.userId },
    select: { settings: true },
  });
  const current = (user?.settings as Record<string, any>) || {};

  if (dismiss) {
    // Dismiss = intro gone forever
    await prisma.user.update({
      where: { id: req.user!.userId },
      data: {
        settings: {
          ...current,
          partner: { ...current.partner, introduced: true, introStep: 4, lastVisitAt: new Date().toISOString() },
        },
      },
    });
  } else if (typeof step === 'number' && step >= 0 && step <= 4) {
    // Advance to a specific step (0=name, 1=phase1, 2=phase2, 3=phase3, 4=done)
    const introduced = step >= 4;
    await prisma.user.update({
      where: { id: req.user!.userId },
      data: {
        settings: {
          ...current,
          partner: { ...current.partner, introStep: step, introduced, lastVisitAt: new Date().toISOString() },
        },
      },
    });
  }

  res.json({ success: true });
});

// GET /api/partner/history — load persistent conversation
router.get('/history', async (req: Request, res: Response) => {
  // Load partner messages for current workspace + legacy messages without workspaceId
  const allPartner = await prisma.assistantMessage.findMany({
    where: {
      userId: req.user!.userId,
      context: { path: ['channel'], equals: 'partner' },
    },
    select: { role: true, content: true, createdAt: true, context: true },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  // Filter: include messages for this workspace OR legacy messages (no workspaceId field)
  const wsId = req.workspaceId!;
  const messages = allPartner.filter(m => {
    const ctx = m.context as any;
    return !ctx?.workspaceId || ctx.workspaceId === wsId;
  }).map(({ role, content, createdAt }) => ({ role, content, createdAt }));
  messages.reverse();
  res.json({ messages });
});

// POST /api/partner/message — send a message and get Maria's response
// Optionally accepts an attachment: { data: base64string, mimeType: string, filename: string }
// Images are sent to Claude via vision. PDFs and text files are extracted and prepended.
router.post('/message', async (req: Request, res: Response) => {
  const { message, context, attachment } = req.body as {
    message?: string;
    context?: ActionContext;
    attachment?: { data: string; mimeType: string; filename: string };
  };
  if (!message && !attachment) {
    res.status(400).json({ error: 'message or attachment is required' });
    return;
  }

  const userId = req.user!.userId;
  const workspaceId = req.workspaceId!;
  const ctx: ActionContext = context || {};

  // Load conversation history (last 40 messages, scoped to current workspace + legacy)
  const allHistory = await prisma.assistantMessage.findMany({
    where: {
      userId,
      context: { path: ['channel'], equals: 'partner' },
    },
    select: { role: true, content: true, createdAt: true, context: true },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  const history = allHistory.filter(m => {
    const ctx = m.context as any;
    return !ctx?.workspaceId || ctx.workspaceId === workspaceId;
  }).slice(0, 40);
  history.reverse();

  // Get user's display name
  const { displayName } = await getPartnerSettings(userId);

  // Build work summary and context
  const [workSummary, surfacingHint, offeringCount, audienceCount, membership] = await Promise.all([
    buildWorkSummary(workspaceId),
    history.length === 0 ? buildSurfacingHint(workspaceId, userId) : Promise.resolve(undefined),
    prisma.offering.count({ where: { workspaceId } }),
    prisma.audience.count({ where: { workspaceId } }),
    prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    }),
  ]);

  const currentContext = await buildCurrentContext(ctx);
  const isNewUser = offeringCount === 0 && audienceCount === 0;
  const userRole = req.user?.isAdmin ? 'owner' : (membership?.role || 'collaborator');

  let systemPrompt = buildPartnerPrompt({
    displayName,
    workSummary,
    currentContext,
    pageContext: ctx,
    isFirstMessage: history.length === 0,
    surfacingHint: history.length === 0 ? surfacingHint : undefined,
    isNewUser,
    userRole,
  });

  // Personalization context — interview questions PREPEND to override conversational tone
  const personalizeProfile = await getPersonalize(userId);
  if (personalizeProfile.interviewStep > 0 && personalizeProfile.interviewStep < 7) {
    // Interview in progress — prepend the mandatory question so Opus sees it FIRST
    const interviewBlock = buildPersonalizeChatBlock(personalizeProfile);
    systemPrompt = interviewBlock + '\n\n' + systemPrompt;
  } else if (personalizeProfile.observations.length > 0 || personalizeProfile.interviewStep > 0) {
    // Profile exists or interview complete — append as context
    systemPrompt += buildPersonalizeChatBlock(personalizeProfile);
  }

  // Build conversation history for the AI
  const conversationHistory = history.map(m => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));

  // Build user message — plain text or content blocks with attachment.
  // Images go through Claude vision. Text/PDF content is prepended as text.
  let userContent: string | any[] = message || '';
  if (attachment?.data && attachment?.mimeType) {
    const isImage = attachment.mimeType.startsWith('image/');
    const isPDF = attachment.mimeType === 'application/pdf';
    const isText = attachment.mimeType.startsWith('text/') || attachment.mimeType === 'application/json';

    if (isImage) {
      userContent = [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: attachment.mimeType,
            data: attachment.data,
          },
        },
        { type: 'text', text: message || `I've attached an image (${attachment.filename || 'file'}). What do you see, and how can you use this for my messaging?` },
      ];
    } else if (isPDF) {
      userContent = [
        {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: attachment.data,
          },
        },
        { type: 'text', text: message || `I've attached a PDF (${attachment.filename || 'document'}). Please read it and use whatever is relevant for my messaging.` },
      ];
    } else if (isText) {
      const textContent = Buffer.from(attachment.data, 'base64').toString('utf-8');
      const prefix = `[ATTACHED FILE: ${attachment.filename || 'file'}]\n${textContent}\n[END OF ATTACHED FILE]\n\n`;
      userContent = prefix + (message || 'I pasted some content above. Please read it and use whatever is relevant.');
    }
  }

  // Call Opus with JSON response format. If Opus returns an empty
  // response AND no actions, retry once — this occasionally happens
  // when the model outputs malformed JSON that gets parsed to empty.
  let result = await callAIWithJSON<{
    response: string;
    action?: { type: string; params: Record<string, any> } | null;
    actions?: { type: string; params: Record<string, any> }[];
  }>(systemPrompt, userContent, 'elite', conversationHistory);

  // Normalize actions
  let rawActions: { type: string; params: Record<string, any> }[] = [];
  if (result.actions && Array.isArray(result.actions) && result.actions.length > 0) {
    rawActions = result.actions;
  } else if (result.action && result.action.type) {
    rawActions = [result.action];
  }

  // Retry once if Opus returned nothing usable
  if ((!result.response || !result.response.trim()) && rawActions.length === 0) {
    console.warn('[Partner] Empty response + no actions from Opus. Retrying once.');
    result = await callAIWithJSON<{
      response: string;
      action?: { type: string; params: Record<string, any> } | null;
      actions?: { type: string; params: Record<string, any> }[];
    }>(systemPrompt, userContent, 'elite', conversationHistory);
    rawActions = [];
    if (result.actions && Array.isArray(result.actions) && result.actions.length > 0) {
      rawActions = result.actions;
    } else if (result.action && result.action.type) {
      rawActions = [result.action];
    }
  }

  // Check if Maria wants to read the page
  const normalizedActions = rawActions.map(a => ({
    ...a,
    type: ACTION_ALIASES[a.type] || a.type,
  }));

  if (normalizedActions.length === 1 && normalizedActions[0].type === 'read_page') {
    // Store the user message but not the response yet (will retry with page content)
    await prisma.assistantMessage.create({
      data: { userId, role: 'user', content: message || '', context: partnerChannel(workspaceId) },
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
      r.startsWith('Could not') || r.startsWith('Action failed') || r.includes('not recognized') || r.startsWith("I can't") || r.startsWith("I wasn't able")
    );

    actionResult = dispatch.results.length > 0 ? dispatch.results.join(' · ') : null;

    // If actions failed, override Maria's optimistic response
    if (failedResults.length > 0) {
      result.response = `I tried, but it didn't work: ${failedResults.join('. ')}`;
    }

    // ─── Lead-mode continuation ──────────────────────────
    // When Maria creates an offering + audience but stops short of enriching
    // and building, the user is left waiting for a result Maria promised.
    // Detect this pattern and automatically chain the remaining steps:
    // draft_mfs → build_deliverable. This makes "do everything" reliable
    // regardless of whether Opus chains all actions in one response.
    const createdOffering = dispatch.results.some(r => r.includes('Created offering'));
    const createdAudience = dispatch.results.some(r => r.includes('Created audience'));
    const alreadyBuilding = dispatch.results.some(r => r.includes('BUILD_STARTED'));
    const alreadyDraftedMFs = dispatch.results.some(r => r.includes('Drafted motivating factors'));
    const userWantsEverything = /do everything|show me the finished|please do everything|work.*independent|do it all|build.*everything/i.test(message || '');

    if (createdOffering && createdAudience && !alreadyBuilding && userWantsEverything) {
      console.log('[Partner] Lead-mode continuation: offering + audience created, chaining enrichment + build');

      // Find the offering and audience that were just created
      const recentOffering = await prisma.offering.findFirst({
        where: { userId, ...(workspaceId ? { workspaceId } : {}) },
        orderBy: { createdAt: 'desc' },
      });
      const recentAudience = await prisma.audience.findFirst({
        where: { userId, ...(workspaceId ? { workspaceId } : {}) },
        orderBy: { createdAt: 'desc' },
        include: { priorities: true },
      });

      if (recentOffering && recentAudience) {
        // Detect medium from user message
        const msg = message || '';
        let medium = 'email';
        if (/one.?page|one.?pager|briefing/i.test(msg)) medium = 'landing_page';
        else if (/pitch.*deck/i.test(msg)) medium = 'pitch_deck';
        else if (/report/i.test(msg)) medium = 'report';

        // Go straight to build_deliverable — skip draft_mfs in the
        // continuation because it takes 20+ seconds and would timeout
        // the HTTP response. The pipeline will produce a draft without
        // MFs (slightly lower mapping quality, acceptable for first
        // draft). If Opus already chained draft_mfs in its own actions,
        // those ran before we get here.
        const continuationActions: { type: string; params: Record<string, any> }[] = [{
          type: 'build_deliverable',
          params: {
            offeringName: recentOffering.name,
            audienceName: recentAudience.name,
            medium,
            situation: message || '',
          },
        }];

        const contDispatch = await dispatchActions(continuationActions, userId, ctx, workspaceId);
        const contResult = contDispatch.results.join(' · ');
        actionResult = actionResult ? `${actionResult} · ${contResult}` : contResult;
        if (contDispatch.refreshNeeded) refreshNeeded = true;

        // Update response to reflect what actually happened
        if (contResult.includes('BUILD_STARTED')) {
          result.response = (result.response || '').replace(
            /This'll take a few minutes.*$/i,
            ''
          ).trim();
          if (!result.response.includes("I'll bring you")) {
            result.response += " I've drafted the foundational message — you can see it by tapping '3 Tiers' in the menu anytime. I'm putting together your one-pager now. I'll bring you right to it when it's ready.";
          }
        }
      }
    }
  }

  // Guard against empty responses. When Opus returns empty text, the user
  // sees a blank message — unacceptable. Generate a fallback so the user
  // always knows what Maria is doing.
  if (!result.response || !result.response.trim()) {
    console.warn(`[Partner] Empty response from Opus. Actions: ${normalizedActions.map(a => a.type).join(', ') || 'none'}`);
    if (actionResult?.includes('BUILD_STARTED')) {
      result.response = "I'm putting together your draft now. I'll bring you right to it when it's ready — just give me a few minutes.";
    } else if (actionResult?.includes('Drafted motivating factors')) {
      result.response = "Done — I've researched why each capability matters and drafted the motivating factors.";
    } else if (actionResult?.includes('Added') && actionResult?.includes('priorities')) {
      result.response = "Added those priorities. Let me keep going.";
    } else if (actionResult?.includes('Created offering') || actionResult?.includes('Created audience')) {
      result.response = "Got it — I've set that up. Let me keep building.";
    } else if (actionResult) {
      result.response = "Working on it.";
    } else {
      // No actions AND empty response — Opus call produced nothing usable.
      // This should never happen but does occasionally. Give a recovery message.
      result.response = "Sorry — I lost my train of thought for a second. Could you say that again?";
    }
  }

  // Store both messages — serialize response with action result for history
  const storedResponse = actionResult
    ? `${result.response}\n\n[${actionResult}]`
    : result.response;

  // Strip [PAGE CONTENT] prefix from stored message — only keep the user's actual text
  const rawMsg = message || '';
  const userQuestion = rawMsg.includes('[USER QUESTION]\n')
    ? rawMsg.split('[USER QUESTION]\n').pop()!
    : (rawMsg || (attachment ? `[Attached: ${attachment.filename}]` : ''));

  await prisma.assistantMessage.createMany({
    data: [
      { userId, role: 'user', content: userQuestion, context: partnerChannel(workspaceId) },
      { userId, role: 'assistant', content: storedResponse, context: partnerChannel(workspaceId) },
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

// DELETE /api/partner/history — clear partner conversation for current workspace + legacy
router.delete('/history', async (req: Request, res: Response) => {
  // Load all partner messages, filter to current workspace + legacy, delete by IDs
  const allPartner = await prisma.assistantMessage.findMany({
    where: {
      userId: req.user!.userId,
      context: { path: ['channel'], equals: 'partner' },
    },
    select: { id: true, context: true },
  });
  const wsId = req.workspaceId!;
  const idsToDelete = allPartner
    .filter(m => { const ctx = m.context as any; return !ctx?.workspaceId || ctx.workspaceId === wsId; })
    .map(m => m.id);
  if (idsToDelete.length > 0) {
    await prisma.assistantMessage.deleteMany({ where: { id: { in: idsToDelete } } });
  }
  res.json({ success: true });
});

export default router;
