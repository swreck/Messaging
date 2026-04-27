import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace } from '../middleware/workspace.js';
import { callAIWithJSON } from '../services/ai.js';
import { buildPartnerPrompt } from '../prompts/partner.js';
import { ACTION_ALIASES, dispatchActions, readPageContent, type ActionContext } from '../lib/actions.js';
import { getPersonalize, updatePersonalize, buildPersonalizeChatBlock } from '../lib/personalize.js';
import { partnerLimiter } from '../middleware/rateLimit.js';

const router = Router();
router.use(requireAuth);
router.use(requireWorkspace);

// Channel marker — now includes workspaceId for conversation partitioning.
// B-7 — also persists the active surface's primary entity IDs so the
// /history endpoint can scope-filter by surface (Three Tier draftId,
// FCS storyId, Audience audienceId, Offering offeringId). Filtering is
// purely user-visible; system-prompt history loaded for Maria is full.
function partnerChannel(workspaceId: string, ctx?: { storyId?: string; draftId?: string; audienceId?: string; offeringId?: string }): Record<string, string> {
  const out: Record<string, string> = { channel: 'partner', workspaceId };
  if (ctx?.storyId) out.storyId = ctx.storyId;
  if (ctx?.draftId) out.draftId = ctx.draftId;
  if (ctx?.audienceId) out.audienceId = ctx.audienceId;
  if (ctx?.offeringId) out.offeringId = ctx.offeringId;
  return out;
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

async function buildCurrentContext(context: Record<string, any>, userId?: string): Promise<string> {
  if (!context?.page) return 'Unknown page';
  const parts = [`Page: ${context.page}`];
  // Bug #4 — explicit primary-page signal when both draftId and storyId are
  // present. /five-chapter/<draftId>?story=<storyId> URLs carry both IDs but
  // the FCS is the active page; without this signal Maria treated the Three
  // Tier as primary and ignored the FCS metadata block right below.
  if (context.storyId) {
    parts.push('PRIMARY PAGE: Five Chapter Story (the FCS metadata block below — current style, format, audience, peer-info — is the canonical source of truth for the active deliverable; the Three Tier reference below is contextual)');
  } else if (context.draftId) {
    parts.push('PRIMARY PAGE: Three Tier draft');
  }
  // Bug #4 — when both storyId and draftId are present, surface the FCS
  // block FIRST so Maria reads the canonical metadata at the top instead
  // of treating the Three Tier as primary. Three Tier becomes "related"
  // context below.
  if (context.storyId) {
    let storyDetails = '';
    try {
      const story = await prisma.fiveChapterStory.findUnique({
        where: { id: context.storyId },
        select: {
          id: true,
          medium: true,
          customName: true,
          cta: true,
          style: true,
          peerAsked: true,
          peerInfo: true,
          draft: { select: { audience: { select: { name: true } } } },
        },
      });
      if (story) {
        const effectiveStyle = userId
          ? await (await import('../lib/styleResolver.js')).resolveStyleForStory(story.id, userId).catch(() => null)
          : null;
        const styleLabel = (story.style && story.style.length > 0)
          ? story.style
          : (effectiveStyle || 'TABLE_FOR_2');
        const detailParts = [
          `current style: ${styleLabel}`,
          `format: ${story.medium}`,
          story.draft?.audience?.name ? `for: ${story.draft.audience.name}` : null,
          story.cta ? `cta: ${story.cta}` : null,
          story.peerAsked ? `peer info captured: ${story.peerInfo ? 'yes' : 'no (skipped)'}` : 'peer info not yet captured',
        ].filter(Boolean) as string[];
        storyDetails = ` (${detailParts.join('; ')})`;
      }
    } catch {/* non-fatal */}
    parts.push(`Active Five Chapter Story${storyDetails}. [STORY_CONTEXT:${context.storyId}]`);
  }
  if (context.draftId) {
    // Include draft completion status so Maria knows whether work is done or in progress.
    // Labeled "Related Three Tier" when an FCS is also active so Maria treats it as
    // contextual reference, not the primary surface.
    const label = context.storyId ? 'Related Three Tier' : 'Viewing Three Tier draft';
    try {
      const draft = await prisma.threeTierDraft.findUnique({
        where: { id: context.draftId },
        select: {
          currentStep: true,
          status: true,
          noStrongPairings: true,
          offering: { select: { name: true } },
          audience: { select: { name: true } },
        },
      });
      if (draft) {
        const stepLabel = draft.currentStep >= 5 ? 'complete (step 5)' : `in progress (step ${draft.currentStep}/5)`;
        parts.push(`${label}: ${draft.offering.name} → ${draft.audience.name}, ${stepLabel}`);
        if (draft.noStrongPairings === true) {
          parts.push('noStrongPairings: true — none of the priority/special-thing pairings on this draft came back STRONG. Apply the AUDIENCE-FIT CONVERSATION pattern from your system prompt: humble curiosity about the offering, NEVER a verdict on audience choice.');
        }
      } else {
        parts.push(label);
      }
    } catch {
      parts.push(label);
    }
  }
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
  lastActivityAt?: string;
}

async function buildReturnContext(workspaceId: string, userId: string): Promise<ReturnContext | null> {
  // CROSS-ACCOUNT ISOLATION: scope by BOTH workspaceId AND offering.userId. The
  // workspace is a multi-user surface; without the userId filter the most-recent
  // draft surfaced here could belong to any user in the workspace, which has been
  // observed to leak content across demo accounts. Tested via Sofia/Tom regression.
  const recentDraft = await prisma.threeTierDraft.findFirst({
    where: { offering: { workspaceId, userId }, archived: false },
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
    lastActivityAt: recentDraft.updatedAt.toISOString(),
  };
}

async function buildSurfacingHint(workspaceId: string, userId?: string): Promise<string | undefined> {
  // CROSS-ACCOUNT ISOLATION: filter drafts by the current user's offerings, not
  // the entire workspace. Without this, a multi-user workspace would let one
  // user's drafts surface as another user's hints. Same-bug pattern as
  // buildReturnContext above.
  const drafts = await prisma.threeTierDraft.findMany({
    where: { offering: { workspaceId, ...(userId ? { userId } : {}) } },
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
  let resumeDraft: { sessionId: string; summary: string; phase: string } | null = null;

  // Check for 0-to-1 moments — blank canvases Maria can fill
  const wsId = req.workspaceId!;
  if (introduced) {
    try {
      // Active guided session — user started a message and walked away before committing.
      // This is the "drafts bucket" for the guided flow: GuidedSession persists state
      // continuously, so if the user returns we can offer to pick up where they left off.
      // Surfacing this FIRST because a half-built message is the most time-sensitive thing.
      const activeSession = await prisma.guidedSession.findFirst({
        where: {
          userId,
          workspaceId: wsId,
          completedAt: null,
          // Only surface if user got past the initial greeting — otherwise there's nothing to resume
          phase: { in: ['confirming_inputs', 'generating_foundation', 'reviewing_foundation', 'choosing_format', 'generating_draft'] },
        },
        orderBy: { updatedAt: 'desc' },
      });
      if (activeSession) {
        const interp = activeSession.interpretation as { offering?: { name?: string }; audiences?: { name?: string }[] } | null;
        const offeringName = interp?.offering?.name || 'something';
        const audienceName = interp?.audiences?.[0]?.name || 'your audience';
        let summary: string;
        if (activeSession.phase === 'confirming_inputs') {
          summary = `You were describing ${offeringName} for ${audienceName}. Want to pick that up where we left off?`;
        } else if (activeSession.phase === 'reviewing_foundation' || activeSession.phase === 'generating_foundation') {
          summary = `You were reviewing the Three Tier foundation for ${offeringName} → ${audienceName}. Want to go back to it?`;
        } else {
          summary = `You were building a draft for ${offeringName} → ${audienceName}. Want to pick that up?`;
        }
        resumeDraft = { sessionId: activeSession.id, summary, phase: activeSession.phase };
      }

      // Audiences with 0 priorities
      if (!resumeDraft) {
        const emptyAudience = await prisma.audience.findFirst({
          where: { workspaceId: wsId, priorities: { none: {} } },
          select: { name: true },
        });
        if (emptyAudience) {
          proactiveOffer = `I know what ${emptyAudience.name} typically cares about. Want me to draft the priorities?`;
        }
      }

      // Audiences where the TOP priority has no driver, AND an offering exists
      if (!proactiveOffer && !resumeDraft) {
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
      if (!proactiveOffer && !resumeDraft) {
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
        returnContext = await buildReturnContext(req.workspaceId!, userId);
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

  res.json({ username, displayName, introduced, introStep, returnContext, proactiveOffer, resumeDraft });
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

// GET /api/partner/history — load persistent conversation.
// B-7 — accepts optional scope query params (scopeStoryId, scopeDraftId,
// scopeAudienceId, scopeOfferingId). When provided, returns only messages
// whose persisted context matched the same primary entity. NOTE: this is
// PURELY a user-visible filter — the backend's system-prompt construction
// in /message still loads the full unfiltered history so Maria's
// continuity reasoning isn't affected by what the user happens to be
// looking at right now.
router.get('/history', async (req: Request, res: Response) => {
  const { scopeStoryId, scopeDraftId, scopeAudienceId, scopeOfferingId } = req.query as {
    scopeStoryId?: string;
    scopeDraftId?: string;
    scopeAudienceId?: string;
    scopeOfferingId?: string;
  };
  // Load partner messages for current workspace + legacy messages without workspaceId
  const allPartner = await prisma.assistantMessage.findMany({
    where: {
      userId: req.user!.userId,
      context: { path: ['channel'], equals: 'partner' },
    },
    select: { role: true, content: true, createdAt: true, context: true },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });
  const wsId = req.workspaceId!;
  let filtered = allPartner.filter(m => {
    const ctx = m.context as any;
    return !ctx?.workspaceId || ctx.workspaceId === wsId;
  });
  // B-7 scope filter — match on whichever scope arg was provided. A message
  // matches when its persisted context's primary-entity ID equals the
  // requested scope. We tolerate the possibility that older messages were
  // logged WITHOUT the entity ID in their context (legacy rows pre-Round B);
  // those are surfaced under "Everything" only, never under a scoped view.
  if (scopeStoryId || scopeDraftId || scopeAudienceId || scopeOfferingId) {
    filtered = filtered.filter(m => {
      const ctx = (m.context as any) || {};
      if (scopeStoryId && ctx.storyId === scopeStoryId) return true;
      if (scopeDraftId && ctx.draftId === scopeDraftId) return true;
      if (scopeAudienceId && ctx.audienceId === scopeAudienceId) return true;
      if (scopeOfferingId && ctx.offeringId === scopeOfferingId) return true;
      return false;
    });
  }
  const messages = filtered
    .slice(0, 200)
    .map(({ role, content, createdAt }) => ({ role, content, createdAt }));
  messages.reverse();
  res.json({ messages });
});

// POST /api/partner/message — send a message and get Maria's response
// Optionally accepts an attachment: { data: base64string, mimeType: string, filename: string }
// Images are sent to Claude via vision. PDFs and text files are extracted and prepended.
router.post('/message', partnerLimiter, async (req: Request, res: Response) => {
  const { message, context, attachment, attachments: rawAttachments, timeContext, voicePersistentIntent, websiteResearchOffered } = req.body as {
    message?: string;
    context?: ActionContext;
    attachment?: { data: string; mimeType: string; filename: string };
    attachments?: { data: string; mimeType: string; filename: string }[];
    // Round B6 — time-aware session pacing. Frontend tracks the session-start
    // timestamp + the user's time budget in localStorage and includes them on
    // every partner message. Backend computes elapsed and decides whether to
    // inject the [TIME_THRESHOLD_REACHED:...] trigger into the system prompt.
    timeContext?: {
      sessionStartMs?: number;   // Date.now() at session start
      budgetMin?: number;         // null = no budget set / unlimited
      thresholdTriggered?: boolean; // true once the 80% trigger has fired this session
    };
    // Round E3 — flagged when the user's voice input contained persistent-
    // intent phrasing ("from now on", "going forward", "remember to").
    // The system prompt surfaces it so Maria explicitly summary-backs the
    // persistent intent before saving the rule.
    voicePersistentIntent?: string;
    // B-2 — frontend tracks once-per-session whether Maria has already
    // offered to read a company's website (date-stamped localStorage key
    // 'website-research-offered-{date}'). Surfaces here so the prompt
    // rule can suppress re-offering.
    websiteResearchOffered?: boolean;
  };
  // Normalize: single attachment or array of attachments
  const allAttachments: { data: string; mimeType: string; filename: string }[] =
    rawAttachments || (attachment ? [attachment] : []);
  if (!message && allAttachments.length === 0) {
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
  }).slice(0, 20);
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

  const currentContext = await buildCurrentContext(ctx, userId);
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

  // Round E3 — surface persistent-intent voice flag so the prompt rule's
  // explicit summary-back fires.
  if (voicePersistentIntent && typeof voicePersistentIntent === 'string') {
    systemPrompt += `\n\nVOICE PERSISTENT-INTENT FLAG — the user's last voice input contained phrasing that suggests a persistent rule ("from now on", "going forward", "remember to", etc.). Surface the rule explicitly in your summary-back: "...and I'll remember to apply this to future [audience-type/format] — got it right?" — then on user yes, emit [SAVE_STYLE_RULE:scopeAudienceType:scopeFormat:rule text]. Original phrasing: "${voicePersistentIntent.slice(0, 500).replace(/"/g, '\\"')}"`;
  }

  // B-2 — surface website-research-offer status so Maria's proactive
  // offer fires at most once per session. The flag flips to true on the
  // frontend the moment Maria emits [WEBSITE_RESEARCH_OFFERED] in a
  // reply, so by the next turn she sees the suppressed state.
  systemPrompt += websiteResearchOffered
    ? `\n\nWEBSITE RESEARCH OFFER STATUS: ALREADY OFFERED THIS SESSION — do not re-offer to read a company's website this session, even if the user names another company. If the user pastes a URL or explicitly asks you to read a site, still call research_website normally; the once-per-session rule only suppresses the proactive offer.`
    : `\n\nWEBSITE RESEARCH OFFER STATUS: NOT YET OFFERED THIS SESSION — if the user names a company in this turn, follow rule (f) under RESEARCH and offer once with the [WEBSITE_RESEARCH_OFFERED] marker.`;

  // Round E4 / Bug #5 — surface the foundationalShift detection result from
  // the most recent chapter edit. The chapter PUT handler stashes the
  // result on User.settings.pendingFoundationalShift. Survives across
  // multiple chat replies until either (a) Maria emits the
  // [APPLY_FOUNDATIONAL_SHIFT:...] marker (frontend MariaPartner clears it
  // by calling /partner/clear-pending after a successful tier update) OR
  // (b) the 90-second freshness window expires. NOT single-shot consumed
  // on the first chat reply — that lost the proposal whenever Maria
  // didn't immediately surface it.
  try {
    const userRow = await prisma.user.findUnique({ where: { id: userId }, select: { settings: true } });
    const settings = (userRow?.settings as Record<string, any>) || {};
    const pending = settings.pendingFoundationalShift as { draftId?: string; targetCell?: string; oldText?: string; newText?: string; reason?: string; setAt?: string } | undefined;
    if (pending && pending.draftId && pending.targetCell && pending.oldText && pending.newText) {
      const ageMs = pending.setAt ? Date.now() - new Date(pending.setAt).getTime() : Infinity;
      if (ageMs < 90_000) {
        // FCS-first framing per Bug #5: lead with "you are on the Five
        // Chapter Story page" so Maria does not regress into Three-Tier-as-
        // primary mode despite the PRIMARY PAGE signal in currentContext.
        // The Tier update is downstream; the user's edit was on the FCS.
        systemPrompt += `\n\nFOUNDATIONAL SHIFT — FIRST ACTION THIS TURN.

The user is on the Five Chapter Story page (see PRIMARY PAGE in the context block above) and just edited a CHAPTER. Maria's classifier judged the edit foundationally semantic — meaning the chapter rewrite implies a Tier-level reframing of the underlying Three Tier. The Tier update is a DOWNSTREAM consequence of the chapter edit; the user is not asking you to leave the FCS.

DO NOT say "let me look at the Five Chapter Story" or "I'm on the Three Tier right now" or any equivalent navigation move. You already have everything you need in this turn — the proposed new Tier wording is below. Surface the proposal as your FIRST ACTION in your reply, BEFORE any other content. The user expects to see the proposal immediately; navigation moves break that expectation.

Proposed Tier update:
- Target cell: ${pending.targetCell}
- Old text: "${pending.oldText.slice(0, 300).replace(/"/g, '\\"')}"
- New text (Maria's proposal, derived from the user's chapter rewrite): "${pending.newText.slice(0, 300).replace(/"/g, '\\"')}"
- Reason for the proposed shift: ${pending.reason || '(unstated)'}

Voice (per the FOUNDATIONAL-SHIFT DETECTION rule): "I'd update ${pending.targetCell === 'tier1' ? 'Tier 1' : `Tier 2 (${pending.targetCell.replace('tier2-', 'column ')})`} from [old text] to [new text] — confirm?" State the old and new text directly, then ask for confirm.

On user yes, emit [APPLY_FOUNDATIONAL_SHIFT:${pending.draftId}:${pending.targetCell}:<the new text exactly as proposed>] in your reply. The system intercepts the marker, applies the Tier update via the existing tier1/tier2 PUT, and snapshots the previous version into CellVersion history.

If the user declines or wants to discuss, drop the proposal cleanly — the chapter edit stays; the Tier stays. The proposal will time out in 90 seconds if neither applied nor declined.`;
      }
      // Age out STALE entries; preserve fresh ones across multiple replies
      // so a missed surface on one turn doesn't lose the proposal.
      if (ageMs >= 90_000) {
        const next = { ...settings };
        delete next.pendingFoundationalShift;
        await prisma.user.update({ where: { id: userId }, data: { settings: next } });
      }
    }
  } catch (err) { console.error('[E4] surface pending shift failed:', err); }

  // Round E2 / Bug #5 — surface the detectedPattern from the most recent
  // chapter edit. Same persistence semantics as E4: survives across multiple
  // chat replies until (a) Maria emits [SAVE_STYLE_RULE:...] (cleared via
  // /partner/clear-pending after the rule is saved) OR (b) 90s freshness
  // expires. Not single-shot consumed on first chat reply.
  try {
    const userRow2 = await prisma.user.findUnique({ where: { id: userId }, select: { settings: true } });
    const s2 = (userRow2?.settings as Record<string, any>) || {};
    const pendingPattern = s2.pendingEditPattern as { shape?: string; scopeAudienceType?: string; scopeFormat?: string; occurrences?: number; setAt?: string } | undefined;
    if (pendingPattern && pendingPattern.shape && pendingPattern.occurrences && pendingPattern.occurrences >= 3) {
      const ageMs = pendingPattern.setAt ? Date.now() - new Date(pendingPattern.setAt).getTime() : Infinity;
      if (ageMs < 90_000) {
        const scopeBits: string[] = [];
        if (pendingPattern.scopeAudienceType) scopeBits.push(`audience: ${pendingPattern.scopeAudienceType}`);
        if (pendingPattern.scopeFormat) scopeBits.push(`format: ${pendingPattern.scopeFormat}`);
        const scopeLabel = scopeBits.length > 0 ? scopeBits.join(' / ') : 'this kind of work';
        systemPrompt += `\n\nEDIT PATTERN — FIRST ACTION THIS TURN.

The user has made similar edits ${pendingPattern.occurrences} times in ${scopeLabel}. Shape: "${pendingPattern.shape.replace(/"/g, '\\"')}".

Ask the scoped question per EDIT-PATTERN LEARNING as your FIRST ACTION in this reply, before any other content. Do not navigate, do not "let me check" — you already have everything you need.

On user yes, emit [SAVE_STYLE_RULE:${pendingPattern.scopeAudienceType || ''}:${pendingPattern.scopeFormat || ''}:<rule text in user-affirmed phrasing>] in your reply. The system persists the rule and the prompt won't re-fire on subsequent edits matching the same shape.

If the user declines, drop it cleanly. The proposal will time out in 90 seconds.`;
      }
      // Age out STALE entries; preserve fresh ones across multiple replies.
      if (ageMs >= 90_000) {
        const next = { ...s2 };
        delete next.pendingEditPattern;
        await prisma.user.update({ where: { id: userId }, data: { settings: next } });
      }
    }
  } catch (err) { console.error('[E2] surface pending pattern failed:', err); }

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

  // Round B6 — time-aware session pacing. Compute elapsed and decide whether
  // to inject the threshold marker. Two cases:
  //   1. budgetMin set + elapsed >= 80% + thresholdTriggered=false → emit
  //      [TIME_THRESHOLD_REACHED:...] and respond signaling the boundary so
  //      the frontend can flip thresholdTriggered=true for subsequent calls.
  //   2. budgetMin set + elapsed/budget tracked but no trigger needed → soft
  //      "TIME CONTEXT" line so Maria can factor remaining time into framing.
  let timeThresholdFiredThisTurn = false;
  if (timeContext?.budgetMin && timeContext?.sessionStartMs) {
    const elapsedMs = Date.now() - timeContext.sessionStartMs;
    const elapsedMin = Math.floor(elapsedMs / 60000);
    const budgetMin = timeContext.budgetMin;
    const remainingMin = Math.max(0, budgetMin - elapsedMin);
    const pctElapsed = elapsedMin / budgetMin;
    const tightBudget = pctElapsed >= 0.7 && pctElapsed < 0.8;
    const crossedThreshold = pctElapsed >= 0.8 && !timeContext.thresholdTriggered;
    if (crossedThreshold) {
      timeThresholdFiredThisTurn = true;
      systemPrompt = `TIME THRESHOLD ALERT — surface this NOW, in this turn, before any other content:
[TIME_THRESHOLD_REACHED: elapsed=${elapsedMin}min, budget=${budgetMin}min, remaining=${remainingMin}min]

The user set a ${budgetMin}-minute budget at session start. They've used ${elapsedMin} minutes; ${remainingMin} remaining. Surface the threshold-intervention with elapsed/done/remaining/two-paths framing using these EXACT numbers. Voice: partnership, not surveillance. Example shape: "${remainingMin} minutes left in your budget. Where we are: [what's done]. Two paths — [ship now with the lighter version] or [push past your budget by ~${Math.round(remainingMin * 1.5)} minutes to do them properly]. What's the call?"

After this turn, the frontend marks thresholdTriggered=true so this alert won't re-fire. If the user blows past budget without intervening, you'll see another alert at the over-budget threshold.

` + systemPrompt;
    } else if (tightBudget) {
      // Soft awareness — no forced surfacing, but Maria knows the budget is tight.
      // High-leverage pauses (Topic 3 contrarian, Topic 22 peer prompt, foundation walkthrough)
      // should add time-cost framing. See "TIME-AWARE PACING" section in partner prompt.
      systemPrompt += `\n\nTIME CONTEXT — budget is tight: elapsed=${elapsedMin}min of ${budgetMin}min, remaining=${remainingMin}min. If you're about to ask a high-leverage question (contrarian, peer prompt, optional column review), include the time cost in your framing so the user can pick.`;
    }
  }

  // Build conversation history for the AI.
  // Filter out empty messages — files-only sends store with empty text,
  // which Anthropic rejects ("user messages must have non-empty content").
  const conversationHistory = history
    .filter(m => m.content && m.content.trim())
    .map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

  // Build user message — plain text or content blocks with attachments.
  // Images go through Claude vision. Text/PDF/DOCX content is prepended as text.
  let userContent: string | any[] = message || '';
  if (allAttachments.length > 0) {
    const contentBlocks: any[] = [];
    let textPrefix = '';
    // When multiple files, extract text from everything (including PDFs)
    // to avoid Anthropic's document block limit. Only use document blocks
    // for single-PDF uploads where quality matters most.
    const useTextExtraction = allAttachments.length > 1;

    for (const att of allAttachments) {
      const isImage = att.mimeType.startsWith('image/');
      const isPDF = att.mimeType === 'application/pdf' || att.filename?.endsWith('.pdf');
      const isDocx = att.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || att.filename?.endsWith('.docx');
      const isText = att.mimeType.startsWith('text/') || att.mimeType === 'application/json' || att.filename?.endsWith('.txt') || att.filename?.endsWith('.md') || att.filename?.endsWith('.csv');

      if (isImage) {
        contentBlocks.push({
          type: 'image',
          source: { type: 'base64', media_type: att.mimeType, data: att.data },
        });
      } else if (isPDF && !useTextExtraction) {
        contentBlocks.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: att.data },
        });
      } else if (isPDF && useTextExtraction) {
        // Multi-file mode: send up to 4 PDFs as document blocks.
        // Anthropic supports up to 5 total, reserve 1 for safety.
        const pdfBlockCount = contentBlocks.filter((b: any) => b.type === 'document').length;
        if (pdfBlockCount < 4) {
          contentBlocks.push({
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: att.data },
          });
        } else {
          textPrefix += `[ADDITIONAL PDF: ${att.filename || 'document.pdf'} — included by name; the content from the other PDFs should cover the key points.]\n\n`;
        }
      } else if (isDocx) {
        try {
          const mammoth = await import('mammoth');
          const buffer = Buffer.from(att.data, 'base64');
          const result = await mammoth.extractRawText({ buffer });
          textPrefix += `[ATTACHED DOCUMENT: ${att.filename || 'document.docx'}]\n${result.value}\n[END OF DOCUMENT]\n\n`;
        } catch (err) {
          console.error('[Partner] DOCX extraction failed:', err);
          textPrefix += `[ATTACHED DOCUMENT: ${att.filename || 'document.docx'}]\n(Could not extract text from this document)\n[END OF DOCUMENT]\n\n`;
        }
      } else if (isText) {
        const textContent = Buffer.from(att.data, 'base64').toString('utf-8');
        textPrefix += `[ATTACHED FILE: ${att.filename || 'file'}]\n${textContent}\n[END OF ATTACHED FILE]\n\n`;
      }
    }

    const fileNames = allAttachments.map(a => a.filename).filter(Boolean).join(', ');
    const defaultMsg = allAttachments.length === 1
      ? `I've attached a file (${fileNames}). Please read it and use whatever is relevant for my messaging.`
      : `I've attached ${allAttachments.length} files (${fileNames}). Please read them and use whatever is relevant for my messaging.`;
    const userText = textPrefix + (message || defaultMsg);

    if (contentBlocks.length > 0) {
      contentBlocks.push({ type: 'text', text: userText });
      userContent = contentBlocks;
    } else {
      userContent = userText;
    }
  }

  // Phase 1 hardening (Fix #3) — compute the canonical user-message text
  // (including extracted document text per the existing "store full doc
  // content" design) BEFORE the Opus call so the user message can be
  // persisted unconditionally. If the Opus call later fails, the user's
  // message is still recorded; without this the only user-message write
  // ran AFTER a successful Opus turn, which dropped the message on any
  // upstream failure.
  const rawMsg = message || '';
  let storedUserMsg: string;
  if (typeof userContent === 'string') {
    storedUserMsg = userContent || '(documents attached)';
  } else {
    const textBlock = (userContent as any[]).find((b: any) => b.type === 'text');
    storedUserMsg = textBlock?.text || rawMsg || '(documents attached)';
  }
  const userQuestion = rawMsg.includes('[USER QUESTION]\n')
    ? rawMsg.split('[USER QUESTION]\n').pop()!
    : storedUserMsg;
  await prisma.assistantMessage.create({
    data: { userId, role: 'user', content: userQuestion, context: partnerChannel(workspaceId, ctx) },
  });

  // Call Opus with JSON response format. If Opus returns an empty
  // response AND no actions, retry once — this occasionally happens
  // when the model outputs malformed JSON that gets parsed to empty.
  // Wrapped in try/catch so an Anthropic 5xx, timeout, or open-circuit
  // breaker surfaces as a friendly partner reply rather than a 500. The
  // user's message is already persisted above; on retry the channel
  // resumes naturally with the stored history.
  let result: {
    response: string;
    action?: { type: string; params: Record<string, any> } | null;
    actions?: { type: string; params: Record<string, any> }[];
  };
  let rawActions: { type: string; params: Record<string, any> }[] = [];
  try {
    result = await callAIWithJSON<{
      response: string;
      action?: { type: string; params: Record<string, any> } | null;
      actions?: { type: string; params: Record<string, any> }[];
    }>(systemPrompt, userContent, 'elite', conversationHistory);

    // Normalize actions — Opus sometimes uses "action", "name", or "tool"
    // instead of "type" for the action field. Handle all variants.
    if (result.actions && Array.isArray(result.actions) && result.actions.length > 0) {
      rawActions = result.actions.map((a: any) => ({
        type: a.type || a.action || a.name || a.tool || '',
        params: a.params || a.parameters || a.args || {},
      }));
    } else if (result.action) {
      const a = result.action as any;
      rawActions = [{ type: a.type || a.action || a.name || '', params: a.params || a.parameters || {} }];
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
        rawActions = result.actions.map((a: any) => ({
          type: a.type || a.action || a.name || a.tool || '',
          params: a.params || a.parameters || a.args || {},
        }));
      } else if (result.action) {
        const a = result.action as any;
        rawActions = [{ type: a.type || a.action || a.name || '', params: a.params || a.parameters || {} }];
      }
    }
  } catch (err) {
    console.error('[Partner] Opus call failed:', err);
    res.json({
      response: "I lost my train of thought for a second — try again?",
      actionResult: null,
      refreshNeeded: false,
      needsPageContent: false,
    });
    return;
  }

  // Log raw actions for debugging
  if (rawActions.length > 0) {
    console.log(`[Partner] Actions: ${rawActions.map(a => `${a.type}(${Object.keys(a.params || {}).join(',')})`).join(', ')}`);
  }

  // Check if Maria wants to read the page
  const normalizedActions = rawActions.map(a => ({
    ...a,
    type: ACTION_ALIASES[a.type] || a.type,
  }));

  if (normalizedActions.length === 1 && normalizedActions[0].type === 'read_page') {
    // Phase 1 hardening (Fix #3) — user message is persisted up-front, so
    // this branch no longer needs to store it. The page-content retry will
    // generate a fresh assistant reply on the second pass.
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
    // When Maria creates an offering + audience but stops short of building
    // a deliverable, the user is left waiting. Auto-chain build_deliverable
    // when both ingredients exist and the user has expressed deliverable intent
    // at ANY point in the conversation — not just via magic phrases.
    const createdOffering = dispatch.results.some(r => r.includes('Created offering'));
    const createdAudience = dispatch.results.some(r => r.includes('Created audience'));
    const alreadyBuilding = dispatch.results.some(r => r.includes('BUILD_STARTED'));
    const alreadyDraftedMFs = dispatch.results.some(r => r.includes('Drafted motivating factors'));
    const justCreatedSomething = createdOffering || createdAudience;

    // Re-query counts AFTER actions ran so we detect cross-message readiness
    const [postOfferingCount, postAudienceCount, existingStoryCount] = justCreatedSomething ? await Promise.all([
      prisma.offering.count({ where: { workspaceId } }),
      prisma.audience.count({ where: { workspaceId } }),
      prisma.fiveChapterStory.count({ where: { draft: { offering: { workspaceId } } } }),
    ]) : [offeringCount, audienceCount, 1];
    const bothReady = postOfferingCount > 0 && postAudienceCount > 0;

    // Check ALL user messages for deliverable intent — not just current message
    const allUserText = history.filter(m => m.role === 'user').map(m => m.content).join(' ') + ' ' + (message || '');
    const userWantsDeliverable = /do everything|show me the finished|work.*independent|do it all|build.*everything|email|pitch.*deck|one.?page|one.?pager|briefing|letter|report|write|send|draft|reach|something short|help me|need to|cold.*outreach|sell|buy|give|persuade|convince|message for|build it|build this/i.test(allUserText);

    if (justCreatedSomething && bothReady && !alreadyBuilding && existingStoryCount === 0 && userWantsDeliverable) {
      console.log('[Partner] Lead-mode continuation: offering + audience ready, user wants deliverable, chaining build');

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
        // Detect medium from ALL user messages in conversation
        let medium = 'email';
        if (/one.?page|one.?pager|briefing/i.test(allUserText)) medium = 'landing_page';
        else if (/pitch.*deck/i.test(allUserText)) medium = 'pitch_deck';
        else if (/report/i.test(allUserText)) medium = 'report';

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
            const mediumLabel = medium === 'landing_page' ? 'one-pager' : medium === 'pitch_deck' ? 'pitch deck' : medium;
            result.response += ` I have what I need. I'm building your ${mediumLabel} now — I'll bring you right to it when it's ready.`;
          }
        }
      }
    }
  }

  // ─── Fallback: build_deliverable failed because offering doesn't exist ──
  // When Maria asks quality questions first (no create actions) and then
  // fires build_deliverable on the next message, the offering/audience may
  // not exist yet. Detect this and auto-create + retry.
  const allMsgText = history.filter(m => m.role === 'user').map(m => m.content).join(' ') + ' ' + (message || '');
  const wantsDeliverable = /do everything|email|pitch.*deck|one.?page|briefing|letter|report|write|send|draft|reach|cold.*outreach|sell|buy|give|persuade|convince|message for|build it|build this/i.test(allMsgText);
  if (actionResult?.includes('Could not find the offering') && wantsDeliverable) {
    console.log('[Partner] build_deliverable failed — offering missing. Auto-creating and retrying.');
    const recentOffering = await prisma.offering.findFirst({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
    if (!recentOffering) {
      // Need to create offering + audience from scratch. Find the build_deliverable action params.
      const buildAction = normalizedActions.find(a => a.type === 'build_deliverable');
      if (buildAction) {
        const createActions: { type: string; params: Record<string, any> }[] = [
          { type: 'create_offering', params: { name: buildAction.params.offeringName || 'My Product', description: message || '' } },
          { type: 'create_audience', params: { name: buildAction.params.audienceName || 'Target Audience', description: message || '' } },
        ];
        const createDispatch = await dispatchActions(createActions, userId, ctx, workspaceId);
        if (createDispatch.results.some(r => r.includes('Created offering'))) {
          const retryDispatch = await dispatchActions([{ type: 'build_deliverable', params: buildAction.params }], userId, ctx, workspaceId);
          const retryResult = retryDispatch.results.join(' · ');
          actionResult = retryResult;
          if (retryResult.includes('BUILD_STARTED')) {
            const medium = buildAction.params.medium || 'email';
            const mediumLabel = medium === 'landing_page' ? 'one-pager' : medium === 'pitch_deck' ? 'pitch deck' : medium;
            result.response = result.response.replace(/I tried.*$/, '').trim();
            result.response += ` I have what I need. I'm building your ${mediumLabel} now — I'll bring you right to it when it's ready.`;
          }
          if (retryDispatch.refreshNeeded) refreshNeeded = true;
        }
      }
    }
  }

  // ─── Nuclear fallback: Maria refused to build despite having everything ──
  // If documents were attached, user specified audience + format, Maria
  // created nothing and didn't build — force creation and build from
  // Maria's response text (which contains her extraction of the documents).
  const hadDocuments = allAttachments.length > 0;
  const mariDidntBuild = !actionResult?.includes('BUILD_STARTED');
  const mariDidntCreate = !actionResult?.includes('Created offering') && !actionResult?.includes('Created audience');
  const noExistingWork = offeringCount === 0 && audienceCount === 0;

  if (hadDocuments && mariDidntBuild && mariDidntCreate && noExistingWork && wantsDeliverable && !actionResult?.includes('Could not find')) {
    console.log('[Partner] Nuclear fallback: Maria refused to build with documents. Forcing creation + build.');
    // Extract offering/audience names from Maria's response or use defaults
    const offeringName = message?.match(/about\s+([\w\s]+?)(?:\.|,|$)/i)?.[1]?.trim() || 'Product from Documents';
    const audienceName = message?.match(/(?:for|to)\s+(?:the\s+)?([\w\s]+?)(?:\.|,|$)/i)?.[1]?.trim() || 'Target Audience';

    let medium = 'email';
    if (/one.?page|one.?pager|briefing/i.test(allMsgText)) medium = 'landing_page';
    else if (/pitch.*deck/i.test(allMsgText)) medium = 'pitch_deck';
    else if (/report/i.test(allMsgText)) medium = 'report';

    const forceActions: { type: string; params: Record<string, any> }[] = [
      { type: 'create_offering', params: { name: offeringName, description: result.response || message || '' } },
      { type: 'create_audience', params: { name: audienceName, description: message || '' } },
    ];
    const forceDispatch = await dispatchActions(forceActions, userId, ctx, workspaceId);
    if (forceDispatch.results.some(r => r.includes('Created offering'))) {
      const recentOff = await prisma.offering.findFirst({ where: { workspaceId }, orderBy: { createdAt: 'desc' } });
      const recentAud = await prisma.audience.findFirst({ where: { workspaceId }, orderBy: { createdAt: 'desc' } });
      if (recentOff && recentAud) {
        const buildDispatch = await dispatchActions([{
          type: 'build_deliverable',
          params: { offeringName: recentOff.name, audienceName: recentAud.name, medium, situation: message || '' },
        }], userId, ctx, workspaceId);
        const buildResult = buildDispatch.results.join(' · ');
        actionResult = (actionResult || '') + ' · ' + forceDispatch.results.join(' · ') + ' · ' + buildResult;
        if (buildResult.includes('BUILD_STARTED')) {
          const mediumLabel = medium === 'landing_page' ? 'one-pager' : medium === 'pitch_deck' ? 'pitch deck' : medium;
          result.response += `\n\nI have what I need from your documents. I'm building your ${mediumLabel} now — I'll bring you right to it when it's ready.`;
        }
        if (buildDispatch.refreshNeeded) refreshNeeded = true;
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
      result.response = "Done — I've filled in the details on why each part of your product matters.";
    } else if (actionResult?.includes('Added') && actionResult?.includes('priorities')) {
      result.response = "Got it. Let me keep going.";
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

  // Store the assistant reply — serialize response with action result for history.
  // Phase 1 hardening (Fix #3) — user message was persisted before the Opus
  // call so any upstream failure doesn't lose what the user said. Only the
  // assistant row remains to be written here.
  const storedResponse = actionResult
    ? `${result.response}\n\n[${actionResult}]`
    : result.response;

  await prisma.assistantMessage.create({
    data: { userId, role: 'assistant', content: storedResponse, context: partnerChannel(workspaceId, ctx) },
  });

  console.log(`[Partner] RESPONSE: text=${(result.response || '').length}chars, actionResult=${(actionResult || '').length}chars, hasBuildStarted=${(actionResult || '').includes('BUILD_STARTED')}`);

  res.json({
    response: result.response,
    actionResult,
    refreshNeeded,
    needsPageContent: false,
    timeThresholdFired: timeThresholdFiredThisTurn,
  });
});

// POST /api/partner/page-content — fetch page content for Maria to read
router.post('/page-content', async (req: Request, res: Response) => {
  const { context } = req.body;
  const userId = req.user!.userId;
  const content = await readPageContent(req.workspaceId!, context || {});
  res.json({ content });
});

// Round E4 / Bug #5 — clear a specific pending detection so Maria stops
// re-surfacing it. Called by the frontend marker handlers after a
// successful APPLY_FOUNDATIONAL_SHIFT or SAVE_STYLE_RULE round-trip.
// Body: { kind: 'foundationalShift' | 'editPattern' }
router.post('/clear-pending', async (req: Request, res: Response) => {
  const kind = String(req.body?.kind || '');
  const userId = req.user!.userId;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { settings: true } });
  const settings = (user?.settings as Record<string, any>) || {};
  if (kind === 'foundationalShift') delete settings.pendingFoundationalShift;
  else if (kind === 'editPattern') delete settings.pendingEditPattern;
  else { res.status(400).json({ error: 'kind must be foundationalShift or editPattern' }); return; }
  await prisma.user.update({ where: { id: userId }, data: { settings } });
  res.json({ success: true });
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
