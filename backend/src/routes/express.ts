// Express Flow routes — Maria 3.0
//
// New top-level API surface for the Express Flow feature. Lives on
// /api/express/* to keep 3.0 cleanly separated from 2.5's /api/ai/* routes.
//
// Session 1 ships the extract endpoint only. Later sessions will add:
//   POST /api/express/commit — materialize the interpretation into DB rows
//   GET  /api/express/status/:jobId — progress strip polling
//
// This file does NOT import or touch any 2.5 code paths. If this file is
// deleted, 2.5 continues to function identically.

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { extractExpressInterpretation } from '../lib/expressExtraction.js';

const router = Router();
router.use(requireAuth);

// ─── POST /api/express/extract ─────────────────────────────
//
// Takes a free-form message, returns a structured interpretation.
// No DB writes. No state changes. Pure extraction.

router.post('/extract', async (req: Request, res: Response) => {
  const { message } = req.body as { message?: string };

  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: 'A message is required.' });
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
    res.status(500).json({
      error: `I had trouble understanding that. Could you rephrase? (${message})`,
    });
  }
});

export default router;
