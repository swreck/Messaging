import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace } from '../middleware/workspace.js';
import { callAIWithJSON } from '../services/ai.js';
import { buildPartnerPrompt } from '../prompts/partner.js';
import { ACTION_ALIASES, dispatchActions, readPageContent, type ActionContext } from '../lib/actions.js';
import { getPersonalize, updatePersonalize, buildPersonalizeChatBlock } from '../lib/personalize.js';
import { getPartnerSettings } from '../lib/partnerSettings.js';
import {
  OPENER_FRESH_USER,
  OPENER_FRESH_USER_CHIPS,
  OPENER_FALLBACK_GENERIC,
  SKIP_DEMAND_RESPONSE,
  SKIP_DEMAND_CHIP_CONTINUE,
  SKIP_DEMAND_CHIP_AUTONOMOUS,
  SKIP_INTENT_PHRASES,
  buildAutonomousPreBuildExpectation,
  IDENTITY_ACKNOWLEDGMENT,
  IDENTITY_INTENT_PHRASES,
  pickAffirmation,
  FORMAT_QUESTION,
  FORMAT_CHIPS,
  PITCH_DECK_HONEST_FALLBACK,
  PITCH_DECK_FALLBACK_CHIP_KEEP,
  PITCH_DECK_FALLBACK_CHIP_SWITCH,
  mediumDisplayLabel,
} from '../prompts/milestoneCopy.js';
import { commitExistingForPipeline, runPipeline } from '../lib/expressPipeline.js';
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
// Phase 2 — getPartnerSettings was extracted to backend/src/lib/partnerSettings.ts
// so the background express pipeline can read the same persisted state. The
// import is at the top of this file. Behavior is unchanged.

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
          // Bundle 1A rev2 W5 — replaced methodology vocab "driver" with
          // market-truth framing. Also dropped the "[name]'s" possessive
          // which Cowork found awkward when the audience name contained a
          // company suffix ("Diagnostics's"). The replacement names the
          // audience plainly and offers the work without methodology jargon.
          proactiveOffer = `${audNoDriver.name} — I have what I need to draft. Want me to start?`;
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

  // Round 3.2 Item 5B — DROPPED per Cowork's verification call.
  // PATH_A_RETURN_ACKNOWLEDGMENTS pool was intended to fire on Path A
  // session-start; verification showed Round 4 Fix 11's audience-
  // anchored chat-open opener ("Back to the indie toy store owners?")
  // already covers return-user continuity for the same scenario.
  // Adding the ack pool on top would compete with Fix 11's opener for
  // the same screen real-estate. Dead-code-removed; Fix 11's behavior
  // is the canonical return-user signal.

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

  res.json({ username, displayName, introduced, introStep, returnContext, proactiveOffer, resumeDraft, consultation: settings.consultation });
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

  // Round 3.1 Item 1 — propagate the captured name to top-level settings
  // (consumed by auth.ts presentationNames for nav header and JWT
  // refresh) and rename the user's auto-created workspace if it's still
  // at the "Your Workspace" placeholder. Only renames a workspace where
  // this user is the SOLE owner — never touches a multi-member shared
  // workspace where another member's name might be the right title.
  const firstName = displayName.split(/\s+/)[0] || displayName;

  // Round 3.1 follow-up regression fix — advance the intro to INTRO_DONE
  // here. Pre-3.1 the time-budget step came after name capture and
  // advanced introStep to 4 itself; that step was removed in Round 4
  // Item 12 but the prior `Math.max(introStep, 1)` was left in place,
  // leaving fresh users stuck at introStep=1 with introduced=false.
  // Name capture IS the final intro step now — advance directly to 4
  // so OPENER_FRESH_USER fires on the next chat-open trigger.
  await prisma.user.update({
    where: { id: req.user!.userId },
    data: {
      settings: {
        ...current,
        displayName,
        firstName,
        partner: {
          ...current.partner,
          displayName,
          introStep: 4,
          introduced: true,
          lastVisitAt: new Date().toISOString(),
        },
      },
    },
  });

  // Rename the user's auto-created placeholder workspace, if any.
  try {
    const ownedPlaceholders = await prisma.workspace.findMany({
      where: {
        name: 'Your Workspace',
        members: { some: { userId: req.user!.userId, role: 'owner' } },
      },
      include: {
        _count: { select: { members: true } },
      },
    });
    for (const ws of ownedPlaceholders) {
      // Only rename solo workspaces — multi-member workspaces stay as-is
      // even if they happen to be at the placeholder name.
      if (ws._count.members === 1) {
        await prisma.workspace.update({
          where: { id: ws.id },
          data: { name: `${firstName}'s Workspace` },
        });
      }
    }
  } catch (err) {
    console.error('[Partner] workspace rename failed (non-fatal):', err);
  }

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

// PUT /api/partner/consultation — persist the "Let Maria lead" toggle state.
// Path-architecture refactor — Phase 1.
//
// Toggle semantics: 'on' = Path B / leadership mode (Maria fires milestone
// narration proactively), 'off' = Path A / support mode (Maria stays quiet
// unless asked). Source of truth is User.settings.partner.consultation so the
// toggle follows the user across devices. The frontend writes localStorage
// AND calls this endpoint on every toggle change (dual-write) so the
// device-local fast read stays in sync with the persisted state.
router.put('/consultation', async (req: Request, res: Response) => {
  const { value } = req.body as { value?: 'on' | 'off' };
  if (value !== 'on' && value !== 'off') {
    res.status(400).json({ error: 'value must be "on" or "off"' });
    return;
  }
  const userId = req.user!.userId;
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
        partner: {
          ...current.partner,
          consultation: value,
        },
      },
    },
  });
  res.json({ success: true, consultation: value });
});

