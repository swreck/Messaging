// Express Flow routes — Maria 3.0
//
// /api/express/* is the 3.0-only API surface. It stays cleanly separated from
// 2.5's /api/ai/* and /api/drafts/* routes so the 2.5 codebase is never touched
// by 3.0 concerns. If this file is deleted, 2.5 keeps working identically.
//
// Endpoints:
//   POST /api/express/extract       — Free-form message → structured interpretation
//   POST /api/express/commit        — Interpretation → DB rows + kick off async pipeline
//   GET  /api/express/status/:jobId — Poll pipeline progress + final story

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace } from '../middleware/workspace.js';
import { prisma } from '../lib/prisma.js';
import { param } from '../lib/params.js';
import {
  extractExpressInterpretation,
  type ExpressInterpretation,
} from '../lib/expressExtraction.js';
import {
  commitInterpretation,
  commitInterpretationForWizard,
  runPipeline,
} from '../lib/expressPipeline.js';

const router = Router();
router.use(requireAuth);

// ─── POST /api/express/extract ─────────────────────────────
//
// Takes a free-form message, returns a structured interpretation.
// No DB writes. No state changes. Pure extraction.

router.post('/extract', async (req: Request, res: Response) => {
  const { message } = req.body as { message?: string };

  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: 'Tell me a little about what you need.' });
    return;
  }

  const trimmed = message.trim();
  if (trimmed.length < 20) {
    res.status(400).json({
      error: 'Tell me a little more about what you need — even a few sentences will do.',
    });
    return;
  }

  if (trimmed.length > 20000) {
    res.status(400).json({
      error: 'That is a lot of text. Try narrowing it to the most important part of what you need.',
    });
    return;
  }

  try {
    const interpretation = await extractExpressInterpretation(trimmed);
    res.json({ interpretation });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'unknown error';
    console.error('[ExpressExtract] error:', message);
    res.status(500).json({
      error: 'I had trouble reading that. Could you rephrase it?',
    });
  }
});

// ─── POST /api/express/commit ──────────────────────────────
//
// Takes an (optionally edited) interpretation, creates the 2.5 DB rows, and
// kicks off the silent build pipeline in the background. Returns immediately
// with a jobId the frontend can poll.

router.post('/commit', requireWorkspace, async (req: Request, res: Response) => {
  const { interpretation } = req.body as { interpretation?: ExpressInterpretation };

  if (!interpretation) {
    res.status(400).json({ error: 'An interpretation is required.' });
    return;
  }

  if (!interpretation.offering || !interpretation.offering.name) {
    res.status(400).json({ error: "The offering needs a name — change it in the preview before confirming." });
    return;
  }

  if (!interpretation.audiences || interpretation.audiences.length === 0) {
    res.status(400).json({ error: "I need at least one audience to write for." });
    return;
  }

  try {
    const result = await commitInterpretation(
      interpretation,
      req.user!.userId,
      req.workspaceId!,
    );

    // Fire-and-forget pipeline — returns immediately so the frontend can poll.
    setImmediate(() => {
      runPipeline(result.jobId).catch(err => {
        console.error(`[ExpressCommit] Uncaught pipeline error for job ${result.jobId}:`, err);
      });
    });

    res.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'unknown error';
    console.error('[ExpressCommit] error:', message);
    res.status(500).json({
      error: `Had trouble setting that up: ${message}`,
    });
  }
});

// ─── POST /api/express/commit-for-wizard ────────────────────
//
// Same interpretation input as /commit but does NOT run the silent pipeline.
// Used when the user clicks "Take me through it step by step instead" on the
// Interpretation preview. Creates the DB rows and returns the draftId so the
// frontend can navigate to /three-tier/{draftId}. The user lands in Step 4
// since the interpretation already covers Steps 1-3.

router.post('/commit-for-wizard', requireWorkspace, async (req: Request, res: Response) => {
  const { interpretation } = req.body as { interpretation?: ExpressInterpretation };

  if (!interpretation) {
    res.status(400).json({ error: 'An interpretation is required.' });
    return;
  }

  if (!interpretation.offering || !interpretation.offering.name) {
    res.status(400).json({ error: "The offering needs a name — change it in the preview before confirming." });
    return;
  }

  if (!interpretation.audiences || interpretation.audiences.length === 0) {
    res.status(400).json({ error: "I need at least one audience to write for." });
    return;
  }

  try {
    const result = await commitInterpretationForWizard(
      interpretation,
      req.user!.userId,
      req.workspaceId!,
    );
    res.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'unknown error';
    console.error('[ExpressCommitForWizard] error:', message);
    res.status(500).json({
      error: `Had trouble setting that up: ${message}`,
    });
  }
});

// ─── GET /api/express/status/:jobId ────────────────────────
//
// Returns current pipeline stage, progress (0-100), and — once complete —
// the finished FiveChapterStory with chapters and blended text.

router.get('/status/:jobId', requireWorkspace, async (req: Request, res: Response) => {
  const job = await prisma.expressJob.findFirst({
    where: { id: param(req.params.jobId), userId: req.user!.userId },
  });

  if (!job) {
    res.status(404).json({ error: 'Job not found.' });
    return;
  }

  // Collect every variant story the pipeline produced. Single-audience jobs
  // leave variantStoryIds null and only resultStoryId is set, so the list
  // collapses to one story — the frontend sees a single-element variants
  // array either way.
  const variantIds: string[] = Array.isArray(job.variantStoryIds)
    ? (job.variantStoryIds as unknown as string[])
    : job.resultStoryId
      ? [job.resultStoryId]
      : [];

  let story = null;
  const variants: Array<{
    storyId: string;
    audienceName: string;
    medium: string;
    customName: string;
    blendedText: string;
  }> = [];

  if (variantIds.length > 0) {
    const stories = await prisma.fiveChapterStory.findMany({
      where: { id: { in: variantIds } },
      include: {
        chapters: { orderBy: { chapterNum: 'asc' } },
        draft: {
          include: { audience: true },
        },
      },
    });
    // Preserve job-stored variant order (stories come back unordered).
    const byId = new Map(stories.map(s => [s.id, s]));
    for (const id of variantIds) {
      const s = byId.get(id);
      if (!s) continue;
      variants.push({
        storyId: s.id,
        audienceName: s.draft?.audience?.name || 'Audience',
        medium: s.medium,
        customName: s.customName || '',
        blendedText: s.blendedText || '',
      });
    }
    // Preserve the legacy `story` field for the primary variant — the
    // existing frontend polling loop uses story.blendedText as its source
    // of truth. For multi-variant jobs the frontend should read `variants`.
    const primary = byId.get(variantIds[0]);
    if (primary) story = primary;
  }

  res.json({
    jobId: job.id,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    error: job.error || null,
    draftId: job.draftId,
    resultStoryId: job.resultStoryId,
    variantCount: variants.length,
    variants,
    story,
  });
});

export default router;
