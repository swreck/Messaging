// Round E2 — UserStyleRule application + observation tracking.
//
// Two responsibilities:
//   1. fetchMatchingRules() — at refine/copy-edit/generate time, return the
//      user's style rules that match the deliverable's audience-type and
//      format (or have empty scope = applies anywhere). Caller weaves them
//      into the system prompt as additional constraints.
//   2. recordEditObservation() — when the user edits a chapter (manual
//      change-source), characterize the shape of the change and append it
//      to a per-user rolling window of observations. When the rolling window
//      reaches threshold-3 of similar shapes, return the detected pattern
//      so Maria can ask the scoped question.
//
// Observations are stored in User.settings.editObservations (JSON column;
// no schema change needed). Capped at 20 most-recent so the window stays
// fresh and detection isn't biased by ancient edits.

import { prisma } from './prisma.js';
import { characterizeEdit, detectPattern, type EditObservation, type DetectedPattern } from '../services/editPatternDetect.js';

const OBSERVATION_WINDOW = 20;

export interface MatchedRule {
  id: string;
  rule: string;
  scopeAudienceType: string;
  scopeFormat: string;
}

/**
 * Fetch active rules that match the current generation context. A rule
 * matches when its scope is empty (applies anywhere) or its scope matches
 * the provided audienceType / format. Bumps lastApplied on the rules
 * actually used so the Settings 30-day-stale prompt stays accurate.
 */
export async function fetchMatchingRules(opts: {
  userId: string;
  audienceType?: string;
  format?: string;
}): Promise<MatchedRule[]> {
  const rules = await prisma.userStyleRule.findMany({
    where: { userId: opts.userId },
  });
  if (rules.length === 0) return [];
  const lc = (s?: string | null) => (s || '').toLowerCase().trim();
  const aud = lc(opts.audienceType);
  const fmt = lc(opts.format);
  const matched = rules.filter(r => {
    const ra = lc(r.scopeAudienceType);
    const rf = lc(r.scopeFormat);
    if (ra && aud && ra !== aud) return false;
    if (rf && fmt && rf !== fmt) return false;
    return true;
  });
  if (matched.length > 0) {
    // Bump lastApplied async (don't block the generation path).
    prisma.userStyleRule.updateMany({
      where: { id: { in: matched.map(r => r.id) } },
      data: { lastApplied: new Date() },
    }).catch((e) => console.error('[userStyleRules] bump failed', e));
  }
  return matched.map(r => ({
    id: r.id, rule: r.rule, scopeAudienceType: r.scopeAudienceType, scopeFormat: r.scopeFormat,
  }));
}

/** Build a system-prompt block from matched rules. Empty when no rules match. */
export function buildRulesBlock(rules: MatchedRule[]): string {
  if (rules.length === 0) return '';
  const lines = rules.map((r, i) => {
    const scopeBits: string[] = [];
    if (r.scopeAudienceType) scopeBits.push(`audience: ${r.scopeAudienceType}`);
    if (r.scopeFormat) scopeBits.push(`format: ${r.scopeFormat}`);
    const scope = scopeBits.length > 0 ? ` (scope — ${scopeBits.join(', ')})` : '';
    return `${i + 1}. ${r.rule}${scope}`;
  }).join('\n');
  return `

USER STYLE RULES — the user has accumulated these from past edits. Treat them as overrides on top of the active base style. Apply each rule that fits the current generation; ignore any whose scope doesn't match. The user authored these via Maria's "I noticed you keep doing X — should I default to that?" prompts, so they reflect the user's voice precisely.

${lines}`;
}

/**
 * Record an edit observation for a user. If after appending the latest
 * shape the rolling window contains 3 similar entries, return the
 * detected pattern so the caller can surface Maria's scoped question.
 *
 * Returns null when the threshold isn't yet reached, or when the
 * characterizer couldn't extract a usable shape.
 */
export async function recordEditObservation(opts: {
  userId: string;
  before: string;
  after: string;
  audienceType?: string;
  format?: string;
}): Promise<DetectedPattern | null> {
  const characterized = await characterizeEdit({ before: opts.before, after: opts.after });
  if (!characterized.shape || characterized.confidence === 'low') return null;
  const user = await prisma.user.findUnique({ where: { id: opts.userId }, select: { settings: true } });
  const settings = (user?.settings as Record<string, any>) || {};
  const prior: EditObservation[] = Array.isArray(settings.editObservations)
    ? (settings.editObservations as any[]).map(o => ({
        shape: String(o?.shape || ''),
        audienceType: typeof o?.audienceType === 'string' ? o.audienceType : undefined,
        format: typeof o?.format === 'string' ? o.format : undefined,
        observedAt: o?.observedAt ? new Date(o.observedAt) : new Date(),
      }))
    : [];
  const next: EditObservation[] = [
    ...prior,
    {
      shape: characterized.shape,
      audienceType: opts.audienceType,
      format: opts.format,
      observedAt: new Date(),
    },
  ].slice(-OBSERVATION_WINDOW);
  await prisma.user.update({
    where: { id: opts.userId },
    data: { settings: { ...settings, editObservations: next.map(o => ({ ...o, observedAt: o.observedAt.toISOString() })) } },
  });
  // Also clear the window once a pattern is detected and stored — see
  // clearObservationsForShape() — so we don't re-fire the same prompt.
  return detectPattern(next);
}

/**
 * Clear out observations whose shape matches the given rule shape so the
 * detector doesn't repeatedly fire the same scoped question after the
 * user has accepted the rule. Called after the user confirms the rule.
 */
export async function clearObservationsForShape(userId: string, ruleShape: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { settings: true } });
  const settings = (user?.settings as Record<string, any>) || {};
  const prior: any[] = Array.isArray(settings.editObservations) ? settings.editObservations : [];
  const lc = ruleShape.toLowerCase();
  const filtered = prior.filter((o) => !String(o?.shape || '').toLowerCase().includes(lc.slice(0, Math.min(20, lc.length))));
  await prisma.user.update({
    where: { id: userId },
    data: { settings: { ...settings, editObservations: filtered } },
  });
}
