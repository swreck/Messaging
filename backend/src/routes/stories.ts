import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, requireStoryteller } from '../middleware/workspace.js';
import { param } from '../lib/params.js';

const router = Router();
router.use(requireAuth);
router.use(requireWorkspace);

// GET /api/stories/all — all stories for the current user with offering/audience context
router.get('/all', async (req: Request, res: Response) => {
  const stories = await prisma.fiveChapterStory.findMany({
    where: { draft: { offering: { workspaceId: req.workspaceId } } },
    include: {
      chapters: { orderBy: { chapterNum: 'asc' } },
      draft: {
        select: {
          id: true,
          currentStep: true,
          status: true,
          offering: { select: { id: true, name: true } },
          audience: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { updatedAt: 'desc' },
  });
  res.json({ stories });
});

// GET /api/stories?draftId=xxx
router.get('/', async (req: Request, res: Response) => {
  const { draftId } = req.query;
  if (!draftId) {
    res.status(400).json({ error: 'draftId query param required' });
    return;
  }

  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: draftId as string, offering: { workspaceId: req.workspaceId } },
  });
  if (!draft) {
    res.status(404).json({ error: 'Draft not found' });
    return;
  }

  const stories = await prisma.fiveChapterStory.findMany({
    where: { draftId: draftId as string },
    include: { chapters: { orderBy: { chapterNum: 'asc' } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ stories });
});

// POST /api/stories
router.post('/', requireStoryteller, async (req: Request, res: Response) => {
  const { draftId, medium, cta, emphasis } = req.body;
  if (!draftId || !medium || !cta) {
    res.status(400).json({ error: 'draftId, medium, and cta are required' });
    return;
  }

  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: draftId, offering: { workspaceId: req.workspaceId } },
  });
  if (!draft) {
    res.status(404).json({ error: 'Draft not found' });
    return;
  }

  const { sourceStoryId, customName, style } = req.body;
  // Round C3 — per-deliverable style override (optional). Empty string = use
  // user's effective style; explicit value overrides for this deliverable only.
  const styleValidation = (await import('../lib/styleResolver.js')).validateStyleInput(style);
  if (!styleValidation.ok) {
    res.status(400).json({ error: styleValidation.error });
    return;
  }

  // Auto-generate persistent name if not provided
  let name = customName || '';
  if (!name) {
    const MEDIUM_LABELS: Record<string, string> = {
      email: 'Email', blog: 'Blog Post', social: 'Social Post', landing_page: 'Landing Page',
      in_person: 'In-Person', press_release: 'Press Release', newsletter: 'Newsletter',
      report: 'Report',
    };
    const baseLabel = MEDIUM_LABELS[medium] || medium;
    const existingCount = await prisma.fiveChapterStory.count({
      where: { draftId, medium },
    });
    name = existingCount > 0 ? `${baseLabel} #${existingCount + 1}` : baseLabel;
  }

  const story = await prisma.fiveChapterStory.create({
    data: {
      draftId,
      medium,
      cta,
      emphasis: emphasis || '',
      customName: name,
      sourceStoryId: sourceStoryId || null,
      style: styleValidation.value || '',
    },
    include: { chapters: true },
  });
  res.status(201).json({ story });
});

// GET /api/stories/:id
router.get('/:id', async (req: Request, res: Response) => {
  const story = await prisma.fiveChapterStory.findFirst({
    where: { id: param(req.params.id), draft: { offering: { workspaceId: req.workspaceId } } },
    include: { chapters: { orderBy: { chapterNum: 'asc' } } },
  });
  if (!story) {
    res.status(404).json({ error: 'Story not found' });
    return;
  }
  res.json({ story });
});

// PUT /api/stories/:id
router.put('/:id', requireStoryteller, async (req: Request, res: Response) => {
  const story = await prisma.fiveChapterStory.findFirst({
    where: { id: param(req.params.id), draft: { offering: { workspaceId: req.workspaceId } } },
  });
  if (!story) {
    res.status(404).json({ error: 'Story not found' });
    return;
  }

  const { medium, cta, emphasis, stage, joinedText, blendedText, version } = req.body;

  // Optimistic concurrency check
  if (version !== undefined && story.version !== version) {
    res.status(409).json({
      error: 'This content was edited elsewhere. Refresh to see the latest version.',
      currentVersion: story.version,
    });
    return;
  }

  const updated = await prisma.fiveChapterStory.update({
    where: { id: param(req.params.id) },
    data: {
      medium: medium ?? story.medium,
      cta: cta ?? story.cta,
      emphasis: emphasis ?? story.emphasis,
      stage: stage ?? story.stage,
      joinedText: joinedText ?? story.joinedText,
      blendedText: blendedText ?? story.blendedText,
      version: { increment: 1 },
    },
    include: { chapters: { orderBy: { chapterNum: 'asc' } } },
  });
  res.json({ story: updated });
});