// POST /api/partner/log-message — async persistence of locally-rendered chat.
// Phase 2 — used by the frontend for messages it renders instantly for
// snappy feel (mode-switch offer + chip outcome, toggle confirmations) and
// then writes back so the chat history is complete across reloads/devices.
// Constrained to a small allowlist of `kind` values; arbitrary content
// goes through the regular /message path.
router.post('/log-message', async (req: Request, res: Response) => {
  const { role, content, kind, ctx: ctxBody } = req.body as {
    role?: 'user' | 'assistant';
    content?: string;
    kind?: string;
    ctx?: ActionContext;
  };
  if ((role !== 'user' && role !== 'assistant')
      || typeof content !== 'string'
      || content.trim().length === 0) {
    res.status(400).json({ error: 'role and content are required' });
    return;
  }
  const ALLOWED_KINDS = new Set([
    'mode-switch-offer',
    'mode-switch-accept',
    'mode-switch-decline',
    'toggle-confirmation',
  ]);
  if (!kind || !ALLOWED_KINDS.has(kind)) {
    res.status(400).json({ error: 'unknown or missing kind' });
    return;
  }
  const userId = req.user!.userId;
  const wsId = req.workspaceId!;
  const safeCtx: ActionContext = ctxBody || {};
  const channelCtx: Record<string, any> = { channel: 'partner', workspaceId: wsId, kind };
  if (safeCtx.storyId) channelCtx.storyId = safeCtx.storyId;
  if (safeCtx.draftId) channelCtx.draftId = safeCtx.draftId;
  if (safeCtx.audienceId) channelCtx.audienceId = safeCtx.audienceId;
  if (safeCtx.offeringId) channelCtx.offeringId = safeCtx.offeringId;
  try {
    await prisma.assistantMessage.create({
      data: {
        userId,
        role,
        content: content.slice(0, 5000),
        context: channelCtx,
      },
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[Partner] log-message failed:', err);
    res.status(500).json({ error: 'persist failed' });
  }
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
  // Cowork follow-up #2 — surface persisted chips on assistant rows so
  // chips survive a panel close/reopen and show up after history reload.
  // Cowork follow-up #6 — surface kind so the frontend can identify
  // chat-open openers if it ever needs to (today the backend already
  // sweeps stale openers; this is forward-compatible).
  const messages = filtered
    .slice(0, 200)
    .map(({ role, content, createdAt, context }) => {
      const ctx = (context as any) || {};
      const out: {
        role: string;
        content: string;
        createdAt: Date;
        chips?: string[];
        kind?: string;
        autonomousDraftId?: string;
        autonomousStoryId?: string;
        autonomousDeliverableType?: string;
      } = { role, content, createdAt };
      if (Array.isArray(ctx.chips) && ctx.chips.length > 0) out.chips = ctx.chips;
      if (typeof ctx.kind === 'string') out.kind = ctx.kind;
      // Round 3.1 Item 2 — surface the autonomous-post-delivery draftId
      // so YES chip click can navigate to /three-tier/{draftId} without
      // an extra round-trip.
      if (typeof ctx.autonomousDraftId === 'string') out.autonomousDraftId = ctx.autonomousDraftId;
      if (typeof ctx.autonomousStoryId === 'string') out.autonomousStoryId = ctx.autonomousStoryId;
      if (typeof ctx.autonomousDeliverableType === 'string') out.autonomousDeliverableType = ctx.autonomousDeliverableType;
      return out;
    });
  messages.reverse();
  res.json({ messages });
});

// POST /api/partner/message — send a message and get Maria's response
// Optionally accepts an attachment: { data: base64string, mimeType: string, filename: string }
// Images are sent to Claude via vision. PDFs and text files are extracted and prepended.
router.post('/message', partnerLimiter, async (req: Request, res: Response) => {
  const { message, context, attachment, attachments: rawAttachments, timeContext, voicePersistentIntent, websiteResearchOffered, overBudgetAcknowledged, consultation: bodyConsultation, trigger } = req.body as {
    message?: string;
    context?: ActionContext;
    attachment?: { data: string; mimeType: string; filename: string };
    attachments?: { data: string; mimeType: string; filename: string }[];
    // Chat-open proactive opener — frontend posts this trigger when the chat
    // panel mounts with the "Let Maria lead" toggle on. Skips user-message
    // validation + persistence; augments the system prompt with a CHAT_OPEN
    // block; instructs Opus to greet + ask one question + offer 2-3 chips.
    trigger?: 'chat-open';
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
    // Cowork follow-up #3 — once-per-session over-budget acknowledgement.
    // Frontend writes 'over-budget-ack-{date}' to localStorage after the
    // first over-budget message lands; sends true here on every subsequent
    // turn so the backend suppresses the alert from re-firing.
    overBudgetAcknowledged?: boolean;
    // Path-architecture refactor — Phase 1. Frontend includes the user's
    // current "Let Maria lead" toggle state on every turn so the route can
    // read it for that turn's logic (gating proactive milestone narration
    // when Phase 3 lands). Body value is informational; persistence is
    // handled by PUT /partner/consultation. If absent, the route falls back
    // to the persisted User.settings.partner.consultation value.
    consultation?: 'on' | 'off';
  };
  // Normalize: single attachment or array of attachments
  const allAttachments: { data: string; mimeType: string; filename: string }[] =
    rawAttachments || (attachment ? [attachment] : []);
  const isChatOpen = trigger === 'chat-open';
  if (!isChatOpen && !message && allAttachments.length === 0) {
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

  // Get user's display name and persisted consultation state.
  // Phase 1 of the path-architecture refactor — `effectiveConsultation` is
  // the toggle state the route layer should use for THIS turn's logic.
  // Body wins when present (frontend just flipped the toggle and is sending
  // through), persisted User.settings wins when absent. Phase 3 will read
  // this constant to gate proactive milestone narration; in Phase 1 it is
  // resolved but not yet consumed by downstream logic.
  const { displayName, consultation: persistedConsultation } = await getPartnerSettings(userId);
  const effectiveConsultation: 'on' | 'off' =
    (bodyConsultation === 'on' || bodyConsultation === 'off')
      ? bodyConsultation
      : persistedConsultation;
  void effectiveConsultation; // Phase 1: resolved, awaiting Phase 3 consumer.

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
  // isNewUser fires the NEW USER GUIDANCE block in the locked methodology
  // file. That block is intended for the very first message of a fresh
  // conversation. Without the history.length === 0 gate, the block was
  // re-injecting on every turn (since the DB stayed empty until Maria
  // fired create_offering / create_audience), and its repeated assertion
  // that "this user has no offerings or audiences yet" was pulling Opus
  // toward "treat every brief reply as if the user is just starting" —
  // which manifested as the demo38 / demo40 conversation-memory failure
  // (Maria denying the conversation, reverting to the opener question).
  // Gating on history.length === 0 keeps the block firing only when it
  // should: the very first message in a conversation.
  const isNewUser = history.length === 0 && offeringCount === 0 && audienceCount === 0;
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

  // Chat-open proactive opener — augment the system prompt so Opus speaks
  // first when the panel mounts with "Let Maria lead" on. The rule below is
  // the SINGLE rule the implementation obeys: Maria asks; the user answers.
  // No methodology / prompt / evaluator file is touched — this block is a
  // runtime addition only, same pattern as voicePersistentIntent above.
  if (isChatOpen) {
    const introducedAlready = !!(await getPartnerSettings(userId)).introduced;

    // Recent deliverables — top 3 across drafts and stories by updatedAt.
    const [recentDrafts, recentStories] = await Promise.all([
      prisma.threeTierDraft.findMany({
        where: { offering: { workspaceId } },
        orderBy: { updatedAt: 'desc' },
        take: 5,
        select: { id: true, updatedAt: true, offering: { select: { name: true } }, audience: { select: { name: true } } },
      }),
      prisma.fiveChapterStory.findMany({
        where: { draft: { offering: { workspaceId } } },
        orderBy: { updatedAt: 'desc' },
        take: 5,
        select: {
          id: true,
          updatedAt: true,
          customName: true,
          medium: true,
          draft: { select: { offering: { select: { name: true } }, audience: { select: { name: true } } } },
        },
      }),
    ]);
    type RecentItem = { kind: '3T' | '5CS'; title: string; updatedAt: Date; ageDays: number };
    const now = Date.now();
    const recentItems: RecentItem[] = [
      ...recentDrafts.map(d => ({
        kind: '3T' as const,
        title: `${d.offering?.name || 'Offering'} → ${d.audience?.name || 'Audience'}`,
        updatedAt: d.updatedAt,
        ageDays: Math.floor((now - d.updatedAt.getTime()) / 86400000),
      })),
      ...recentStories.map(s => {
        const offeringName = s.draft?.offering?.name || 'offering';
        const audienceName = s.draft?.audience?.name || 'audience';
        const fallbackTitle = `${s.medium || 'story'} — ${offeringName} → ${audienceName}`;
        return {
          kind: '5CS' as const,
          title: s.customName?.trim() || fallbackTitle,
          updatedAt: s.updatedAt,
          ageDays: Math.floor((now - s.updatedAt.getTime()) / 86400000),
        };
      }),
    ].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).slice(0, 3);

    const mostRecentAgeDays = recentItems.length > 0 ? recentItems[0].ageDays : null;
    const onDeliverablePage = !!(ctx.draftId || ctx.storyId);

    // Resolve user state for the prompt block. Four canonical states.
    let stateLabel: 'first-time' | 'in-deliverable' | 'returning-active' | 'returning-stale';
    if (!introducedAlready && recentItems.length === 0) {
      stateLabel = 'first-time';
    } else if (onDeliverablePage) {
      stateLabel = 'in-deliverable';
    } else if (mostRecentAgeDays !== null && mostRecentAgeDays <= 7) {
      stateLabel = 'returning-active';
    } else {
      stateLabel = 'returning-stale';
    }

    // Round 4 Fix 11 — graduated chat-open opener length by user activity.
    // Returning-active splits into "very recent" (≤1 day, short audience-
    // anchored question) and "moderately recent" (2-7 days, brief time
    // acknowledgment + audience-anchored question). Returning-stale keeps
    // the dense recap.
    const returningSubLabel: 'very-recent' | 'moderately-recent' =
      stateLabel === 'returning-active' && mostRecentAgeDays !== null && mostRecentAgeDays <= 1
        ? 'very-recent'
        : 'moderately-recent';
    const stateBlock =
      stateLabel === 'first-time'
        ? `STATE: first-time user, empty workspace. Phase 2 — your reply this turn is EXACTLY the locked fresh-user opener, character-for-character, no edits, no rewording, no warmup before, no extension after:

"${OPENER_FRESH_USER}"

Then 4 chips on their own lines AT THE END, in the user's voice. Use these canonical chips, in this exact order, character-for-character:
${OPENER_FRESH_USER_CHIPS.map(c => `  [CHIP: ${c}]`).join('\n')}

Do not paraphrase the opener. Do not add any other content. The text quoted above is Cowork-authored and locked.`
        : stateLabel === 'in-deliverable'
        ? `STATE: user is INSIDE a specific deliverable right now (${ctx.draftId ? 'a Three Tier' : 'a Five Chapter Story'}${ctx.storyId ? ` — story id ${ctx.storyId}` : ctx.draftId ? ` — draft id ${ctx.draftId}` : ''}). Open by naming the SINGLE BIGGEST CURRENT GAP on this deliverable in plain language, then ASK whether they want to start there. Then exactly 2 chips on their own lines AT THE END:
  [CHIP: Yes, start there]
  [CHIP: Show me something else here]

Do not number these as "1." / "2." in the prose — they must appear as [CHIP: ...] markers, one per line.`
        : stateLabel === 'returning-active' && returningSubLabel === 'very-recent'
        ? `STATE: returning user, very recent activity (≤1 day).
Open with a short audience-anchored question and 2 chips.
Format: "Back to the [audience name]?"
Use the most recent draft's audience name verbatim from this list:
${recentItems.map((r, i) => `  ${i + 1}. ${r.title} (${r.kind}, ${r.ageDays}d ago)`).join('\n')}

Then exactly 2 chips on their own lines:
  [CHIP: Yes, pick it up]
  [CHIP: Something else]

Do not add any other prose. The reply is one short question and two chips. That's it.`
        : stateLabel === 'returning-active'
        ? `STATE: returning user, moderately recent activity (2-7 days).
Open with a brief time acknowledgment + audience-anchored question + 3 chips.
Format: "It's been a few days — back to the [audience name]?"
Use the most recent draft's audience name verbatim from this list:
${recentItems.map((r, i) => `  ${i + 1}. ${r.title} (${r.kind}, ${r.ageDays}d ago)`).join('\n')}

Then exactly 3 chips on their own lines:
  [CHIP: Yes, pick it up]
  [CHIP: Start something new]
  [CHIP: Something else]

Do not add any other prose.`
        : `STATE: returning user, gone for a while. Their most recent work was ${mostRecentAgeDays === null ? 'never' : `${mostRecentAgeDays} days ago`}. Open by acknowledging the return briefly (one short sentence) and ASK whether they want to pick something up or build something new. Then 3-4 chips on their own lines AT THE END — use the ${Math.min(3, recentItems.length)} most-recently touched titles verbatim plus "Build something new". Format each chip as [CHIP: chip text] on its own line — never as a numbered list. Recent items:
${recentItems.length === 0 ? '  (none)' : recentItems.map((r, i) => `  ${i + 1}. ${r.title} (${r.kind}, ${r.ageDays}d ago)`).join('\n')}`;

    systemPrompt += `\n\nCHAT-OPEN PROACTIVE OPENER — FIRST AND ONLY ACTION THIS TURN.

HARD CONSTRAINT: never name any offering, audience, draft, or other proper-noun reference that is not explicitly in the data list provided to you below. If you don't have a specific name for what the user was working on, say "your most recent work" or "what you started yesterday" — never invent a name to make the greeting feel state-aware.

THE RULE you must obey: Maria asks; the user answers. The chat panel just opened; the user has NOT typed anything. Your reply IS the user's first three seconds in this session, so it must:
  1. Be in your voice — warm, peer, never sales.
  2. Be ONE message: at most one short context sentence, then ONE specific question grounded in the user's actual situation below.
  3. Never tell the user to type something or "let me know" — you are asking; they answer.
  4. End with reply chips. Format chips as standalone lines AT THE END of your response, each on its own line, exactly like this:
     [CHIP: chip text 1]
     [CHIP: chip text 2]
  5. Chips are the user's likely answers in the USER'S voice, never yours. Tap-sized, specific to the question above. 2-4 chips total.
  6. Do NOT format options as a numbered list inside the prose ("1. ...\n2. ..."). Options are chips on their own lines using the [CHIP: ...] marker — every time.

DO NOT take any actions, build any deliverables, or call any tools this turn. The user has not asked for anything. Your only job is to greet and ask.

${stateBlock}

Output JSON shape: { "response": "<your reply, ending with [CHIP: ...] lines>", "action": null, "actions": [] }`;
  }

  // CONVERSATION INTEGRITY RULE — placed at the TOP of the system prompt
  // (prepended) so it dominates Opus's attention. Without this dominance,
  // the locked methodology's onboarding-mode language ("this user has no
  // offerings or audiences yet") was winning over the conversation
  // history that Opus could see in the messages array — Opus was siding
  // with the system prompt's "no context" assertion against the
  // messages-array reality, producing replies like "this appears to be
  // our first exchange" mid-conversation. Putting integrity first
  // re-anchors Opus on the conversation as the source of truth.
  if (history.length > 0) {
    const integrityBlock = `CONVERSATION INTEGRITY — THIS RULE OVERRIDES EVERYTHING BELOW.

The conversation history attached to this turn (the messages array sent with this request) is REAL, AUTHORITATIVE, and complete. It contains every word the user has typed and every reply you have given in this session. You CAN see it. You MUST use it.

Hard rules:
  1. Before composing your reply, read the conversation history. Anything the user has already told you — offering, audience, value story, format, occasion, stakeholder, brief or detailed — is ESTABLISHED. Do not re-ask it. Build on it.
  2. Brief user replies (a few words, a single phrase, a fragmentary answer) are CONTINUATIONS of the established context, not signs of uncertainty. Treat a 5-word reply the same way as a 50-word reply: more information on top of what's already known. Never interpret brevity as a reason to revert to the opener question.
  3. NEVER say "this appears to be our first exchange," "I don't see any prior messages," "this looks like the start of our conversation," "I don't have any prior messages from you," or any equivalent. These statements are LIES if there is conversation history attached, and there always is on every turn after the first. Saying them gaslights the user and ends their trust in this product permanently. If you ever feel the urge to say one of these phrases, STOP — re-read the messages array — answer based on what's actually there.
  4. If the user references something they said earlier ("didn't I already explain", "I told you above", "as I said"), they are correct. Find what they referenced in the conversation history and acknowledge it directly. The user is never wrong about whether they sent a message — your job is to find it and use it.
  5. If the system prompt below says "this user has no offerings or audiences yet" (or any similar database-state claim), that refers ONLY to the database. It does NOT mean the conversation is empty. The user may have richly described an offering and audience IN THIS CONVERSATION without those rows being committed to the database yet. Treat the conversation as the source of truth for what's been described; the database is downstream.

This rule supersedes all guidance below it. Always.

`;
    systemPrompt = integrityBlock + systemPrompt;
  }

  // ─── Bundle 1A rev2 W6 — thin-audience-input gate ────────────────────
  // Cowork's walk: clicking an audience-suggestion chip ("A VP of Sales
  // at a tech company") got an affirming "Right there — that's clean.
  // What are you offering them?" response. False claim of comprehension
  // from no real input. The Bug 7 [TOO_THIN] route lives in coaching.ts
  // (guided-3T flow) — partner.ts (Maria-leads flow) needs the same gate.
  //
  // Detection: previous user message is short AND reads as title-only or
  // generic role-only ("A [title] at a [company-type]" shape). When
  // detected, inject a directive that forbids affirming-paraphrase AND
  // forbids advancing to the next methodology question — Maria must ask
  // the locked clarifying question instead.
  {
    const lastUserMsg = (message || '').trim();
    function isThinAudienceInput(msg: string): boolean {
      if (!msg) return false;
      if (msg.length > 100) return false; // genuine prose answers are usually longer
      const lower = msg.toLowerCase();
      // Pattern: "A [title]" or "An [title]" or "The [title]" with optional
      // "at a [generic-company-shape]" suffix. The title is one of the
      // common executive/manager shapes; the optional suffix is generic
      // ("a tech company", "a mid-size company", "a SaaS startup").
      const titleShape = /^(?:a|an|the)?\s*(?:vp|svp|evp|chief|c[a-z]o|director|head of|manager|lead|principal|senior\s+)?\s*(?:of\s+)?(?:sales|marketing|engineering|product|operations|customer\s+success|finance|hr|people|it|technology|security|legal|partnerships|growth|revenue|strategy|design|data|research|content|brand|business\s+development)\b/i;
      const titleOnly = titleShape.test(lower) && msg.split(/\s+/).length < 12;
      // "VP of Sales", "Director of Engineering", "Head of Product" — bare
      // titles, no company specifics.
      if (titleOnly) return true;
      // "IT director", "CFO", "Chief of Staff" — short executive shorthands.
      if (/^(?:[a-z]+\s+)?(?:vp|svp|cfo|ceo|coo|cto|cmo|cio|cdo|cpo|cso|director|manager|lead|chief\s+of\s+staff)\b/i.test(lower) && msg.split(/\s+/).length < 8) {
        return true;
      }
      return false;
    }
    if (isThinAudienceInput(lastUserMsg)) {
      systemPrompt += `\n\nTHIN AUDIENCE INPUT DETECTED — ASK CLARIFYING QUESTION, DO NOT ADVANCE.

The user's last message ("${lastUserMsg.replace(/"/g, '\\"')}") is title-only or generic role-only — it names a title and possibly a vague company shape, but does not name: a tool the persona uses, a pain they live with, a metric they own, what their week actually looks like, who reports to them, or what specifically keeps them up at night.

You MUST NOT:
  - Issue any affirming-paraphrase response ("I know what keeps them up at night", "I know that persona well", "Right there — that's clean", or any locked affirmation pool entry).
  - Advance to the next methodology question (do not ask about the offering, format, differentiation, or CTA).
  - Pretend you have enough to work with.

You MUST ask the LOCKED clarifying question, parameterizing over the title the user named:

"An ${lastUserMsg.replace(/^(?:a|an|the)\s+/i, '').replace(/"/g, '\\"')} — got it on title. Tell me a bit more about them. What kind of company, what size of team, what's actually keeping them up at night right now?"

Render the locked text above. After the question, emit reply chips per the universal rule.

Bundle 1A rev6 Phase 5 — affirmation gate completeness:

On this turn ONLY: do NOT begin your reply with any affirmation, validation, or acknowledgment phrase. Begin directly with the locked clarifying question — "A [title] — got it on title. Tell me a bit more about them. What kind of company, what size of team, what's actually keeping them up at night right now?" Do NOT say "That tracks," "Got it," "Crisp," "Right there," or any equivalent. These phrases reinforce a false claim of understanding when the audience input is too thin for understanding to be possible.`;
    }
  }

  // ─── Round 3.4 coaching-fix Finding 4 — locked question order ────────
  // When the user just clicked a starting chip (the four entry chips
  // OPENER_FRESH_USER_CHIPS surfaces on chat-open), the next methodology
  // question is locked: AUDIENCE first, then offering, then format,
  // then differentiation, then CTA. Bug 1's medium normalizer does not
  // resolve this — Cowork's walks confirmed Maria asks the offering
  // first deterministically. We inject a system-prompt directive when
  // the previous user message matches one of the four starting chips.
  // The locked methodology prompt file (prompts/partner.ts) is not
  // modified — this is a route-level runtime augmentation.
  {
    const STARTING_CHIPS_LOWER = OPENER_FRESH_USER_CHIPS.map(c => c.trim().toLowerCase());
    const lastUserMsg = (message || '').trim().toLowerCase();
    const userJustClickedStartingChip = STARTING_CHIPS_LOWER.includes(lastUserMsg);
    if (userJustClickedStartingChip) {
      systemPrompt += `\n\nLOCKED QUESTION ORDER — STARTING-CHIP CLICK DETECTED.

The user just clicked a starting chip ("${(message || '').trim()}"). The next methodology question is LOCKED to AUDIENCE — do not ask about the offering, format, differentiation, or CTA on this turn. Ask one question only, and that question is about the audience: "Who's the person you're writing to?" or a close paraphrase ("Who are you trying to win over?", "Who are you writing this for?").

After the user answers the audience question, the locked sequence continues:
  Turn 1 (this turn): AUDIENCE
  Turn 2: OFFERING ("Tell me about what you're offering" or close paraphrase)
  Turn 3: FORMAT (with the format chips per Bug 1)
  Turn 4: DIFFERENTIATION ("What makes the offering special?")
  Turn 5: CTA ("What's the ask?")

Do NOT skip ahead. Do NOT consolidate two questions into one turn (Round 3.4 coaching-fix Finding 6 — never combine methodology questions with "and", "plus", or any joining clause). Each methodology turn asks exactly ONE question.`;
    }
  }

  // ─── Round 3.4 coaching-fix Finding 6 — universal no-stacking rule ───
  // Cowork observed Maria stacking methodology questions intermittently
  // ("Who's the person you're writing to? And what's the format?",
  // "What's the ask? And is there a specific commercial offer?"). Hard
  // rule: ONE methodology question per turn, never two combined with
  // "and" or any joining clause. Applies across the whole coaching flow
  // (not just the starting-chip turn).
  systemPrompt += `\n\nONE METHODOLOGY QUESTION PER TURN — UNIVERSAL RULE.

Every coaching turn asks exactly ONE methodology question. Never combine two methodology questions with "and", "plus", "also", "additionally", a comma plus a second question, or any joining clause. If the next two methodology questions feel naturally adjacent, ask the more important one this turn and let the second come on the next turn.

Examples that are FORBIDDEN (each combines two questions into one turn):
  ❌ "Who's the person you're writing to? And what's the format?"
  ❌ "What's the ask? And is there a specific commercial offer?"
  ❌ "What makes this offering special, and what's your timeline?"
  ❌ "Who is this for? Plus, what format do you need?"

Examples that are ALLOWED (single question, possibly with a clarifying example):
  ✓ "Who's the person you're writing to?"
  ✓ "What format do you need? Pick whichever fits — I can build any of these."
  ✓ "What's the ask? What do you want them to do?"  ← Same question, two phrasings, allowed.

The chip-emission rule below requires reply chips after each question. Both rules combine: ONE question, with chips, per turn.`;

  // Cowork follow-up #2 — UNIVERSAL CHIP-EMISSION RULE.
  // Every Maria turn that ends with a question must emit reply chips so the
  // user can tap rather than invent an opening sentence. Applied as a
  // runtime augmentation; the locked methodology file is untouched.
  systemPrompt += `\n\nREPLY CHIPS — UNIVERSAL RULE.

Every response of yours that ends with a question (open or closed) MUST end with at least 2 chip markers, formatted EXACTLY like this, each on its own line at the very end of your response:
  [CHIP: chip text 1]
  [CHIP: chip text 2]

Chips are pre-typed reply buttons. Their text is what the USER would say back to you, in the user's voice — NOT yours. They are short (under 10 words ideally), specific to your question, and natural for a senior professional to tap.

  - If your question has natural binary options (yes/no, do/don't, this/that), emit those two as chips in the user's voice.
  - If your question is open-ended, emit 2-4 sentence-length chips covering the most likely user replies. The user can always type their own — chips are there so they don't have to.
  - If your turn does NOT end with a question (you are stating a fact, confirming an action, narrating progress), do NOT emit chips.
  - Chip text never says "Yes Maria" or "Maria, please" — write it as the user's words, no addressee.
  - Chips are ALWAYS the very last thing in your response, after the question.`;

  // Round 3.2 follow-up Regression 2 (round 2) — strictest version per
  // Cowork's recommendation. Pre-pick the affirmation and REQUIRE Opus
  // to begin its reply with that exact text. The prior soft variant
  // ("if you would have begun with an affirmation…") gave Opus an
  // out and it kept reverting to "actually really clear". Always-fire
  // pattern matches the buildAutonomousPreBuildExpectation pattern that
  // verified clean (Item 1).
  {
    const chosenAffirmation = pickAffirmation();
    systemPrompt += `\n\nAFFIRMATION DIRECTIVE — REQUIRED PREFIX. Begin your reply with this exact text, no edits, no additions, no surrounding wrapper words: "${chosenAffirmation}" Then continue with your next question or statement on the next line. FORBIDDEN before, replacing, or wrapping the affirmation: "actually really clear", "actually really" + any adjective, "great point", "excellent", "that's really helpful", "perfect", any "actually" softener, any compliment-then-pause pattern. The affirmation above is the ONLY opening this reply may have. Do NOT vary it. Do NOT skip it. Do NOT add a comma, ellipsis, or "and" between it and the next sentence — just put the next sentence on its own line.`;
  }

  // (The "first message broad framing" runtime override that previously
  // lived here was dropped once the locked NEW USER GUIDANCE block in
  // prompts/partner.ts was rewritten to broaden the opener directly.
  // Two voices for the same situation produced redundant guidance; the
  // single source of truth is the methodology file.)

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
    // Cowork follow-up #3 — `overBudgetAcknowledged` is a belt-and-suspenders
    // gate keyed by date in localStorage on the frontend. Even if
    // thresholdTriggered somehow gets unset (cleared cache, fresh tab), this
    // flag persists for the day and prevents the alert from re-hijacking the
    // conversation on every turn.
    const crossedThreshold = pctElapsed >= 0.8 && !timeContext.thresholdTriggered && !overBudgetAcknowledged;
    if (crossedThreshold) {
      timeThresholdFiredThisTurn = true;
      systemPrompt = `TIME THRESHOLD ALERT — surface this NOW, in this turn, before any other content:
[TIME_THRESHOLD_REACHED: elapsed=${elapsedMin}min, budget=${budgetMin}min, remaining=${remainingMin}min]

The user set a ${budgetMin}-minute budget at session start. They've used ${elapsedMin} minutes; ${remainingMin} remaining. Surface the threshold-intervention with elapsed/done/remaining/two-paths framing using these EXACT numbers. Voice: partnership, not surveillance. Example shape: "${remainingMin} minutes left in your budget. Where we are: [what's done]. Two paths — [ship now with the lighter version] or [push past your budget by ~${Math.round(remainingMin * 1.5)} minutes to do them properly]. What's the call?"

End your response with these exact 3 chips on their own lines (per the UNIVERSAL CHIP RULE), in the user's voice:
[CHIP: Keep going as planned]
[CHIP: Wrap up faster]
[CHIP: Stop here, save what we have]

After this turn, the frontend marks thresholdTriggered=true AND writes a localStorage acknowledgement so this alert never re-fires this session — even if the user blows past budget further.

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
  // Chat-open: synthesize a one-token user turn so Opus has something to
  // respond to. The turn is NEVER persisted (see persistence guard below),
  // so it doesn't pollute history; it only exists to give Opus a turn-shape.
  let userContent: string | any[] = isChatOpen ? '[CHAT_OPENED]' : (message || '');
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
  // Chat-open: do NOT persist a user row. The opener is unprompted; the
  // user has not typed anything. Only the assistant reply persists below.
  //
  // Cowork follow-up #7 — defense-in-depth. Skip user-row persist for any
  // synthetic-marker payload ([OPEN_ON_PAGE], [STATE_RECAP], [CHAT_OPENED],
  // [PRE_CHAPTER_4:...], etc). These are routing tokens emitted by the
  // frontend on its own behalf, not the user's words. Persisting them
  // pollutes the user's chat history with messages they didn't type.
  const SYNTHETIC_USER_MARKER = /^\s*\[[A-Z_]+(?:\s*:[^\]]*)?\]\s*$/;
  const isSyntheticUserPayload = SYNTHETIC_USER_MARKER.test(userQuestion);
  if (!isChatOpen && !isSyntheticUserPayload) {
    await prisma.assistantMessage.create({
      data: { userId, role: 'user', content: userQuestion, context: partnerChannel(workspaceId, ctx) },
    });
  }

  // Round 3 fix — skip-demand short-circuit. If the user typed a phrase
  // explicitly demanding to bypass coaching, return the locked response
  // (Cowork-authored) with the two locked chips. Routing of those chips
  // is deferred to Opus on the next user turn — the CONTINUE chip reads
  // as "keep coaching" and the AUTONOMOUS chip reads as a build directive
  // that already maps to existing PRE-BUILD READINESS rules in partner.ts.
  // Chip text is intentionally distinct from the phrase list so taps
  // don't re-trigger the short-circuit.
  if (!isChatOpen && !isSyntheticUserPayload && message) {
    const normalized = message.trim().toLowerCase().replace(/[.!?,;:]/g, '');
    const isSkipDemand = SKIP_INTENT_PHRASES.some(phrase => normalized.includes(phrase));
    if (isSkipDemand) {
      const skipChips = [SKIP_DEMAND_CHIP_CONTINUE, SKIP_DEMAND_CHIP_AUTONOMOUS];
      const skipCtx = { ...partnerChannel(workspaceId, ctx), chips: skipChips, kind: 'skip-demand-response' };
      await prisma.assistantMessage.create({
        data: { userId, role: 'assistant', content: SKIP_DEMAND_RESPONSE, context: skipCtx },
      });
      res.json({
        response: SKIP_DEMAND_RESPONSE,
        chips: skipChips,
        actionResult: undefined,
        refreshNeeded: false,
        needsPageContent: false,
        timeThresholdFired: false,
      });
      return;
    }

    // Round 3.2 Item 11 — identity-question short-circuit. When the user
    // asks "Are you AI?" / "What model?" / "Who built you?" or similar,
    // Maria answers verbatim with IDENTITY_ACKNOWLEDGMENT instead of
    // sidestepping. Same short-circuit pattern as skip-demand: write
    // locked text directly, skip Opus. The user's next message picks
    // up normal Opus flow with full conversation context, so the
    // bridging back to work happens naturally on the next turn.
    const isIdentityQuestion = IDENTITY_INTENT_PHRASES.some(phrase => normalized.includes(phrase));
    if (isIdentityQuestion) {
      const identityCtx = { ...partnerChannel(workspaceId, ctx), kind: 'identity-acknowledgment' };
      await prisma.assistantMessage.create({
        data: { userId, role: 'assistant', content: IDENTITY_ACKNOWLEDGMENT, context: identityCtx },
      });
      res.json({
        response: IDENTITY_ACKNOWLEDGMENT,
        actionResult: undefined,
        refreshNeeded: false,
        needsPageContent: false,
        timeThresholdFired: false,
      });
      return;
    }
  }

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

    // Phase 1 cleanup — persist the friendly fallback as an assistant row
    // so we don't leave orphan user rows on the failure path. One
    // fallbackText variable so the persisted content and the response
    // payload can't drift. Defensive nested try/catch: if the DB write
    // itself fails (pool exhausted, etc.) we still return the user-facing
    // reply.
    const fallbackText = "I lost my train of thought for a second — try again?";

    try {
      await prisma.assistantMessage.create({
        data: {
          userId,
          role: 'assistant',
          content: fallbackText,
          context: partnerChannel(workspaceId, ctx),
        },
      });
    } catch (persistErr) {
      console.error('[Partner] Failed to persist Opus-failure fallback row:', persistErr);
    }

    res.json({
      response: fallbackText,
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

  // Chat-open short-circuit. The opener never takes actions; if Opus
  // returned any (against instructions), drop them. Parse [CHIP: ...]
  // markers from the response, strip them from the visible text, persist
  // the assistant row tagged kind:'chat-open-opener', and return.
  //
  // Cowork follow-up #6 — before persisting the new opener, delete any
  // prior chat-open-opener rows for this user/workspace. This keeps stale
  // page-context openers from stacking up in the panel as the user
  // navigates between pages within the same session.
  if (isChatOpen) {
    // Phase 2 — server-side guarantee for the fresh-user opener. If the
    // workspace is empty (first-time path), force the visible text to the
    // locked OPENER_FRESH_USER regardless of what Opus emitted. Chips from
    // Opus are kept (Universal Chip Rule); on the rare empty-chip case we
    // fall back to the canonical four chips from milestoneCopy.
    const isFirstTime = offeringCount === 0 && audienceCount === 0;
    if (isFirstTime) {
      const fallbackChipMarkers = OPENER_FRESH_USER_CHIPS.map(c => `[CHIP: ${c}]`).join('\n');
      result.response = `${OPENER_FRESH_USER}\n${fallbackChipMarkers}`;
    }

    // Round 4 Fix 1 Part B — fabrication validator. Pull every proper-
    // noun phrase from Opus's chat-open prose and check it against the
    // workspace's actual offerings, audiences, and deliverable titles.
    // If anything fails the allowlist (e.g. an invented "RouteLens"
    // product name), fall back to the locked generic opener so trust
    // doesn't rupture in Maria's most trust-sensitive moment.
    if (!isFirstTime) {
      try {
        const proseOnly = (result.response || '').replace(/\[CHIP:[^\]]*\]/g, ' ');
        // Multi-word capitalized sequences ("Grocery Fleet Operations Director")
        // and CamelCase single tokens ("RouteLens", "FleetOps") are the
        // high-risk fabrication shapes. Single capitalized words at sentence
        // boundaries are usually English (Welcome, OK) and are skipped.
        const multiWordRe = /\b[A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+)+\b/g;
        const camelCaseRe = /\b[A-Z][a-z]+[A-Z][a-zA-Z0-9]*\b/g;
        const candidates = new Set<string>();
        let m: RegExpExecArray | null;
        while ((m = multiWordRe.exec(proseOnly)) !== null) candidates.add(m[0]);
        while ((m = camelCaseRe.exec(proseOnly)) !== null) candidates.add(m[0]);

        if (candidates.size > 0) {
          // Build the allowlist from real workspace data: offering names,
          // audience names, all story custom names, plus the user's own
          // first name. recentItems from the prompt-build block is out of
          // scope here; pulling fresh data is a few cheap queries that
          // only run when the validator finds candidate proper-noun
          // phrases (i.e. rarely).
          const [allOfferings, allAudiences, allStories] = await Promise.all([
            prisma.offering.findMany({
              where: { workspaceId },
              select: { name: true },
            }),
            prisma.audience.findMany({
              where: { workspaceId },
              select: { name: true },
            }),
            prisma.fiveChapterStory.findMany({
              where: { draft: { offering: { workspaceId } } },
              select: { customName: true },
              take: 50,
            }),
          ]);
          const allowlist: string[] = [
            ...allOfferings.map(o => o.name || ''),
            ...allAudiences.map(a => a.name || ''),
            ...allStories.map(s => s.customName || ''),
            displayName || '',
            (displayName || '').split(/\s+/)[0] || '',
            'Maria',
            'Three Tier',
            '5 Chapter Story',
            'Five Chapter Story',
          ].map(s => s.toLowerCase()).filter(s => s.length > 0);

          let fabricated: string | null = null;
          for (const phrase of candidates) {
            const lower = phrase.toLowerCase();
            // A candidate is acceptable if it appears as a substring of any
            // allowlist entry, OR if it contains an allowlist entry — both
            // directions catch partial matches like "Grocery Fleet" inside
            // "Grocery Fleet Operations Director".
            const matched = allowlist.some(a =>
              a.includes(lower) || lower.includes(a),
            );
            if (!matched) {
              fabricated = phrase;
              break;
            }
          }

          if (fabricated) {
            console.log(`[Partner] chat-open validator caught fabricated name: ${JSON.stringify(fabricated)} — falling back to generic opener`);
            const fallbackChipMarkers = OPENER_FRESH_USER_CHIPS.map(c => `[CHIP: ${c}]`).join('\n');
            result.response = `${OPENER_FALLBACK_GENERIC}\n${fallbackChipMarkers}`;
          }
        }
      } catch (validatorErr) {
        console.error('[Partner] chat-open validator error (fail-open, original opener stands):', validatorErr);
      }
    }

    const chipPattern = /\[CHIP:\s*([^\]\n]+?)\s*\]/g;
    const chips: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = chipPattern.exec(result.response || '')) !== null) {
      const text = match[1].trim();
      if (text && chips.length < 4) chips.push(text);
    }
    const visible = (result.response || '').replace(chipPattern, '').replace(/\n{3,}/g, '\n\n').trim();
    const finalText = visible || "Hi — I'm Maria. What are you working on right now?";

    try {
      // Sweep prior openers tagged for this channel, scoped to user. We
      // load and filter rather than path-query because Prisma JSON path
      // filters on Postgres can be flaky for multi-key matches; the user
      // is unlikely to have many opener rows so the read is cheap.
      const priorOpeners = await prisma.assistantMessage.findMany({
        where: { userId, context: { path: ['channel'], equals: 'partner' } },
        select: { id: true, context: true },
      });
      const staleOpenerIds = priorOpeners
        .filter(m => (m.context as any)?.kind === 'chat-open-opener')
        .map(m => m.id);
      if (staleOpenerIds.length > 0) {
        await prisma.assistantMessage.deleteMany({ where: { id: { in: staleOpenerIds } } });
      }

      const openerCtx = { ...partnerChannel(workspaceId, ctx), kind: 'chat-open-opener', chips };
      await prisma.assistantMessage.create({
        data: { userId, role: 'assistant', content: finalText, context: openerCtx },
      });
    } catch (persistErr) {
      console.error('[Partner] chat-open persist failed:', persistErr);
    }

    res.json({
      response: finalText,
      chips,
      isChatOpen: true,
      actionResult: null,
      refreshNeeded: false,
      needsPageContent: false,
    });
    return;
  }

  // Check if Maria wants to read the page
  const normalizedActions = rawActions.map(a => ({
    ...a,
    type: ACTION_ALIASES[a.type] || a.type,
  }));

  // ─── Round 3.4 Bug 1 — medium normalization ─────────────────────────
  // For any build_deliverable action with a missing/empty medium param,
  // scan the full conversation history for explicit medium signals and
  // populate it. Cassidy's verification surfaced: user said "pitch deck"
  // in their first message, Maria's text acknowledged "pitch deck", but
  // Opus's build_deliverable tool call omitted the medium param — the
  // silent 'email' default in actions.ts produced an email deliverable.
  // Detection runs on history + current message; longest-pattern wins.
  {
    const allUserTextForMedium =
      history.filter(m => m.role === 'user').map(m => m.content).join(' ') +
      ' ' + (message || '');

    function detectMediumFromText(text: string): string | null {
      // Order matters — most-specific patterns first.
      if (/pitch\s*deck/i.test(text)) return 'pitch_deck';
      if (/landing\s*page/i.test(text)) return 'landing_page';
      if (/sales\s*script|talk\s*track|talking\s*points|in[-\s]*person\s*pitch/i.test(text)) return 'in_person';
      if (/press\s*release/i.test(text)) return 'press_release';
      if (/blog\s*post|blog\b/i.test(text)) return 'blog';
      if (/news\s*letter|newsletter/i.test(text)) return 'newsletter';
      if (/(white\s*paper|report)\b/i.test(text)) return 'report';
      if (/one[-\s]*pager|one[-\s]*page|briefing\b/i.test(text)) return 'landing_page';
      if (/\bemail\b/i.test(text)) return 'email';
      return null;
    }

    for (const a of normalizedActions) {
      if (a.type !== 'build_deliverable') continue;
      const params = (a.params ||= {});
      const explicit =
        typeof params.medium === 'string' && params.medium.trim().length > 0
          ? String(params.medium).trim().toLowerCase().replace(/[\s-]+/g, '_')
          : null;
      // Bundle 1A rev2 W3 — explicit Opus-supplied medium TAKES PRECEDENCE
      // over conversation-text detection. The prior code overrode Opus's
      // explicit 'email' with a conversation-derived 'landing_page' when
      // a phrase like "one page" or "briefing" appeared incidentally
      // (e.g., in audience description, tone notes, or unrelated context).
      // The user's explicit format choice — whether typed verbatim or
      // captured by Opus from a chip click — is the canonical signal.
      // Conversation detection is the fallback when Opus didn't supply
      // anything.
      const detected = detectMediumFromText(allUserTextForMedium);
      if (explicit) {
        params.medium = explicit;
      } else if (detected) {
        params.medium = detected;
      } else {
        // Genuinely ambiguous — leave undefined so the build path can
        // surface the format-question chip flow rather than silently
        // defaulting. actions.ts's medium fallback logic must check
        // for missing medium and refuse to start the build.
        delete params.medium;
      }
    }
  }

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
            const mediumLabel = mediumDisplayLabel(medium);
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
            const mediumLabel = mediumDisplayLabel(medium);
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
          const mediumLabel = mediumDisplayLabel(medium);
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

  // ─── Round 3.4 Bug 4 — pending-enrichment-gap injection ─────────────
  // The express pipeline emits ENRICHMENT_INTRO + the highest-priority
  // gap question, then persists remaining ranked gaps in
  // User.settings.pendingEnrichmentGaps. After the user answers the
  // current gap (any non-trivial reply), pop the next gap and tail-
  // append it to Maria's response prefixed with ENRICHMENT_TRANSITION.
  // Opus's reply naturally acknowledges the user's input, then the
  // deterministic append asks the next question. Skipped when the
  // user's reply was empty, a chip-shaped meta-answer, or when there
  // are no pending gaps.
  try {
    const userMsgWasSubstantive = !!(message && message.trim().length >= 2);
    if (userMsgWasSubstantive && result.response) {
      const u = await prisma.user.findUnique({
        where: { id: userId },
        select: { settings: true },
      });
      const settings = (u?.settings as Record<string, any>) || {};
      const pending = Array.isArray(settings.pendingEnrichmentGaps)
        ? settings.pendingEnrichmentGaps as { chapter: number; text: string }[]
        : [];
      if (pending.length > 0) {
        const next = pending[0];
        const remaining = pending.slice(1);
        result.response = `${result.response}\n\nGood. One more thing: ${next.text}`;
        if (remaining.length > 0) {
          settings.pendingEnrichmentGaps = remaining;
        } else {
          delete settings.pendingEnrichmentGaps;
        }
        await prisma.user.update({ where: { id: userId }, data: { settings } });
      }
    }
  } catch (err) {
    console.error('[Partner] pendingEnrichmentGap injection failed:', err);
  }

  // ─── Round 3.4 Bug 1 — FORMAT_NEEDED handler ─────────────────────────
  // actions.ts emits the "[FORMAT_NEEDED]" marker when build_deliverable
  // was attempted but no medium was captured (Opus didn't supply, partner
  // normalizer found none in conversation). Replace Maria's response
  // entirely with the locked format question + chips. Do NOT auto-build.
  if (actionResult && actionResult.startsWith('[FORMAT_NEEDED]')) {
    const formatChipMarkers = FORMAT_CHIPS.map(c => `[CHIP: ${c}]`).join('\n');
    result.response = `${FORMAT_QUESTION}\n\n${formatChipMarkers}`;
    actionResult = null;  // Clear the marker so it's not stored as action context.
    refreshNeeded = false;
  }

  // ─── Round 3.4 Bug 1 — Pitch deck honest fallback ────────────────────
  // When the captured medium is pitch_deck and Maria is about to fire
  // build_deliverable, surface the honest fallback once: explain that
  // the export comes out as a structured doc (not .pptx), then let the
  // user keep pitch deck shape or switch to one-pager. Detection is
  // surface-level: actionResult contains BUILD_STARTED with pitch_deck
  // medium AND the user has not already seen this fallback this build.
  // We track via a per-build marker in assistant message context.
  // (Implementation deferred — surfaces the locked copy via a future
  // pre-build hook. Current path: pitch_deck builds proceed straight
  // through, deliverable renders with pitch deck spec from mediums.ts.)

  // Cowork follow-up #2 — parse universal [CHIP: ...] markers from every
  // Maria turn (not just chat-open). Strip from visible text; persist
  // chips in the assistant row's context JSON so they survive history
  // reload; return them on the response so the frontend can render them.
  // Round 3.4 Bug 14 — also parse [SUGGEST: ...] markers as a separate
  // class of "suggested-answer" chips (content suggestions vs. navigation
  // chips). Suggested chips render with SUGGESTED_CHIPS_FRAME framing
  // above the group and insert their text into the chat input on click
  // rather than auto-submitting. The two arrays are returned separately.
  const universalChipPattern = /\[CHIP:\s*([^\]\n]+?)\s*\]/g;
  const suggestChipPattern = /\[SUGGEST:\s*([^\]\n]+?)\s*\]/g;
  const universalChips: string[] = [];
  const suggestChips: string[] = [];
  // Round 3 fix — skip-affordance chip filter. Path C does not exist as
  // an entry point; coaching chips that end the flow early ("Just build
  // it…", "Skip ahead", etc.) get dropped here regardless of how Opus
  // composed the chip text. Free-text skip-demands route through the
  // SKIP_DEMAND short-circuit above with the locked Cowork response.
  const SKIP_CHIP_PATTERNS: RegExp[] = [
    /^just build/i,
    /^build (it|now|this|the whole)/i,
    /^skip /i,
    /skip the (process|questions|steps|interim)/i,
    /go ahead and (build|do)/i,
    /do (it|the whole|your best now|it for me)/i,
    /^(give|show) me (the|a) (result|deliverable|draft|email)/i,
    /with what (you|i|we) (have|gave)/i,
  ];
  function isSkipShapedChip(text: string): boolean {
    const t = text.trim().replace(/[.!?]+$/, '');
    return SKIP_CHIP_PATTERNS.some(re => re.test(t));
  }
  {
    let m: RegExpExecArray | null;
    while ((m = universalChipPattern.exec(result.response || '')) !== null) {
      const text = m[1].trim();
      if (!text) continue;
      if (isSkipShapedChip(text)) {
        console.log(`[Partner] dropped skip-shaped chip: ${JSON.stringify(text)}`);
        continue;
      }
      if (universalChips.length < 4) universalChips.push(text);
    }
  }
  // Round 3.4 Bug 14 — parse [SUGGEST: ...] markers separately. These
  // are content suggestions, not navigation chips. Cap at 4 to keep the
  // chip cluster scannable.
  {
    let m: RegExpExecArray | null;
    while ((m = suggestChipPattern.exec(result.response || '')) !== null) {
      const text = m[1].trim();
      if (!text) continue;
      if (suggestChips.length < 4) suggestChips.push(text);
    }
  }
  result.response = (result.response || '')
    .replace(universalChipPattern, '')
    .replace(suggestChipPattern, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Store the assistant reply — serialize response with action result for history.
  // Phase 1 hardening (Fix #3) — user message was persisted before the Opus
  // call so any upstream failure doesn't lose what the user said. Only the
  // assistant row remains to be written here.
  const storedResponse = actionResult
    ? `${result.response}\n\n[${actionResult}]`
    : result.response;

  const assistantCtxBase: Record<string, any> = partnerChannel(workspaceId, ctx);
  if (universalChips.length > 0) assistantCtxBase.chips = universalChips;
  if (suggestChips.length > 0) assistantCtxBase.suggestChips = suggestChips;
  await prisma.assistantMessage.create({
    data: { userId, role: 'assistant', content: storedResponse, context: assistantCtxBase },
  });

  console.log(`[Partner] RESPONSE: text=${(result.response || '').length}chars, actionResult=${(actionResult || '').length}chars, chips=${universalChips.length}, suggestChips=${suggestChips.length}, hasBuildStarted=${(actionResult || '').includes('BUILD_STARTED')}`);

  res.json({
    response: result.response,
    chips: universalChips.length > 0 ? universalChips : undefined,
    suggestChips: suggestChips.length > 0 ? suggestChips : undefined,
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

// ═══════════════════════════════════════════════════════════════
// Round 3.1 Item 2 — Autonomous skip-demand pipeline
// ═══════════════════════════════════════════════════════════════
// Frontend calls this when the user taps SKIP_DEMAND_CHIP_AUTONOMOUS
// after seeing the locked skip-demand response. Today's behavior was:
// route the chip text through Opus and hope it fired build_deliverable.
// In Cowork's walk that produced a Three-Tier-only result instead of the
// requested deliverable. This endpoint replaces that with deterministic
// classification + direct pipeline kickoff.
//
// Flow:
//  1. Classify the user's recent conversation to extract deliverable
//     type + offering name + audience name + situation.
//  2. Match offering/audience by name (case-insensitive) in the user's
//     workspace.
//  3. If everything is present: write AUTONOMOUS_PRE_BUILD_EXPECTATION
//     to chat, fire the existing commitExistingForPipeline + runPipeline
//     path, and return started=true so the frontend behaves as if
//     BUILD_STARTED was received. Tag the ExpressJob's interpretation
//     with autonomousMode + deliverableType so the pipeline knows to
//     fire AUTONOMOUS_POST_DELIVERY_OFFER after the deliverable lands.
//  4. If anything is missing (no deliverable type, no offering, no
//     audience): return started=false. The frontend falls back to
//     today's behavior — sends the chip text through Opus.
router.post('/autonomous-build', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const workspaceId = req.workspaceId!;

  try {
    // Load recent partner conversation, scoped to workspace + legacy.
    const allHistory = await prisma.assistantMessage.findMany({
      where: {
        userId,
        context: { path: ['channel'], equals: 'partner' },
      },
      select: { role: true, content: true, createdAt: true, context: true },
      orderBy: { createdAt: 'desc' },
      take: 60,
    });
    const scoped = allHistory.filter(m => {
      const ctx = m.context as any;
      return !ctx?.workspaceId || ctx.workspaceId === workspaceId;
    });
    if (scoped.length === 0) {
      res.json({ started: false, reason: 'no-conversation' });
      return;
    }
    // Newest-first → oldest-first for the classifier prompt.
    scoped.reverse();

    const conversationBlock = scoped
      .slice(-30)
      .map(m => `${m.role}: ${m.content.slice(0, 800)}`)
      .join('\n\n');

    type ClassifierResult = {
      deliverableType: string | null;
      offeringName: string | null;
      audienceName: string | null;
      situation: string;
      // Bundle 1A rev6 Phase 1 — renamed from verbatim_ask (snake_case)
      // to verbatimAsk (camelCase) to match the canonical
      // ExpressInterpretation interface. The classifier prompt JSON
      // schema below uses verbatimAsk too.
      verbatimAsk: string;
    };

    const classifierSystem = `You are extracting structured info from a conversation between a user and Maria, a messaging-build assistant. Your job is JUDGMENT-light: only fill in a field if the user has CLEARLY stated it. When in doubt, leave the field null.

Fields to extract:

- deliverableType: lowercase noun for the deliverable FORMAT the user wants. Common values: "email", "pitch deck", "landing page", "blog post", "one-pager", "press release", "newsletter", "report", "in-person", "sales script". null if the user has not stated a format.

  Bundle 1A rev3 W3 — explicit format mentions ("email", "pitch deck", "landing page") OUTRANK topic mentions ("webinar", "demo", "campaign", "launch", "rollout", "kickoff"). The format is the SHAPE of the deliverable; the topic is what the deliverable is ABOUT. Many emails are about webinars, demos, or campaigns — they are still emails.

  Worked examples — read these carefully:
  - User says "send an email about our Q3 webinar" → deliverableType = "email" (NOT "landing page", NOT "webinar"; webinar is the topic)
  - User says "build a pitch deck for an investor meeting" → deliverableType = "pitch deck" (NOT "in-person")
  - User says "write a landing page for our SaaS launch" → deliverableType = "landing page"
  - User says "I need a one-page email to our partner about our Q3 webinar" → deliverableType = "email" (the user said "email"; "one-page" is a length adjective on the email, not a format change to one-pager)
  - User says "draft an outreach email about our demo days" → deliverableType = "email"
  - User says "create a one-pager about our beta program" → deliverableType = "one-pager"
  - User says "give me a press release about our funding round" → deliverableType = "press release"

  When two formats are stated and one is more specific ("a one-page email" — "email" is more specific than "one-page"), take the more specific format word verbatim. When no explicit format is stated, return null.

- offeringName: the offering, product, or service name the user is selling/promoting. null if unstated.

- audienceName: the target audience description (role + organizational context, OR a named persona). null if unstated.

- situation: a short summary of the specific occasion or context for this deliverable (e.g., "Q3 partnership webinar invitation", "investor meeting next week", "beta launch announcement"). One sentence max. Empty string if the conversation has no specific occasion. This field is for downstream prompt context — it is NOT the user's ask.

- verbatimAsk: the EXACT WORDING the user used to state what they want the audience to do. This field replaces upstream pattern-matching that tried to recover the literal CTA from the situation paragraph. The user has the words; let the user's words be the answer.

  Pull the literal sentence verbatim. Do NOT paraphrase. Do NOT shorten. Do NOT generalize. If the user typed "I want them to confirm participation in our joint Q3 webinar by May 15", verbatimAsk is "confirm participation in our joint Q3 webinar by May 15" (you may strip "I want them to" / "the ask is" / "tell them to" if it leaves a clean imperative; do not change anything else). If the user typed "reply with their availability for next week", verbatimAsk is "reply with their availability for next week".

  TONE NOTES ARE NOT ASKS. If the user said "the tone should be partner-to-partner, not sales pitch" — that's tone, not an ask. Skip it.

  If the user did not state an ask, return empty string. Empty is better than fabricated.

OUTPUT — JSON only, no markdown fences:
{ "deliverableType": "...", "offeringName": "...", "audienceName": "...", "situation": "...", "verbatimAsk": "..." }

When in doubt, prefer null/empty. False positives (filling a field that wasn't actually stated) cause the autonomous pipeline to build the wrong thing — which is the bug we're fixing.`;

    const classifierMessage = `CONVERSATION:\n\n${conversationBlock}`;

    const classified = await callAIWithJSON<ClassifierResult>(
      classifierSystem,
      classifierMessage,
      'fast',
    );

    if (!classified.deliverableType || !classified.offeringName || !classified.audienceName) {
      console.log(`[AutonomousBuild] insufficient inputs — deliverable=${JSON.stringify(classified.deliverableType)} offering=${JSON.stringify(classified.offeringName)} audience=${JSON.stringify(classified.audienceName)}; falling back`);
      res.json({ started: false, reason: 'insufficient-info', classified });
      return;
    }

    // Match offering + audience case-insensitively by name in the user's workspace.
    const offering = await prisma.offering.findFirst({
      where: {
        workspaceId,
        name: { equals: classified.offeringName, mode: 'insensitive' },
      },
    });
    const audience = await prisma.audience.findFirst({
      where: {
        workspaceId,
        name: { equals: classified.audienceName, mode: 'insensitive' },
      },
    });
    if (!offering || !audience) {
      console.log(`[AutonomousBuild] no matching offering/audience in workspace; falling back. offering=${!!offering} audience=${!!audience}`);
      res.json({ started: false, reason: 'no-offering-or-audience' });
      return;
    }

    // Persist the pre-build expectation message so the chat panel renders
    // it on the next history poll. Substitute the deliverable type into
    // the locked template.
    const deliverableType = classified.deliverableType;
    await prisma.assistantMessage.create({
      data: {
        userId,
        role: 'assistant',
        content: buildAutonomousPreBuildExpectation(deliverableType),
        context: {
          ...partnerChannel(workspaceId),
          kind: 'autonomous-pre-build',
        },
      },
    });

    // Kick off the pipeline. commitExistingForPipeline returns
    // Bundle 1A rev6 Phase 1.D — commitExistingForPipeline now
    // synthesizes the canonical interpretation directly with
    // mode='autonomous', primaryMedium.value=medium, and
    // verbatimAsk=<classified ask>. The redundant post-call
    // expressJob.update block (rev3-5) is REMOVED — its purpose was to
    // patch the missing fields onto the synthesized interpretation,
    // which now has them at construction time.
    const result = await commitExistingForPipeline(
      offering.id,
      audience.id,
      deliverableType,
      classified.situation || '',
      userId,
      workspaceId,
      typeof classified.verbatimAsk === 'string' ? classified.verbatimAsk : '',
    );

    setImmediate(() => {
      runPipeline(result.jobId).catch((err: unknown) => {
        console.error(`[AutonomousBuild] runPipeline error for job ${result.jobId}:`, err);
      });
    });

    res.json({
      started: true,
      jobId: result.jobId,
      draftId: result.draftId,
      deliverableType,
    });
  } catch (err) {
    console.error('[AutonomousBuild] error:', err);
    res.status(500).json({ started: false, reason: 'server-error' });
  }
});

export default router;
