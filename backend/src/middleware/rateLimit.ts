// Phase 1 production hardening (Fix #8) — per-route rate limits.
// Keys by authenticated user id when available, else IP. The expensive
// Opus-driven endpoints (partner-message, generate-chapter, polish-story)
// get tight limits sized to typical human pacing; the global /api safety
// net is intentionally generous (60/min/user) and exists only to bound
// runaway-loop scenarios.

import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Request, Response } from 'express';

// Use express-rate-limit's ipKeyGenerator helper for the IP fallback so
// IPv6 addresses are normalized to a /64 prefix and we don't get flagged
// for letting one IPv6 user bypass limits via the lower bits.
function keyByUser(req: Request, res: Response): string {
  const userId = (req as any).user?.userId;
  if (userId) return userId;
  return ipKeyGenerator(req.ip || '');
}

export const partnerLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  keyGenerator: keyByUser,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: "You're sending messages faster than I can respond. Take a breath — try again in a minute." },
});

export const generateChapterLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  keyGenerator: keyByUser,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: "I'm working on something for you already — give it a minute and try again." },
});

export const polishStoryLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 2,
  keyGenerator: keyByUser,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: "Polishing takes a minute or two — let the current one finish before starting another." },
});

export const defaultApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  keyGenerator: keyByUser,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Slow down — too many requests. Try again in a minute.' },
});