// Round C3 — per-deliverable style override (post-creation). Used by the
// metadata-row Style picker click. Empty string = clear the override and
// fall back to the user's effective style.
router.patch('/:id/style', requireStoryteller, async (req: Request, res: Response) => {
  const story = await prisma.fiveChapterStory.findFirst({
    where: { id: param(req.params.id), draft: { offering: { workspaceId: req.workspaceId } } },
    select: { id: true },
  });
  if (!story) {
    res.status(404).json({ error: 'Story not found' });
    return;
  }
  const v = (await import('../lib/styleResolver.js')).validateStyleInput(req.body?.style);
  if (!v.ok) { res.status(400).json({ error: v.error }); return; }
  const updated = await prisma.fiveChapterStory.update({
    where: { id: param(req.params.id) },
    data: { style: v.value || '' },
    select: { id: true, style: true },
  });
  const effective = await (await import('../lib/styleResolver.js')).resolveStyleForStory(updated.id, req.user!.userId);
  res.json({ id: updated.id, style: updated.style, effective });
});

// PUT /api/stories/:storyId/chapters/:chapterNum
router.put('/:storyId/chapters/:chapterNum', requireStoryteller, async (req: Request, res: Response) => {
  const story = await prisma.fiveChapterStory.findFirst({
    where: { id: param(req.params.storyId), draft: { offering: { workspaceId: req.workspaceId } } },
    // Round E2 — also load the chapter's most recent ai_generate version so
    // we can characterize the user's edit (BEFORE = ai_generate, AFTER = save).
    // Round E4 — also load the current Three Tier so foundational-shift
    // detection can compare the edit against current Tier wording.
    include: {
      draft: {
        include: {
          audience: { select: { name: true } },
          tier1Statement: { select: { id: true, text: true } },
          tier2Statements: { orderBy: { sortOrder: 'asc' }, select: { id: true, text: true, categoryLabel: true } },
        },
      },
    },
  });
  if (!story) {
    res.status(404).json({ error: 'Story not found' });
    return;
  }

  const { title, content, version } = req.body;

  // Optimistic concurrency check
  if (version !== undefined && story.version !== version) {
    res.status(409).json({
      error: 'This content was edited elsewhere. Refresh to see the latest version.',
      currentVersion: story.version,
    });
    return;
  }

  const chapterNum = parseInt(param(req.params.chapterNum), 10);

  const chapter = await prisma.chapterContent.upsert({
    where: { storyId_chapterNum: { storyId: param(req.params.storyId), chapterNum } },
    update: { title: title ?? undefined, content: content ?? undefined },
    create: { storyId: param(req.params.storyId), chapterNum, title: title || '', content: content || '' },
  });

  // Create chapter version for manual edits
  let detectedPattern: any = null;
  let foundationalShift: any = null;
  if (content) {
    const maxVer = await prisma.chapterVersion.aggregate({
      where: { chapterContentId: chapter.id },
      _max: { versionNum: true },
    });
    // Find the most recent ai_generate version to use as BEFORE for E2 pattern
    // detection AND E4 foundational-shift detection. If none exists, skip
    // detection — there's no Maria-authored baseline to compare against.
    const lastAi = await prisma.chapterVersion.findFirst({
      where: { chapterContentId: chapter.id, changeSource: 'ai_generate' },
      orderBy: { versionNum: 'desc' },
      select: { content: true },
    });
    await prisma.chapterVersion.create({
      data: {
        chapterContentId: chapter.id,
        title: chapter.title,
        content: chapter.content,
        versionNum: (maxVer._max?.versionNum ?? 0) + 1,
        changeSource: 'manual',
      },
    });
    // Round E2 + E4 — fire pattern detection AND foundational-shift detection
    // in parallel against the ai_generate baseline. Both wrapped non-fatally.
    if (lastAi?.content && lastAi.content !== content) {
      const [patternResult, shiftResult] = await Promise.allSettled([
        (async () => {
          const { recordEditObservation } = await import('../lib/userStyleRules.js');
          return recordEditObservation({
            userId: req.user!.userId,
            before: lastAi.content,
            after: content,
            audienceType: story.draft?.audience?.name,
            format: story.medium,
          });
        })(),
        (async () => {
          const { detectFoundationalShift } = await import('../services/foundationalShift.js');
          return detectFoundationalShift({
            beforeChapterContent: lastAi.content,
            afterChapterContent: content,
            chapterNum,
            threeTier: {
              tier1: story.draft?.tier1Statement?.text || '',
              tier2: (story.draft?.tier2Statements || []).map((t: any) => ({ categoryLabel: t.categoryLabel || '', text: t.text || '' })),
            },
            audienceName: story.draft?.audience?.name || '',
          });
        })(),
      ]);
      if (patternResult.status === 'fulfilled') detectedPattern = patternResult.value;
      else console.error('[E2] pattern detection failed:', patternResult.reason);
      if (shiftResult.status === 'fulfilled' && shiftResult.value.shouldUpdate) foundationalShift = shiftResult.value;
      else if (shiftResult.status === 'rejected') console.error('[E4] shift detection failed:', shiftResult.reason);
      // Stash pending detections on User.settings so the next partner-message
      // request can surface them in Maria's prompt context. Cleared on read
      // (one-shot). 90-second freshness window in the partner route.
      if (detectedPattern || foundationalShift) {
        try {
          const userRow = await prisma.user.findUnique({
            where: { id: req.user!.userId },
            select: { settings: true },
          });
          const settings = (userRow?.settings as Record<string, any>) || {};
          if (detectedPattern) {
            settings.pendingEditPattern = {
              shape: detectedPattern.shape,
              scopeAudienceType: detectedPattern.scopeAudienceType || '',
              scopeFormat: detectedPattern.scopeFormat || '',
              occurrences: detectedPattern.occurrences,
              setAt: new Date().toISOString(),
            };
          }
          if (foundationalShift) {
            settings.pendingFoundationalShift = {
              draftId: story.draftId,
              targetCell: foundationalShift.targetCell,
              oldText: foundationalShift.oldText,
              newText: foundationalShift.newText,
              reason: foundationalShift.reason,
              setAt: new Date().toISOString(),
            };
          }
          await prisma.user.update({
            where: { id: req.user!.userId },
            data: { settings },
          });
        } catch (err) {
          console.error('[E2/E4] stash pending detection failed:', err);
        }
      }
    }
  }

  const updatedStory = await prisma.fiveChapterStory.update({
    where: { id: param(req.params.storyId) },
    data: { version: { increment: 1 } },
  });
  // detectedPattern is non-null when the user has hit threshold-3 of similar
  // edits — frontend prompts Maria to ask the scoped question; user accepts
  // via /api/settings/style-rules POST.
  // foundationalShift is non-null when Maria detects the edit reframes a Tier
  // — frontend prompts Maria to propose the exact new Tier wording; user
  // accepts via /api/tiers/:draftId/tier1 (or tier2/tier3) PUT.
  res.json({ chapter, story: updatedStory, detectedPattern, foundationalShift });
});

// PATCH /api/stories/:id/rename
router.patch('/:id/rename', requireStoryteller, async (req: Request, res: Response) => {
  const story = await prisma.fiveChapterStory.findFirst({
    where: { id: param(req.params.id), draft: { offering: { workspaceId: req.workspaceId } } },
  });
  if (!story) {
    res.status(404).json({ error: 'Story not found' });
    return;
  }
  const { customName } = req.body;
  if (customName === undefined) {
    res.status(400).json({ error: 'customName required' });
    return;
  }
  const updated = await prisma.fiveChapterStory.update({
    where: { id: param(req.params.id) },
    data: { customName },
  });
  res.json({ story: updated });
});

// DELETE /api/stories/:id
router.delete('/:id', requireStoryteller, async (req: Request, res: Response) => {
  const story = await prisma.fiveChapterStory.findFirst({
    where: { id: param(req.params.id), draft: { offering: { workspaceId: req.workspaceId } } },
  });
  if (!story) {
    res.status(404).json({ error: 'Story not found' });
    return;
  }

  await prisma.fiveChapterStory.delete({ where: { id: param(req.params.id) } });
  res.json({ success: true });
});

export default router;
