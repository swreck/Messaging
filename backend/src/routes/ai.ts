import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { callAI, callAIWithJSON } from '../services/ai.js';
import { ALL_ABOUT_YOU_SYSTEM, ALL_ABOUT_AUDIENCE_SYSTEM, buildCoachingUserContext } from '../prompts/coaching.js';
import { MAPPING_SYSTEM, LOW_CONFIDENCE_QUESTIONS_SYSTEM } from '../prompts/mapping.js';
import { CONVERT_LINES_SYSTEM, REVIEW_SYSTEM, REVISE_FROM_EDITS_SYSTEM, DIRECTION_SYSTEM, REFINE_LANGUAGE_SYSTEM } from '../prompts/generation.js';
import { buildChapterPrompt, BLEND_SYSTEM, JOIN_CHAPTERS_SYSTEM, REFINE_CHAPTER_SYSTEM, COPY_EDIT_SYSTEM, CHAPTER_CRITERIA } from '../prompts/fiveChapter.js';
import { getMediumSpec } from '../prompts/mediums.js';
import { AUDIENCE_DISCOVERY_SYSTEM } from '../prompts/audienceDiscovery.js';
import { getLearning, updateLearning, buildLearningPromptBlock } from '../lib/learning.js';
import {
  isVoiceCheckEnabled,
  isMethodologyCheckEnabled,
  checkStatements,
  checkProse,
  buildViolationFeedback,
  buildProseViolationFeedback,
  type StatementInput,
} from '../services/voiceCheck.js';
import { checkThreeTier, buildThreeTierFeedback, type ThreeTierInput } from '../services/threeTierCheck.js';
import { checkFiveChapter, buildFiveChapterFeedback, type FiveChapterInput } from '../services/fiveChapterCheck.js';
import { checkStatementVoice, buildGuardCorrection } from '../lib/voiceGuard.js';

import { requireWorkspace, requireEditor, requireStoryteller } from '../middleware/workspace.js';

const router = Router();
router.use(requireAuth);
router.use(requireWorkspace);

// ─── Suggestion filtering: drop suggestions that don't add material value ──

/**
 * Normalize text for comparison: lowercase, strip punctuation, collapse whitespace.
 */
function normalizeForCompare(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Token-overlap similarity (Jaccard on content words).
 * Returns 0..1. 1 = identical token bags, 0 = nothing in common.
 */
function similarity(a: string, b: string): number {
  const stop = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been', 'that', 'this', 'these', 'those', 'it', 'its']);
  const toks = (s: string) => new Set(normalizeForCompare(s).split(' ').filter(w => w.length > 2 && !stop.has(w)));
  const as = toks(a);
  const bs = toks(b);
  if (as.size === 0 && bs.size === 0) return 1;
  if (as.size === 0 || bs.size === 0) return 0;
  let inter = 0;
  for (const t of as) if (bs.has(t)) inter++;
  return inter / new Set([...as, ...bs]).size;
}

/**
 * Check if a suggestion adds material improvement over the current text.
 * Rejects: exact match, normalized match, or >=0.85 token-overlap similarity.
 * Ken's rule: Maria must add value or do nothing.
 */
function isMaterialImprovement(suggested: string, current: string, threshold = 0.85): boolean {
  if (!suggested || !current) return !!suggested;
  if (suggested.trim() === current.trim()) return false;
  if (normalizeForCompare(suggested) === normalizeForCompare(current)) return false;
  return similarity(suggested, current) < threshold;
}

/**
 * Filter suggestions coming back from Maria against the current draft state.
 * Drops any that don't materially change their target cell, and any tier3-add
 * that duplicates an existing bullet in that column.
 */
function filterMaterialSuggestions(
  suggestions: { cell: string; suggested: string }[],
  draft: {
    tier1Statement?: { text: string } | null;
    tier2Statements: { text: string; tier3Bullets: { text: string }[] }[];
  },
): { cell: string; suggested: string }[] {
  const kept: { cell: string; suggested: string }[] = [];
  for (const s of suggestions) {
    if (!s.suggested || !s.suggested.trim()) continue;
    // Voice guard: drop suggestions on tier1/tier2 that fail syntactic voice rules
    // (contrast clauses, word count). Better to offer fewer suggestions than bad ones.
    if (s.cell === 'tier1' || /^tier2-\d+$/.test(s.cell)) {
      const voiceCheck = checkStatementVoice(s.suggested);
      if (!voiceCheck.passed) {
        console.log(`[VoiceGuard] Dropping ${s.cell} suggestion "${s.suggested}" — ${voiceCheck.violations.map(v => v.message).join('; ')}`);
        continue;
      }
    }
    if (s.cell === 'tier1') {
      const current = draft.tier1Statement?.text || '';
      if (isMaterialImprovement(s.suggested, current)) kept.push(s);
      continue;
    }
    const t2Match = s.cell.match(/^tier2-(\d+)$/);
    if (t2Match) {
      const idx = parseInt(t2Match[1]);
      const current = draft.tier2Statements[idx]?.text || '';
      if (isMaterialImprovement(s.suggested, current)) kept.push(s);
      continue;
    }
    const t3Match = s.cell.match(/^tier3-(\d+)-(\d+)$/);
    if (t3Match) {
      const t2idx = parseInt(t3Match[1]);
      const t3idx = parseInt(t3Match[2]);
      const current = draft.tier2Statements[t2idx]?.tier3Bullets[t3idx]?.text || '';
      if (isMaterialImprovement(s.suggested, current)) kept.push(s);
      continue;
    }
    const t3AddMatch = s.cell.match(/^tier3-(\d+)-add$/);
    if (t3AddMatch) {
      const t2idx = parseInt(t3AddMatch[1]);
      const existing = draft.tier2Statements[t2idx]?.tier3Bullets.map(b => b.text) || [];
      // Drop add-suggestion if it's already in the column (exact, normalized, or highly similar)
      const isDup = existing.some(e => !isMaterialImprovement(s.suggested, e));
      if (!isDup) kept.push(s);
      continue;
    }
    // Unknown cell type — keep it
    kept.push(s);
  }
  return kept;
}

// ─── Generation helper: pin priority text + validate ─────

interface TierGenResult {
  tier1: { text: string; priorityId: string };
  tier2: { text: string; priorityId: string; categoryLabel: string; tier3: string[] }[];
}

function priorityPreserved(statement: string, priorityText: string): boolean {
  const stop = new Set(['the', 'our', 'my', 'your', 'for', 'of', 'a', 'an', 'to', 'in', 'and', 'is', 'are', 'that', 'this', 'with', 'on', 'at', 'by', 'from', 'it']);
  const words = priorityText.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !stop.has(w));
  if (words.length === 0) return true;
  const beforeBecause = (statement.toLowerCase().split(/\bbecause\b/)[0] || statement.toLowerCase());
  const found = words.filter(w => beforeBecause.includes(w));
  return found.length >= Math.ceil(words.length * 0.5);
}

async function generateTier(
  convertMessage: string,
  rank1Priority: { text: string } | undefined,
): Promise<TierGenResult> {
  // Pin the Rank 1 priority text at the end of the user message
  const reminder = rank1Priority
    ? `\n\n══ CRITICAL ══\nYour Tier 1 MUST begin with the Rank 1 priority text: "${rank1Priority.text}"\nDo NOT substitute a product metric. Use the audience's exact strategic concern.`
    : '';

  let result = await callAIWithJSON<TierGenResult>(CONVERT_LINES_SYSTEM, convertMessage + reminder, 'elite');

  // Enforce maximum 6 Tier 2 columns (doctrinal rule: 5 standard + 1 optional overflow)
  if (result.tier2 && result.tier2.length > 6) {
    console.log(`[TierGen] AI produced ${result.tier2.length} columns, capping at 6`);
    result.tier2 = result.tier2.slice(0, 6);
  }

  // Validate: does Tier 1 actually preserve the priority text?
  if (rank1Priority && !priorityPreserved(result.tier1.text, rank1Priority.text)) {
    const correction = `\n\n══ CORRECTION ══\nYour previous Tier 1 was: "${result.tier1.text}"\nThis substitutes a product metric for the audience's priority. The Rank 1 priority is: "${rank1Priority.text}"\nRewrite Tier 1 so it begins with the audience's strategic concern, then "because [specific hook]." Fix any other Tier 2 statements with the same problem.`;
    result = await callAIWithJSON<TierGenResult>(CONVERT_LINES_SYSTEM, convertMessage + correction, 'elite');
  }

  // Fast regex-based voice guard on Tier 1 and Tier 2 (Ken's Voice Rules 5 + 10).
  // One retry max. This is the cheap safety net the always-on Opus evaluator
  // used to provide before it was turned off for latency.
  const guardCorrections: string[] = [];
  const tier1Check = checkStatementVoice(result.tier1.text);
  if (!tier1Check.passed) {
    guardCorrections.push(buildGuardCorrection(result.tier1.text, tier1Check, 'Tier 1'));
  }
  if (result.tier2) {
    for (const t2 of result.tier2) {
      const t2Check = checkStatementVoice(t2.text);
      if (!t2Check.passed) {
        guardCorrections.push(buildGuardCorrection(t2.text, t2Check, `Tier 2 [${t2.categoryLabel}]`));
      }
    }
  }
  if (guardCorrections.length > 0) {
    console.log(`[VoiceGuard] ${guardCorrections.length} statement violations, retrying generation`);
    const allCorrections = guardCorrections.join('');
    result = await callAIWithJSON<TierGenResult>(CONVERT_LINES_SYSTEM, convertMessage + allCorrections, 'elite');
    if (result.tier2 && result.tier2.length > 6) {
      result.tier2 = result.tier2.slice(0, 6);
    }
  }

  return result;
}

async function generateTierWithVoiceCheck(
  convertMessage: string,
  rank1Priority: { text: string } | undefined,
  userId: string,
  priorities?: { id: string; text: string; rank: number }[],
): Promise<TierGenResult> {
  const result = await generateTier(convertMessage, rank1Priority);

  if (!await isVoiceCheckEnabled(userId)) return result;

  // Extract all statements for voice check, with priority context for P1/P2
  const priorityById = new Map(priorities?.map(p => [p.id, p]) || []);

  const statements: StatementInput[] = [];
  const tier1Priority = priorityById.get(result.tier1.priorityId);
  statements.push({
    text: result.tier1.text,
    column: 'Tier 1',
    priorityText: tier1Priority?.text,
  });
  for (const t2 of result.tier2) {
    const priority = priorityById.get(t2.priorityId);
    statements.push({
      text: t2.text,
      column: t2.categoryLabel,
      priorityText: priority?.text,
    });
  }

  try {
    const check = await checkStatements(statements);
    if (!check.passed) {
      console.log(`[VoiceCheck] ${check.violations.length} statement violations, retrying generation`);
      const feedback = buildViolationFeedback(check.violations);
      return await generateTier(convertMessage + feedback, rank1Priority);
    }
    console.log('[VoiceCheck] All tier statements passed');
  } catch (err) {
    console.error('[VoiceCheck] Statement evaluation failed, continuing:', err);
  }

  // Three Tier methodology check (structural/doctrinal)
  // Gated separately — disabled by default until tested with Ken
  const methodologyCheckEnabled = await isMethodologyCheckEnabled(userId);
  if (!methodologyCheckEnabled) return result;
  try {
    const allPriorities = priorities?.map(p => ({ text: p.text, rank: p.rank })) || [];
    const topPriority = allPriorities.find(p => p.rank === 1) || { text: '', rank: 1 };
    const ttInput: ThreeTierInput = {
      tier1Text: result.tier1.text,
      tier2Statements: result.tier2.map(t2 => ({
        text: t2.text,
        categoryLabel: t2.categoryLabel,
        priorityText: priorityById.get(t2.priorityId)?.text,
        tier3Bullets: t2.tier3 || [],
      })),
      topPriority,
      allPriorities,
      isRefined: false,
    };
    const ttCheck = await checkThreeTier(ttInput);
    if (!ttCheck.passed) {
      console.log(`[ThreeTierCheck] ${ttCheck.checks.filter(c => !c.pass).length} structural issues, retrying generation`);
      const feedback = buildThreeTierFeedback(ttCheck);
      return await generateTier(convertMessage + feedback, rank1Priority);
    }
    console.log('[ThreeTierCheck] All structural checks passed');
  } catch (err) {
    console.error('[ThreeTierCheck] Evaluation failed, returning original:', err);
  }

  return result;
}

// ─── Conversation History ────────────────────────────────

router.get('/conversation/:draftId/:step', async (req: Request, res: Response) => {
  const draftId = req.params.draftId as string;
  const step = parseInt(req.params.step as string);
  const messages = await prisma.conversationMessage.findMany({
    where: { draftId, step },
    orderBy: { createdAt: 'asc' },
    select: { role: true, content: true },
  });
  res.json({ messages });
});

// ─── Interview (Steps 2 & 3) ────────────────────────────

router.post('/coach', requireEditor, async (req: Request, res: Response) => {
  const { draftId, step, message } = req.body;
  if (!draftId || !step || !message) {
    res.status(400).json({ error: 'draftId, step, and message are required' });
    return;
  }

  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: draftId, offering: { workspaceId: req.workspaceId } },
    include: {
      offering: { include: { elements: true } },
      audience: { include: { priorities: { orderBy: { sortOrder: 'asc' } } } },
    },
  });
  if (!draft) {
    res.status(404).json({ error: 'Draft not found' });
    return;
  }

  // Get conversation history
  const history = await prisma.conversationMessage.findMany({
    where: { draftId, step },
    orderBy: { createdAt: 'asc' },
  });

  // Step 2 = offering interview, Step 3 (was 4) = audience interview
  const systemPrompt = step === 2 ? ALL_ABOUT_YOU_SYSTEM : ALL_ABOUT_AUDIENCE_SYSTEM;
  const context = buildCoachingUserContext(
    draft.offering.name,
    draft.offering.smeRole,
    draft.offering.elements.map((e) => e.text),
    draft.audience.priorities.map((p) => ({ text: p.text, rank: p.rank, driver: p.driver }))
  );

  const fullMessage = history.length === 0
    ? `${context}\n\nUser's first message: ${message}`
    : message;

  const conversationHistory = history.map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));

  const response = await callAI(systemPrompt, fullMessage, 'fast', conversationHistory);

  // Save both messages
  await prisma.conversationMessage.createMany({
    data: [
      { draftId, step, role: 'user', content: message },
      { draftId, step, role: 'assistant', content: response },
    ],
  });

  res.json({ response });
});

// ─── Suggest Mappings (Step 5) ──────────────────────────

router.post('/suggest-mappings', requireEditor, async (req: Request, res: Response) => {
  const { draftId } = req.body;
  if (!draftId) {
    res.status(400).json({ error: 'draftId is required' });
    return;
  }

  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: draftId, offering: { workspaceId: req.workspaceId } },
    include: {
      offering: { include: { elements: { orderBy: { sortOrder: 'asc' } } } },
      audience: { include: { priorities: { orderBy: { sortOrder: 'asc' } } } },
    },
  });
  if (!draft) {
    res.status(404).json({ error: 'Draft not found' });
    return;
  }

  const userMessage = `PRIORITIES (ranked by importance):
${draft.audience.priorities.map((p) => `- [ID: ${p.id}] [Rank ${p.rank}] "${p.text}"${p.driver ? ` (Driver: ${p.driver})` : ''}`).join('\n')}

CAPABILITIES/DIFFERENTIATORS:
${draft.offering.elements.map((e) => `- [ID: ${e.id}] "${e.text}"${e.motivatingFactor ? ` (Why someone would care: ${e.motivatingFactor})` : ''}`).join('\n')}

MAPPING GUIDE: A differentiator's "why someone would care" is its motivating factor. When that MF aligns with an audience priority, that's the connection — the Driver on the priority adds persona-specific context for how hard they'll push on it.`;

  const result = await callAIWithJSON<{
    mappings: { priorityId: string; elementId: string; confidence: number; reasoning: string; mfRationale?: string }[];
    orphanElements: string[];
    priorityGaps: string[];
    clarifyingQuestions: string[];
  }>(MAPPING_SYSTEM, userMessage, 'fast');

  res.json(result);
});

// ─── Preview Mapping (read-only) ────────────────────────

router.post('/preview-mapping', requireEditor, async (req: Request, res: Response) => {
  const { draftId } = req.body;
  if (!draftId) {
    res.status(400).json({ error: 'draftId is required' });
    return;
  }

  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: draftId, offering: { workspaceId: req.workspaceId } },
    include: {
      offering: { include: { elements: { orderBy: { sortOrder: 'asc' } } } },
      audience: { include: { priorities: { orderBy: { sortOrder: 'asc' } } } },
    },
  });
  if (!draft) {
    res.status(404).json({ error: 'Draft not found' });
    return;
  }

  const mappingMessage = `PRIORITIES (ranked by importance):
${draft.audience.priorities.map((p) => `- [ID: ${p.id}] [Rank ${p.rank}] "${p.text}" ${p.driver ? `(Driver: ${p.driver})` : ''}`).join('\n')}

CAPABILITIES/DIFFERENTIATORS:
${draft.offering.elements.map((e) => `- [ID: ${e.id}] "${e.text}"`).join('\n')}`;

  const mappingResult = await callAIWithJSON<{
    mappings: { priorityId: string; elementId: string; confidence: number; reasoning: string; mfRationale?: string }[];
    orphanElements: string[];
    priorityGaps: string[];
    clarifyingQuestions: string[];
  }>(MAPPING_SYSTEM, mappingMessage, 'fast');

  // Validate IDs — filter out AI hallucinations
  const validPriorityIds = new Set(draft.audience.priorities.map(p => p.id));
  const validElementIds = new Set(draft.offering.elements.map(e => e.id));

  const validMappings = mappingResult.mappings.filter(m =>
    validPriorityIds.has(m.priorityId) && validElementIds.has(m.elementId)
  );
  const validOrphans = (mappingResult.orphanElements || []).filter(id => validElementIds.has(id));
  const validGaps = (mappingResult.priorityGaps || []).filter(id => validPriorityIds.has(id));

  // Group by priority for human-readable output
  const byPriority = new Map<string, { priorityText: string; rank: number; capabilities: string[]; confidence: number }>();
  for (const m of validMappings) {
    const priority = draft.audience.priorities.find(p => p.id === m.priorityId);
    const element = draft.offering.elements.find(e => e.id === m.elementId);
    if (!priority || !element) continue;

    if (!byPriority.has(m.priorityId)) {
      byPriority.set(m.priorityId, { priorityText: priority.text, rank: priority.rank, capabilities: [], confidence: m.confidence });
    }
    byPriority.get(m.priorityId)!.capabilities.push(element.text);
  }

  const mappings = Array.from(byPriority.values()).sort((a, b) => a.rank - b.rank);
  const gaps = validGaps.map(id => draft.audience.priorities.find(p => p.id === id)?.text).filter(Boolean) as string[];
  const orphans = validOrphans.map(id => draft.offering.elements.find(e => e.id === id)?.text).filter(Boolean) as string[];

  res.json({ mappings, gaps, orphans });
});

// ─── Build Message (orchestrates mapping + convert) ─────

router.post('/build-message', requireEditor, async (req: Request, res: Response) => {
  const { draftId } = req.body;
  if (!draftId) {
    res.status(400).json({ error: 'draftId is required' });
    return;
  }

  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: draftId, offering: { workspaceId: req.workspaceId } },
    include: {
      offering: { include: { elements: { orderBy: { sortOrder: 'asc' } } } },
      audience: { include: { priorities: { orderBy: { sortOrder: 'asc' } } } },
    },
  });
  if (!draft) {
    res.status(404).json({ error: 'Draft not found' });
    return;
  }

  // Step 1: Suggest mappings
  const mappingMessage = `PRIORITIES (ranked by importance):
${draft.audience.priorities.map((p) => `- [ID: ${p.id}] [Rank ${p.rank}] "${p.text}" ${p.driver ? `(Driver: ${p.driver})` : ''}`).join('\n')}

CAPABILITIES/DIFFERENTIATORS:
${draft.offering.elements.map((e) => `- [ID: ${e.id}] "${e.text}"`).join('\n')}`;

  const mappingResult = await callAIWithJSON<{
    mappings: { priorityId: string; elementId: string; confidence: number; reasoning: string; mfRationale?: string }[];
    orphanElements: string[];
    priorityGaps: string[];
    clarifyingQuestions: string[];
  }>(MAPPING_SYSTEM, mappingMessage, 'fast');

  // Validate IDs — filter out AI hallucinations
  const validPriorityIds = new Set(draft.audience.priorities.map(p => p.id));
  const validElementIds = new Set(draft.offering.elements.map(e => e.id));

  const allValidMappings = mappingResult.mappings.filter(m =>
    validPriorityIds.has(m.priorityId) && validElementIds.has(m.elementId)
  );

  // Step 2: Auto-confirm high-confidence, collect low-confidence (dynamic threshold)
  const learning = await getLearning(req.user!.userId);
  const threshold = learning.questionThreshold;
  const highConfidence = allValidMappings.filter(m => m.confidence >= threshold);
  const lowConfidence = allValidMappings.filter(m => m.confidence < threshold && m.confidence >= 0.5);

  // Filter orphans and gaps too
  const validOrphans = (mappingResult.orphanElements || []).filter(id => validElementIds.has(id));
  const validGaps = (mappingResult.priorityGaps || []).filter(id => validPriorityIds.has(id));

  // Save all mappings, including the per-mapping mfRationale Maria wrote
  await prisma.mapping.deleteMany({ where: { draftId, status: 'suggested' } });
  for (const m of highConfidence) {
    await prisma.mapping.create({
      data: { draftId, priorityId: m.priorityId, elementId: m.elementId, confidence: m.confidence, status: 'confirmed', mfRationale: m.mfRationale || '' },
    });
  }
  for (const m of lowConfidence) {
    await prisma.mapping.create({
      data: { draftId, priorityId: m.priorityId, elementId: m.elementId, confidence: m.confidence, status: 'suggested', mfRationale: m.mfRationale || '' },
    });
  }

  // Step 3: If low-confidence items exist, generate natural-language questions
  let questions: { question: string; priorityId: string; elementId: string }[] = [];
  if (lowConfidence.length > 0 || validGaps.length > 0) {
    const questionContext = `UNCERTAIN MAPPINGS:
${lowConfidence.map(m => {
  const priority = draft.audience.priorities.find(p => p.id === m.priorityId);
  const element = draft.offering.elements.find(e => e.id === m.elementId);
  return `- Priority "${priority?.text}" <-> Capability "${element?.text}" (confidence: ${m.confidence})`;
}).join('\n')}

PRIORITY GAPS (no matching capability):
${validGaps.map(id => {
  const priority = draft.audience.priorities.find(p => p.id === id);
  return `- "${priority?.text}"`;
}).join('\n')}`;

    const qResult = await callAIWithJSON<{
      questions: { question: string; priorityId: string; elementId: string }[];
    }>(LOW_CONFIDENCE_QUESTIONS_SYSTEM, questionContext, 'fast');
    questions = qResult.questions || [];

    // Deduplicate questions by priorityId+elementId
    const seen = new Set<string>();
    questions = questions.filter(q => {
      const key = `${q.priorityId}:${q.elementId || 'gap'}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // If no questions needed, auto-generate the three tier
  if (questions.length === 0) {
    // All confirmed — proceed to convert lines
    const confirmedMappings = await prisma.mapping.findMany({
      where: { draftId, status: 'confirmed' },
      include: { priority: true, element: true },
    });

    const byPriority = new Map<string, { priority: any; elements: any[] }>();
    for (const m of confirmedMappings) {
      if (!byPriority.has(m.priorityId)) {
        byPriority.set(m.priorityId, { priority: m.priority, elements: [] });
      }
      byPriority.get(m.priorityId)!.elements.push(m.element);
    }

    // Resolve orphan capabilities for Social Proof / Focus columns
    const mappedElementIds = new Set(confirmedMappings.map(m => m.elementId));
    const orphanElements = draft.offering.elements.filter(e => !mappedElementIds.has(e.id));

    const learningBlock = buildLearningPromptBlock(learning);
    const convertMessage = `CONFIRMED MAPPINGS (grouped by priority, in rank order):
${draft.audience.priorities
  .filter((p) => byPriority.has(p.id))
  .map((p) => {
    const group = byPriority.get(p.id)!;
    return `Priority [ID: ${p.id}] [Rank ${p.rank}]: "${p.text}"
  Driver (why this matters to them): ${p.driver || 'not specified'}
  Mapped capabilities: ${group.elements.map((e: any) => `"${e.text}"`).join(', ')}`;
  })
  .join('\n\n')}
${orphanElements.length > 0 ? `\nORPHAN CAPABILITIES (not mapped to any priority — use for Social Proof or Focus columns):\n${orphanElements.map(e => `- "${e.text}"`).join('\n')}` : ''}${learningBlock}
AUDIENCE: ${draft.audience?.name || 'Not specified'}`;

    const rank1 = draft.audience.priorities.find((p) => p.rank === 1);
    const tierResult = await generateTierWithVoiceCheck(convertMessage, rank1 || undefined, req.user!.userId, draft.audience.priorities);

    res.json({ status: 'complete', result: tierResult, questions: [] });
    return;
  }

  res.json({ status: 'questions', questions, result: null });
});

// ─── Resolve Questions (follow-up to build-message) ─────

router.post('/resolve-questions', requireEditor, async (req: Request, res: Response) => {
  const { draftId, answers } = req.body;
  if (!draftId || !answers) {
    res.status(400).json({ error: 'draftId and answers are required' });
    return;
  }

  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: draftId, offering: { workspaceId: req.workspaceId } },
    include: {
      offering: { include: { elements: { orderBy: { sortOrder: 'asc' } } } },
      audience: { include: { priorities: { orderBy: { sortOrder: 'asc' } } } },
    },
  });
  if (!draft) {
    res.status(404).json({ error: 'Draft not found' });
    return;
  }

  // Process answers: confirm or reject suggested mappings, collect user context
  const userContext: string[] = [];
  const typedAnswers = answers as { priorityId: string; elementId: string; confirmed: boolean; context?: string }[];
  for (const answer of typedAnswers) {
    if (answer.elementId) {
      await prisma.mapping.updateMany({
        where: { draftId, priorityId: answer.priorityId, elementId: answer.elementId, status: 'suggested' },
        data: { status: answer.confirmed ? 'confirmed' : 'rejected' },
      });
    }
    // Collect user explanations for the generation prompt
    if (answer.context) {
      const priority = draft.audience.priorities.find(p => p.id === answer.priorityId);
      userContext.push(`Regarding "${priority?.text || answer.priorityId}": ${answer.context}`);
    }
  }

  // Track question answers for learning
  const learning = await getLearning(req.user!.userId);
  const confirmedCount = typedAnswers.filter(a => a.confirmed).length;
  const newSeen = learning.questionsSeen + typedAnswers.length;
  const newConfirmed = learning.questionsConfirmed + confirmedCount;
  // Adjust threshold: high confirmation rate → raise (fewer questions), low → lower (more questions)
  let newThreshold = learning.questionThreshold;
  if (newSeen >= 10) {
    const rate = newConfirmed / newSeen;
    if (rate > 0.85 && newThreshold < 0.85) newThreshold = Math.min(newThreshold + 0.05, 0.85);
    else if (rate < 0.5 && newThreshold > 0.5) newThreshold = Math.max(newThreshold - 0.05, 0.5);
  }
  await updateLearning(req.user!.userId, {
    questionsSeen: newSeen,
    questionsConfirmed: newConfirmed,
    questionThreshold: newThreshold,
  });

  // Now convert all confirmed mappings to tier statements
  const confirmedMappings = await prisma.mapping.findMany({
    where: { draftId, status: 'confirmed' },
    include: { priority: true, element: true },
  });

  const byPriority = new Map<string, { priority: any; elements: any[] }>();
  for (const m of confirmedMappings) {
    if (!byPriority.has(m.priorityId)) {
      byPriority.set(m.priorityId, { priority: m.priority, elements: [] });
    }
    byPriority.get(m.priorityId)!.elements.push(m.element);
  }

  // Resolve orphan capabilities for Social Proof / Focus columns
  const mappedElementIds = new Set(confirmedMappings.map(m => m.elementId));
  const orphanElements = draft.offering.elements.filter(e => !mappedElementIds.has(e.id));

  const learningBlock = buildLearningPromptBlock(learning);
  const convertMessage = `CONFIRMED MAPPINGS (grouped by priority, in rank order):
${draft.audience.priorities
  .filter((p) => byPriority.has(p.id))
  .map((p) => {
    const group = byPriority.get(p.id)!;
    return `Priority [ID: ${p.id}] [Rank ${p.rank}]: "${p.text}"
  Driver (why this matters to them): ${p.driver || 'not specified'}
  Mapped capabilities: ${group.elements.map((e: any) => `"${e.text}"`).join(', ')}`;
  })
  .join('\n\n')}
${orphanElements.length > 0 ? `\nORPHAN CAPABILITIES (not mapped to any priority — use for Social Proof or Focus columns):\n${orphanElements.map(e => `- "${e.text}"`).join('\n')}` : ''}
${userContext.length > 0 ? `\nUSER NOTES (the user provided these clarifications during review):\n${userContext.join('\n')}` : ''}${learningBlock}
AUDIENCE: ${draft.audience?.name || 'Not specified'}`;

  const rank1 = draft.audience.priorities.find((p) => p.rank === 1);
  const tierResult = await generateTierWithVoiceCheck(convertMessage, rank1 || undefined, req.user!.userId, draft.audience.priorities);

  res.json({ status: 'complete', result: tierResult });
});

// ─── Convert Lines (Step 6 — kept for backward compatibility) ─

router.post('/convert-lines', requireEditor, async (req: Request, res: Response) => {
  const { draftId } = req.body;
  if (!draftId) {
    res.status(400).json({ error: 'draftId is required' });
    return;
  }

  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: draftId, offering: { workspaceId: req.workspaceId } },
    include: {
      mappings: {
        where: { status: 'confirmed' },
        include: {
          priority: true,
          element: true,
        },
      },
      offering: { include: { elements: { orderBy: { sortOrder: 'asc' } } } },
      audience: { include: { priorities: { orderBy: { sortOrder: 'asc' } } } },
    },
  });
  if (!draft) {
    res.status(404).json({ error: 'Draft not found' });
    return;
  }

  // Group mappings by priority
  const byPriority = new Map<string, { priority: any; elements: any[] }>();
  for (const m of draft.mappings) {
    if (!byPriority.has(m.priorityId)) {
      byPriority.set(m.priorityId, { priority: m.priority, elements: [] });
    }
    byPriority.get(m.priorityId)!.elements.push(m.element);
  }

  // Resolve orphan capabilities for Social Proof / Focus columns
  const mappedElementIds = new Set(draft.mappings.map(m => m.elementId));
  const orphanElements = draft.offering.elements.filter(e => !mappedElementIds.has(e.id));

  const convertLearning = await getLearning(req.user!.userId);
  const convertLearningBlock = buildLearningPromptBlock(convertLearning);
  const userMessage = `CONFIRMED MAPPINGS (grouped by priority, in rank order):
${draft.audience.priorities
  .filter((p) => byPriority.has(p.id))
  .map((p) => {
    const group = byPriority.get(p.id)!;
    return `Priority [ID: ${p.id}] [Rank ${p.rank}]: "${p.text}"
  Driver (why this matters to them): ${p.driver || 'not specified'}
  Mapped capabilities: ${group.elements.map((e) => `"${e.text}"`).join(', ')}`;
  })
  .join('\n\n')}
${orphanElements.length > 0 ? `\nORPHAN CAPABILITIES (not mapped to any priority — use for Social Proof or Focus columns):\n${orphanElements.map(e => `- "${e.text}"`).join('\n')}` : ''}${convertLearningBlock}
AUDIENCE: ${draft.audience?.name || 'Not specified'}`;

  const rank1 = draft.audience.priorities.find((p) => p.rank === 1);
  const result = await generateTierWithVoiceCheck(userMessage, rank1 || undefined, req.user!.userId, draft.audience.priorities);

  res.json(result);
});

// ─── Review (inline suggestions) ────────────────────────

router.post('/review', requireEditor, async (req: Request, res: Response) => {
  const { draftId } = req.body;
  if (!draftId) { res.status(400).json({ error: 'draftId required' }); return; }

  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: draftId, offering: { workspaceId: req.workspaceId } },
    include: {
      tier1Statement: true,
      tier2Statements: { orderBy: { sortOrder: 'asc' }, include: { tier3Bullets: { orderBy: { sortOrder: 'asc' } } } },
      audience: { include: { priorities: { orderBy: { sortOrder: 'asc' } } } },
    },
  });
  if (!draft) { res.status(404).json({ error: 'Draft not found' }); return; }

  const userMessage = `THREE TIER TABLE:
Tier 1 [cell: tier1]: "${draft.tier1Statement?.text || '(empty)'}"

Tier 2 statements:
${draft.tier2Statements.map((t2, i) => `[cell: tier2-${i}] "${t2.text}"
  Tier 3 bullets: ${t2.tier3Bullets.map((t3, j) => `[cell: tier3-${i}-${j}] "${t3.text}"`).join(', ') || '(none)'}`).join('\n')}

AUDIENCE PRIORITIES:
${draft.audience.priorities.map((p) => `[Rank ${p.rank}] "${p.text}"`).join('\n')}`;

  const result = await callAIWithJSON<{ suggestions: { cell: string; suggested: string }[] }>(REVIEW_SYSTEM, userMessage, 'elite');

  // Post-process: convert tier3 suggestions that reference non-existent indices to "add" format.
  // The AI sometimes returns tier3-X-Y where Y is beyond the existing bullets — that means
  // "add a new proof point", not "replace existing". Convert to tier3-X-add so the frontend
  // handles it correctly.
  if (result.suggestions) {
    const addKeys = new Set<string>();
    result.suggestions = result.suggestions.map(s => {
      const t3Match = s.cell.match(/^tier3-(\d+)-(\d+)$/);
      if (t3Match) {
        const t2Index = parseInt(t3Match[1]);
        const t3Index = parseInt(t3Match[2]);
        const t2 = draft.tier2Statements[t2Index];
        if (t2 && t3Index >= t2.tier3Bullets.length) {
          // This index doesn't exist — convert to "add"
          const addKey = `tier3-${t2Index}-add`;
          // Only allow one "add" per column; skip duplicates
          if (addKeys.has(addKey)) return null;
          addKeys.add(addKey);
          return { ...s, cell: addKey };
        }
      }
      return s;
    }).filter((s): s is { cell: string; suggested: string } => s !== null);

    // Drop suggestions that don't materially improve on what's already there.
    result.suggestions = filterMaterialSuggestions(result.suggestions, draft);
  }

  res.json(result);
});

// ─── Refine Language ────────────────────────────────────

router.post('/refine-language', requireEditor, async (req: Request, res: Response) => {
  const { draftId } = req.body;
  if (!draftId) { res.status(400).json({ error: 'draftId required' }); return; }

  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: draftId, offering: { workspaceId: req.workspaceId } },
    include: {
      tier1Statement: true,
      tier2Statements: { orderBy: { sortOrder: 'asc' }, include: { tier3Bullets: { orderBy: { sortOrder: 'asc' } }, priority: true } },
      audience: { include: { priorities: { orderBy: { sortOrder: 'asc' } } } },
    },
  });
  if (!draft) { res.status(404).json({ error: 'Draft not found' }); return; }

  const tier1Text = draft.tier1Statement?.text || '';
  const topPriority = draft.audience.priorities[0];

  const userMessage = `TIER 1 STATEMENT TO REFINE:
"${tier1Text}"
Top priority (Rank 1): "${topPriority?.text || ''}"
Driver (why this matters to them): "${topPriority?.driver || 'not provided'}"

TIER 2 STATEMENTS TO REFINE:
${draft.tier2Statements.map((t2, i) => `[${i}] "${t2.text}"`).join('\n')}

AUDIENCE PRIORITIES (for reference — the priority text must remain visible in each statement):
${draft.audience.priorities.map((p) => `[Rank ${p.rank}] "${p.text}"${p.driver ? ` (Driver: ${p.driver})` : ''}`).join('\n')}`;

  let result = await callAIWithJSON<{
    refinedTier1?: { best: string; alternative: string };
    refinedTier2: { index: number; text: string }[];
  }>(REFINE_LANGUAGE_SYSTEM, userMessage, 'elite');

  // Voice check refined statements (with priority context for P1/P2)
  if (await isVoiceCheckEnabled(req.user!.userId)) {
    try {
      const statements: StatementInput[] = result.refinedTier2.map(r => ({
        text: r.text,
        column: draft.tier2Statements[r.index]?.categoryLabel || 'Product',
        priorityText: (draft.tier2Statements[r.index] as any)?.priority?.text,
      }));
      const check = await checkStatements(statements);
      if (!check.passed) {
        console.log(`[VoiceCheck] Refine language: ${check.violations.length} violations, retrying`);
        const feedback = buildViolationFeedback(check.violations);
        result = await callAIWithJSON<{
          refinedTier2: { index: number; text: string }[];
        }>(REFINE_LANGUAGE_SYSTEM, userMessage + feedback, 'elite');
      } else {
        console.log('[VoiceCheck] Refined statements all passed');
      }
    } catch (err) {
      console.error('[VoiceCheck] Refine language evaluation failed, returning original:', err);
    }
  }

  res.json(result);
});

// ─── Revise from user edits ─────────────────────────────

router.post('/revise', requireEditor, async (req: Request, res: Response) => {
  const { draftId, previousState } = req.body;
  if (!draftId || !previousState) { res.status(400).json({ error: 'draftId and previousState are required' }); return; }

  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: draftId, offering: { workspaceId: req.workspaceId } },
    include: {
      tier1Statement: true,
      tier2Statements: { orderBy: { sortOrder: 'asc' }, include: { tier3Bullets: { orderBy: { sortOrder: 'asc' } } } },
    },
  });
  if (!draft) { res.status(404).json({ error: 'Draft not found' }); return; }

  const userMessage = `PREVIOUS TABLE STATE:
Tier 1: "${previousState.tier1 || '(empty)'}"
${(previousState.tier2 || []).map((t2: any, i: number) => `Tier 2 #${i}: "${t2.text}"
  Tier 3: ${(t2.tier3 || []).map((t3: string, j: number) => `[${j}] "${t3}"`).join(', ') || '(none)'}`).join('\n')}

CURRENT TABLE STATE:
Tier 1 [cell: tier1]: "${draft.tier1Statement?.text || '(empty)'}"
${draft.tier2Statements.map((t2, i) => `[cell: tier2-${i}] "${t2.text}"
  Tier 3: ${t2.tier3Bullets.map((t3, j) => `[cell: tier3-${i}-${j}] "${t3.text}"`).join(', ') || '(none)'}`).join('\n')}`;

  const result = await callAIWithJSON<{ suggestions: { cell: string; suggested: string }[] }>(REVISE_FROM_EDITS_SYSTEM, userMessage, 'elite');
  // Drop suggestions that don't materially improve on what's already there
  if (result.suggestions) {
    result.suggestions = filterMaterialSuggestions(result.suggestions, draft);
  }
  res.json(result);
});

// ─── Polish (methodology evaluator) ──────────────────────

router.post('/polish', requireEditor, async (req: Request, res: Response) => {
  const { draftId } = req.body;
  if (!draftId) { res.status(400).json({ error: 'draftId required' }); return; }

  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: draftId, offering: { workspaceId: req.workspaceId } },
    include: {
      tier1Statement: true,
      tier2Statements: { orderBy: { sortOrder: 'asc' }, include: { tier3Bullets: { orderBy: { sortOrder: 'asc' } }, priority: true } },
      audience: { include: { priorities: { orderBy: { sortOrder: 'asc' } } } },
      offering: { include: { elements: true } },
    },
  });
  if (!draft) { res.status(404).json({ error: 'Draft not found' }); return; }

  // Run the Three Tier methodology evaluator
  const allPriorities = draft.audience.priorities.map(p => ({ text: p.text, rank: p.rank }));
  const topPriority = allPriorities.find(p => p.rank === 1) || { text: '', rank: 1 };

  const ttInput: ThreeTierInput = {
    tier1Text: draft.tier1Statement?.text || '',
    tier2Statements: draft.tier2Statements.map(t2 => ({
      text: t2.text,
      categoryLabel: t2.categoryLabel || '',
      priorityText: t2.priority?.text,
      tier3Bullets: t2.tier3Bullets.map(t3 => t3.text),
    })),
    topPriority,
    allPriorities,
    isRefined: true, // Polish runs on refined/edited text, not first draft
  };

  const ttCheck = await checkThreeTier(ttInput);

  // Convert evaluator findings into suggestions via a direction call
  if (ttCheck.passed) {
    res.json({ suggestions: [], message: 'Everything looks solid.' });
    return;
  }

  // Use the findings as a direction to generate specific improvements
  const findings = ttCheck.checks.filter(c => !c.pass).map(c => `${c.id}: ${c.detail}`).join('\n');

  const { DIRECTION_SYSTEM } = await import('../prompts/generation.js');
  const dirMessage = `USER'S DIRECTION: Fix these methodology issues found by quality check:\n${findings}

CURRENT THREE TIER TABLE:
Tier 1: "${draft.tier1Statement?.text || '(empty)'}"

Tier 2 statements:
${draft.tier2Statements.map((t2, i) => `${i + 1}. [${t2.categoryLabel || 'unlabeled'}] "${t2.text}"
   Tier 3 bullets: ${t2.tier3Bullets.map(t3 => `"${t3.text}"`).join(', ') || '(none)'}`).join('\n')}

AUDIENCE PRIORITIES:
${draft.audience.priorities.map(p => `[Rank ${p.rank}] "${p.text}"`).join('\n')}

OFFERING CAPABILITIES:
${draft.offering.elements.map(e => `"${e.text}"`).join('\n')}`;

  const result = await callAIWithJSON<{ suggestions: { cell: string; suggested: string }[] }>(DIRECTION_SYSTEM, dirMessage, 'elite');

  // Drop suggestions that don't materially improve on what's already there.
  // Maria's job is to add value or do nothing — identical or near-identical suggestions are noise.
  if (result.suggestions) {
    const before = result.suggestions.length;
    result.suggestions = filterMaterialSuggestions(result.suggestions, draft);
    if (result.suggestions.length !== before) {
      console.log(`[Polish] Filtered ${before - result.suggestions.length}/${before} non-material suggestions`);
    }
  }

  // If every suggestion was filtered out, tell the user nothing meaningful is to be improved
  if (!result.suggestions || result.suggestions.length === 0) {
    res.json({ suggestions: [], message: 'Nothing meaningful to improve right now.' });
    return;
  }

  res.json(result);
});

// ─── Polish Story (voice check for Five Chapter Stories) ──────
router.post('/polish-story', requireEditor, async (req: Request, res: Response) => {
  const { storyId } = req.body;
  if (!storyId) { res.status(400).json({ error: 'storyId required' }); return; }

  const story = await prisma.fiveChapterStory.findFirst({
    where: { id: storyId, draft: { offering: { workspaceId: req.workspaceId } } },
    include: { chapters: { orderBy: { chapterNum: 'asc' } } },
  });
  if (!story) { res.status(404).json({ error: 'Story not found' }); return; }

  // Polish means IMPROVE — check for violations, then rewrite to fix them.
  // The user gets back better text, not a list of problems.
  const polishedChapters: { chapter: number; improved: boolean }[] = [];
  let anyImproved = false;

  // If blended text exists, polish the blended text as a whole
  if (story.blendedText && story.blendedText.trim()) {
    const check = await checkProse(story.blendedText, `Blended Five Chapter Story (${story.medium} format)`);
    if (!check.passed && check.violations.length > 0) {
      const feedback = buildProseViolationFeedback(check.violations);
      let improved = await callAI(
        `You are a careful editor. Rewrite this text to fix the specific voice violations listed below. Keep the same content, structure, and approximate length. Only change what needs fixing.${feedback}`,
        `TEXT TO POLISH:\n${story.blendedText}\n\nReturn ONLY the polished text.`,
        'elite'
      );
      // Verify the rewrite didn't introduce new violations
      const recheck = await checkProse(improved, `Polished Five Chapter Story (${story.medium} format)`);
      if (!recheck.passed && recheck.violations.length > 0) {
        const recheckFeedback = buildProseViolationFeedback(recheck.violations);
        improved = await callAI(
          `You are a careful editor. Your previous rewrite introduced new voice violations. Fix them while keeping the content intact.${recheckFeedback}`,
          `TEXT TO FIX:\n${improved}\n\nReturn ONLY the fixed text.`,
          'elite'
        );
      }
      // Save polished blended text
      await prisma.fiveChapterStory.update({
        where: { id: storyId },
        data: { blendedText: improved, stage: 'polished', version: { increment: 1 } },
      });
      // Snapshot for version history
      const maxVer = await prisma.storyVersion.aggregate({
        where: { storyId },
        _max: { versionNum: true },
      });
      await prisma.storyVersion.create({
        data: {
          storyId,
          snapshot: { blendedText: improved, stage: 'blended', medium: story.medium },
          label: 'Polished',
          versionNum: (maxVer._max?.versionNum ?? 0) + 1,
        },
      });
      anyImproved = true;
    }
  } else {
    // No blended text — polish individual chapters
    for (const ch of story.chapters) {
      if (!ch.content || ch.content.trim().length === 0) continue;
      const check = await checkProse(ch.content, `Chapter ${ch.chapterNum}: ${ch.title || ''} of a Five Chapter Story (${story.medium} format)`);

      if (!check.passed && check.violations.length > 0) {
        const feedback = buildProseViolationFeedback(check.violations);
        const improved = await callAI(
          `You are a careful editor. Rewrite this chapter to fix the specific voice violations listed below. Keep the same content, structure, and approximate length. Only change what needs fixing.${feedback}`,
          `CHAPTER TO POLISH:\n${ch.content}\n\nReturn ONLY the polished chapter.`,
          'elite'
        );
        // Update chapter
        await prisma.chapterContent.update({
          where: { id: ch.id },
          data: { content: improved },
        });
        // Version record
        const maxVer = await prisma.chapterVersion.aggregate({
          where: { chapterContentId: ch.id },
          _max: { versionNum: true },
        });
        await prisma.chapterVersion.create({
          data: {
            chapterContentId: ch.id,
            title: ch.title,
            content: improved,
            versionNum: (maxVer._max?.versionNum ?? 0) + 1,
            changeSource: 'polished',
          },
        });
        polishedChapters.push({ chapter: ch.chapterNum, improved: true });
        anyImproved = true;
      } else {
        polishedChapters.push({ chapter: ch.chapterNum, improved: false });
      }
    }
  }

  // Return updated story
  const updated = await prisma.fiveChapterStory.findUnique({
    where: { id: storyId },
    include: { chapters: { orderBy: { chapterNum: 'asc' } } },
  });

  res.json({
    story: updated,
    improved: anyImproved,
    chapters: polishedChapters,
  });
});

// ─── Direction (big-picture user feedback) ───────────────

router.post('/direction', requireEditor, async (req: Request, res: Response) => {
  const { draftId, direction } = req.body;
  if (!draftId || !direction) { res.status(400).json({ error: 'draftId and direction are required' }); return; }

  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: draftId, offering: { workspaceId: req.workspaceId } },
    include: {
      tier1Statement: true,
      tier2Statements: { orderBy: { sortOrder: 'asc' }, include: { tier3Bullets: { orderBy: { sortOrder: 'asc' } } } },
      audience: { include: { priorities: { orderBy: { sortOrder: 'asc' } } } },
      offering: { include: { elements: true } },
    },
  });
  if (!draft) { res.status(404).json({ error: 'Draft not found' }); return; }

  const userMessage = `USER'S DIRECTION: ${direction}

CURRENT THREE TIER TABLE:
Tier 1: "${draft.tier1Statement?.text || '(empty)'}"

Tier 2 statements:
${draft.tier2Statements.map((t2, i) => `${i + 1}. [${t2.categoryLabel || 'unlabeled'}] "${t2.text}"
   Tier 3 bullets: ${t2.tier3Bullets.map((t3) => `"${t3.text}"`).join(', ') || '(none)'}`).join('\n')}

AUDIENCE PRIORITIES:
${draft.audience.priorities.map((p) => `[Rank ${p.rank}] "${p.text}"`).join('\n')}

OFFERING CAPABILITIES:
${draft.offering.elements.map((e) => `"${e.text}"`).join('\n')}`;

  const result = await callAIWithJSON<{ suggestions: { cell: string; suggested: string }[] }>(DIRECTION_SYSTEM, userMessage, 'elite');
  // Drop suggestions that don't materially improve — Maria's job is to add value or do nothing
  if (result.suggestions) {
    result.suggestions = filterMaterialSuggestions(result.suggestions, draft);
  }
  res.json(result);
});

// ─── Derive Driver for a Priority ───────────────────────

router.post('/derive-driver', requireEditor, async (req: Request, res: Response) => {
  const { priorityId, audienceId, offeringId } = req.body;
  if (!priorityId || !audienceId) {
    res.status(400).json({ error: 'priorityId and audienceId are required' });
    return;
  }

  const priority = await prisma.priority.findFirst({
    where: { id: priorityId, audience: { id: audienceId, workspaceId: req.workspaceId } },
    include: { audience: true },
  });
  if (!priority) {
    res.status(404).json({ error: 'Priority not found' });
    return;
  }

  // Optionally include offering context
  let offeringContext = '';
  if (offeringId) {
    const offering = await prisma.offering.findFirst({
      where: { id: offeringId, workspaceId: req.workspaceId },
      include: { elements: true },
    });
    if (offering) {
      offeringContext = `\nOFFERING: ${offering.name}\nCAPABILITIES: ${offering.elements.map(e => e.text).join(', ')}`;
    }
  }

  const systemPrompt = `You are a messaging strategist. Given an audience and their top priority, derive the DRIVER — why this priority matters so deeply to THIS specific persona. Go beyond the surface: understand the domain, the stakes, the personal and business consequences. Write one clear, specific sentence that captures the real stake.

A driver is persona-specific. It explains why the named audience cares about this priority in a way that another audience would not. Lean into the specific context of this persona.

Do NOT write "Because you want X" or narrate. Write from the perspective of understanding the business reality.

GOOD: "Reliable pathology results in minutes means clinicians can begin targeted treatment during the same visit, dramatically improving outcomes."
BAD: "Because you want faster results."
BAD: "Getting results quickly is important to clinical leads."

Return ONLY the driver sentence, nothing else.`;

  const userMessage = `AUDIENCE: ${priority.audience.name}
TOP PRIORITY: "${priority.text}"${offeringContext}

Derive the driver for this priority.`;

  const driverText = await callAI(systemPrompt, userMessage, 'fast');

  // Save it to the priority
  await prisma.priority.update({
    where: { id: priorityId },
    data: { driver: driverText.trim() },
  });

  res.json({ driver: driverText.trim() });
});

// ─── Draft MFs for differentiators on an offering ──────────
//
// Used by the "Maria, draft MFs for me" affordance. Drafts MFs to the
// audience-portable standard (general principle + 2-4 example audience
// types). Runs mfCheck.ts evaluator, retries once if violations found.
// Saves results to OfferingElement.motivatingFactor and returns the new
// MFs so the UI can refresh.

router.post('/draft-mfs', requireEditor, async (req: Request, res: Response) => {
  const { offeringId, elementIds } = req.body as { offeringId: string; elementIds?: string[] };
  if (!offeringId) {
    res.status(400).json({ error: 'offeringId is required' });
    return;
  }

  const offering = await prisma.offering.findFirst({
    where: { id: offeringId, workspaceId: req.workspaceId },
    include: { elements: { orderBy: { sortOrder: 'asc' } } },
  });
  if (!offering) {
    res.status(404).json({ error: 'Offering not found' });
    return;
  }

  // Targets: explicit elementIds if given, otherwise every element with no MF
  const targets = elementIds
    ? offering.elements.filter(e => elementIds.includes(e.id))
    : offering.elements.filter(e => !e.motivatingFactor);

  if (targets.length === 0) {
    res.json({ drafted: [], skipped: 'no eligible differentiators' });
    return;
  }

  const { draftMfsForOffering } = await import('../lib/draftMfs.js');
  const drafted = await draftMfsForOffering(offering, targets);

  for (const d of drafted) {
    await prisma.offeringElement.update({
      where: { id: d.elementId },
      data: { motivatingFactor: d.mf },
    });
  }

  res.json({ drafted });
});

// ─── Five Chapter Story ─────────────────────────────────

router.post('/generate-chapter', requireStoryteller, async (req: Request, res: Response) => {
  const { storyId, chapterNum } = req.body;
  if (!storyId || !chapterNum) {
    res.status(400).json({ error: 'storyId and chapterNum are required' });
    return;
  }

  const story = await prisma.fiveChapterStory.findFirst({
    where: { id: storyId, draft: { offering: { workspaceId: req.workspaceId } } },
    include: {
      draft: {
        include: {
          tier1Statement: true,
          tier2Statements: { orderBy: { sortOrder: 'asc' }, include: { tier3Bullets: { orderBy: { sortOrder: 'asc' } }, priority: true } },
          offering: { include: { elements: true } },
          audience: { include: { priorities: { orderBy: { sortOrder: 'asc' } } } },
        },
      },
      chapters: true,
    },
  });
  if (!story) {
    res.status(404).json({ error: 'Story not found' });
    return;
  }

  // Check driver for top priority (#1) only
  const topPriority = story.draft.audience.priorities[0];
  if (topPriority && !topPriority.driver) {
    res.status(400).json({
      error: 'A driver is needed for the top priority before generating a Five Chapter Story — it helps Maria understand why this matters to the audience',
      missingTopPriority: { id: topPriority.id, text: topPriority.text },
    });
    return;
  }

  // Parse emphasis chapter number if provided (e.g. "ch3" or just a string)
  const emphasisMatch = story.emphasis?.match(/^ch(\d)$/i);
  const emphasisChapter = emphasisMatch ? parseInt(emphasisMatch[1]) : undefined;

  // If this story was derived from another deliverable, include source content for conversion
  let sourceContent: { medium: string; chapterText: string } | undefined;
  if (story.sourceStoryId) {
    const sourceStory = await prisma.fiveChapterStory.findUnique({
      where: { id: story.sourceStoryId },
      include: { chapters: { where: { chapterNum } } },
    });
    if (sourceStory && sourceStory.chapters.length > 0) {
      const sourceMediumSpec = getMediumSpec(sourceStory.medium);
      sourceContent = {
        medium: sourceMediumSpec?.label || sourceStory.medium,
        chapterText: sourceStory.chapters[0].content,
      };
    }
  }

  const systemPrompt = buildChapterPrompt(chapterNum, story.medium, emphasisChapter, sourceContent);
  const ch = CHAPTER_CRITERIA[chapterNum - 1];
  const spec = getMediumSpec(story.medium);

  // For Chapter 1: generate strategic thesis first
  let ch1Thesis = '';
  if (chapterNum === 1) {
    try {
      const topP = story.draft.audience.priorities[0];
      const thesisPrompt = `You are writing ONE sentence — a market truth a senior executive would independently recognize.

AUDIENCE: ${story.draft.audience.name}
TOP PRIORITY: "${topP?.text || ''}"
DRIVER: "${topP?.driver || ''}"

Write a single sentence: "[Category condition] means [business consequence]."
This must be a truth about the MARKET or INDUSTRY — NOT a claim about the reader's team or organization. The reader has no patience for someone telling them what their team lacks.
GOOD: "Unmanaged device lifecycle management means lost Apple revenue." (market truth)
BAD: "Your team has no structured way to engage accounts between cycles." (claim about their org)
BAD: "Competitors are filling the gap when your reps go silent." (teaching them their landscape)
Return ONLY the one sentence.`;
      ch1Thesis = await callAI(thesisPrompt, '', 'elite');
      ch1Thesis = ch1Thesis.replace(/^["']|["']$/g, '').trim();
      console.log(`[Ch1 thesis] ${ch1Thesis}`);
    } catch (err) {
      console.error('[Ch1 thesis] Failed:', err);
    }
  }

  // Reader-perspective directive
  const readerDirective = chapterNum === 1
    ? `\nCRITICAL — THE READER: "${story.draft.audience.name}". State a MARKET TRUTH this person independently recognizes. Do NOT make claims about their team or tell them what their competitors do — they know. ${ch1Thesis ? `USE THIS AS YOUR OPENING: "${ch1Thesis}"` : 'Format: "[Category condition] means [business consequence]."'}\n`
    : chapterNum === 2
      ? `\nDo NOT open with the product name as the sentence subject. Lead with what the READER gets or how their situation changes.\n`
      : chapterNum === 5
        ? `\nMatch tone to seniority. For senior executives: offer a path they can evaluate, never give directives.\n`
        : '';

  // Chapter-specific guardrails for fabrication
  const tier2Labels = story.draft.tier2Statements.map(t => (t.categoryLabel || '').toLowerCase());
  const supportTexts = story.draft.tier2Statements.filter(t => /support/i.test(t.categoryLabel || '')).map(t => t.text.toLowerCase());
  const hasRealSupport = supportTexts.some(text =>
    /onboard|training|implementation|migration|setup|install|dedicated team|support team|customer success|configuration|deployment plan|pilot program/.test(text)
    && !/already deployed|already validate|already running|already live|already proven/.test(text)
  );

  let chapterGuardrail = '';
  if (chapterNum === 3 && !hasRealSupport) {
    chapterGuardrail = `
CHAPTER 3 GUARDRAIL — THE SOURCE HAS NO SUPPORT CONTENT.
The Three Tier does not describe any onboarding, migration, training,
pilot program, implementation, or support team. You MUST NOT invent any.
No timelines ("two weeks", "90 days"). No team commitments ("dedicated
support", "we stay involved"). No pilot structures ("pilot with X reps").
Write 1-2 sentences of reassurance from FACTS IN THE THREE TIER ONLY.
A one-sentence chapter is acceptable. Fabrication is not.`;
  }
  if (chapterNum === 5) {
    chapterGuardrail = `
CHAPTER 5 GUARDRAIL — No invented pilot programs, trial accounts, or
timelines. Do NOT invent "pick X accounts" or "we'll build dashboards
in Y days." If the CTA is simple, the chapter is short and direct.
For senior readers: offer a path to evaluate, never give directives.`;
  }

  // Chapter 1 gets ONLY audience data + thesis — no product/Three Tier data.
  // This forces Opus to write about the reader's world without product contamination.
  // Chapters 2-5 get the full Three Tier.
  const threeTierBlock = chapterNum === 1 ? '' : `
THREE TIER MESSAGE:
Tier 1: "${story.draft.tier1Statement?.text || ''}"
${story.draft.tier2Statements.map((t2, i) => `Tier 2 #${i + 1}: "${t2.text}" (Priority: "${t2.priority?.text || 'unlinked'}"${t2.priority?.driver ? `, Driver: "${t2.priority.driver}"` : ''})
  Proof: ${t2.tier3Bullets.map((t3) => t3.text).join(', ')}`).join('\n')}
`;

  const prevChapterBlock = story.chapters.filter((c) => c.chapterNum < chapterNum).length > 0 ? `
PREVIOUS CHAPTERS (context — do NOT repeat their facts or phrases):
${story.chapters.filter((c) => c.chapterNum < chapterNum).map((c) => {
    const text = c.content;
    const maxLen = 500;
    if (text.length <= maxLen) return `Ch ${c.chapterNum}: ${text}`;
    const truncated = text.substring(0, maxLen);
    const lastSentenceEnd = Math.max(truncated.lastIndexOf('. '), truncated.lastIndexOf('? '), truncated.lastIndexOf('! '));
    const clean = lastSentenceEnd > 100 ? truncated.substring(0, lastSentenceEnd + 1) : truncated.substring(0, truncated.lastIndexOf(' '));
    return `Ch ${c.chapterNum}: ${clean}`;
  }).join('\n')}
` : '';

  const fabricationBlock = chapterNum === 1 ? '' : `
CRITICAL — NO FABRICATION. You may only assert claims explicitly supported
by the THREE TIER MESSAGE, AUDIENCE PRIORITIES, or SITUATION above.
SOURCE-FIRST WRITING: Before writing each sentence, identify which Tier 2,
Tier 3, or Priority it derives from. If you cannot point to a specific
source, the sentence is fabricated — cut it. A one-sentence chapter that
is completely honest is better than three sentences with one fabricated line.`;

  const userMessage = `${chapterNum === 1 ? '' : `OFFERING: ${story.draft.offering.name}\n`}AUDIENCE (THIS IS THE READER): ${story.draft.audience.name}
CONTENT FORMAT: ${spec.label} (${spec.wordRange[0]}-${spec.wordRange[1]} words total)
${chapterNum === 1 ? '' : `CTA: ${story.cta}\n`}${story.emphasis ? `EMPHASIS: ${story.emphasis}\n` : ''}${readerDirective}${threeTierBlock}
AUDIENCE PRIORITIES:
${story.draft.audience.priorities.map((p) => `[Rank ${p.rank}] "${p.text}"${p.driver ? ` — Driver: "${p.driver}"` : ''}${p.whatAudienceThinks ? ` — Audience thinks: "${p.whatAudienceThinks}"` : ''}`).join('\n')}

${prevChapterBlock}
Write Chapter ${chapterNum}: "${ch.name}"
IMPORTANT: Start this chapter fresh. Do NOT begin with "..." or any continuation from a previous chapter. Each chapter is self-contained.
${fabricationBlock}
${chapterGuardrail}`;

  let content = await callAI(systemPrompt, userMessage, 'elite');

  // Strip leading "..." or sentence fragments — chapter boundary bleed safety net
  content = content.replace(/^\s*\.{2,}\s*/g, '').replace(/^[a-z].*?\.\s*/s, function(match) {
    // If the chapter starts with a lowercase word followed by a period, it's a continuation fragment — strip it
    return match.length < 60 ? '' : match; // Only strip short fragments, not full paragraphs
  }).trim();

  // Strip leading "Subject: ..." lines from chapters 2-5. In email stories the
  // LLM tends to re-emit a subject line for every chapter because each one is
  // asked to honor the email CONTENT FORMAT. The subject belongs only in Ch1.
  // Observed in Brad's Cy Clinical Lead story (April 2026): ch1, ch4, and ch5
  // each opened with "Subject: A question about your pathology read times"
  // which made the blended output show the subject three times.
  if (chapterNum > 1) {
    content = content.replace(/^\s*Subject:[^\n]*\n+/i, '').trim();
  }

  // Enforce word budget — if chapter is more than 2x the budget, rewrite shorter
  const mediumSpec = getMediumSpec(story.medium);
  if (mediumSpec) {
    const budget = mediumSpec.chapterBudgets[chapterNum - 1];
    const wordCount = content.split(/\s+/).length;
    if (budget && wordCount > budget * 2) {
      content = await callAI(
        `You are an editor. The text below is ${wordCount} words but must be approximately ${budget} words for a ${mediumSpec.label} format. Rewrite it to fit the budget. Keep the same message and tone. Cut ruthlessly — every word must earn its place.`,
        `TEXT TO SHORTEN:\n${content}\n\nRewrite in approximately ${budget} words. Return ONLY the shortened text.`,
        'elite'
      );
    }
  }

  // Strip CTA text from chapters 1-4 — it belongs only in chapter 5
  if (chapterNum < 5 && story.cta) {
    const ctaLower = story.cta.toLowerCase().trim();
    // Remove the CTA if it appears as a standalone sentence or trailing text
    content = content.split('\n').map(line => {
      if (line.toLowerCase().trim() === ctaLower) return '';
      return line;
    }).filter(line => line.trim()).join('\n').trim();
  }

  // Chapter 2 boundary safety net: trim trailing Chapter-3-style sentences
  // (support / setup / hand-holding content). Fixes the observed bleed where Ch2
  // ends with "We handle the full setup..." which belongs to Ch3. This is a surgical
  // post-processor — it only inspects the LAST 1-2 sentences and only trims if they
  // look clearly like Ch3 content. It does NOT modify the prompt (fiveChapter.ts is locked).
  if (chapterNum === 2) {
    const ch3Patterns = /\b(we'?ll (handle|hold|take care|manage|guide)|we handle|full setup|full installation|installation and (configuration|integration|training)|set(ting)? you up|onboard(ing)?|hand[\s-]?hold|hand[\s-]?holding|stay focused on your|fit into whatever|work(ing)? with your it|ongoing support|post[-\s]?launch support|behind every (customer|client))\b/i;
    const sentences = content.split(/(?<=[.!?])\s+(?=[A-Z"'])/);
    // Remove up to 2 trailing sentences if they match Ch3 patterns and the chapter still has >2 sentences
    let trimmed = 0;
    while (sentences.length > 3 && trimmed < 2) {
      const last = sentences[sentences.length - 1];
      if (ch3Patterns.test(last)) {
        sentences.pop();
        trimmed++;
      } else {
        break;
      }
    }
    if (trimmed > 0) {
      console.log(`[ChapterBleed] Trimmed ${trimmed} Ch3-style trailing sentences from Ch2`);
      content = sentences.join(' ').trim();
    }
  }

  // Voice check chapter prose
  if (await isVoiceCheckEnabled(req.user!.userId)) {
    try {
      const check = await checkProse(content, `Chapter ${chapterNum}: ${ch.name}`);
      if (!check.passed) {
        console.log(`[VoiceCheck] Chapter ${chapterNum}: ${check.violations.length} violations, retrying`);
        const feedback = buildProseViolationFeedback(check.violations);
        content = await callAI(systemPrompt, userMessage + feedback, 'elite');
      } else {
        console.log(`[VoiceCheck] Chapter ${chapterNum} passed`);
      }
    } catch (err) {
      console.error('[VoiceCheck] Chapter evaluation failed, returning original:', err);
    }
  }

  // Five Chapter methodology check (structural/boundary)
  if (await isMethodologyCheckEnabled(req.user!.userId)) {
    try {
      const fcInput: FiveChapterInput = {
        chapters: [{ num: chapterNum, title: ch.name, content }],
        medium: story.medium,
        cta: story.cta,
        offeringName: story.draft.offering.name,
        audienceName: story.draft.audience.name,
        tier1Text: story.draft.tier1Statement?.text,
      };
      const fcCheck = await checkFiveChapter(fcInput);
      if (!fcCheck.passed) {
        console.log(`[FiveChapterCheck] Chapter ${chapterNum}: structural issues, retrying`);
        const feedback = buildFiveChapterFeedback(fcCheck);
        content = await callAI(systemPrompt, userMessage + feedback, 'elite');
      } else {
        console.log(`[FiveChapterCheck] Chapter ${chapterNum} passed`);
      }
    } catch (err) {
      console.error('[FiveChapterCheck] Evaluation failed, returning original:', err);
    }
  }

  // Save the chapter
  const chapter = await prisma.chapterContent.upsert({
    where: { storyId_chapterNum: { storyId, chapterNum } },
    update: { title: ch.name, content },
    create: { storyId, chapterNum, title: ch.name, content },
  });

  // Create chapter version
  const maxVer = await prisma.chapterVersion.aggregate({
    where: { chapterContentId: chapter.id },
    _max: { versionNum: true },
  });
  await prisma.chapterVersion.create({
    data: {
      chapterContentId: chapter.id,
      title: ch.name,
      content,
      versionNum: (maxVer._max?.versionNum ?? 0) + 1,
      changeSource: 'ai_generate',
    },
  });

  // Cross-chapter dedup: after generating chapter 5, scan all chapters for repeated phrases
  if (chapterNum === 5) {
    try {
      const allChapters = await prisma.chapterContent.findMany({
        where: { storyId },
        orderBy: { chapterNum: 'asc' },
      });
      if (allChapters.length === 5) {
        // Extract 4-6 word ngrams per chapter, find repeats across chapters
        const chapterPhrases = new Map<number, Set<string>>();
        for (const ch2 of allChapters) {
          const words = ch2.content.toLowerCase().replace(/[^a-z0-9\s']/g, '').split(/\s+/).filter(w => w.length > 0);
          const phrases = new Set<string>();
          for (let len = 4; len <= 6; len++) {
            for (let i = 0; i <= words.length - len; i++) {
              phrases.add(words.slice(i, i + len).join(' '));
            }
          }
          chapterPhrases.set(ch2.chapterNum, phrases);
        }

        const repeatedByChapter = new Map<number, string[]>();
        for (let i = 1; i < allChapters.length; i++) {
          const laterNum = allChapters[i].chapterNum;
          const laterPhrases = chapterPhrases.get(laterNum)!;
          const avoids: string[] = [];
          for (let j = 0; j < i; j++) {
            const earlierPhrases = chapterPhrases.get(allChapters[j].chapterNum)!;
            for (const p of laterPhrases) {
              if (earlierPhrases.has(p) && !avoids.some(a => a.includes(p) || p.includes(a))) {
                avoids.push(p);
              }
            }
          }
          if (avoids.length > 0) repeatedByChapter.set(laterNum, avoids);
        }

        // Regenerate chapters with repetition (skip ch1, it's the baseline)
        for (const [fixChNum, avoidPhrases] of repeatedByChapter) {
          const fixCh = CHAPTER_CRITERIA[fixChNum - 1];
          const fixSystem = buildChapterPrompt(fixChNum, story.medium, emphasisChapter);
          const prevChs = allChapters.filter(c => c.chapterNum < fixChNum);
          const avoidInstruction = `\n\nCRITICAL: These phrases already appear in earlier chapters. Do NOT use them — find different words:\n${avoidPhrases.slice(0, 10).map(p => `- "${p}"`).join('\n')}`;

          const fixMsg = `OFFERING: ${story.draft.offering.name}
AUDIENCE: ${story.draft.audience.name}
CONTENT FORMAT: ${spec.label}
CTA: ${story.cta}

THREE TIER MESSAGE:
Tier 1: "${story.draft.tier1Statement?.text || ''}"
${story.draft.tier2Statements.map((t2, i) => `Tier 2 #${i + 1}: "${t2.text}"`).join('\n')}

${prevChs.map(c => {
  const text = c.content; const ml = 500;
  if (text.length <= ml) return `Ch ${c.chapterNum} (context — do not repeat): ${text}`;
  const tr = text.substring(0, ml);
  const se = Math.max(tr.lastIndexOf('. '), tr.lastIndexOf('? '), tr.lastIndexOf('! '));
  return `Ch ${c.chapterNum} (context — do not repeat): ${se > 100 ? tr.substring(0, se + 1) : tr.substring(0, tr.lastIndexOf(' '))}`;
}).join('\n')}

Write Chapter ${fixChNum}: "${fixCh.name}"${avoidInstruction}`;

          let fixedContent = await callAI(fixSystem, fixMsg, 'elite');
          fixedContent = fixedContent.replace(/^\s*\.{2,}\s*/g, '').trim();
          await prisma.chapterContent.update({
            where: { storyId_chapterNum: { storyId, chapterNum: fixChNum } },
            data: { content: fixedContent },
          });
          console.log(`[Dedup] Regenerated Ch${fixChNum} to avoid ${avoidPhrases.length} repeated phrases`);
        }
      }
    } catch (err) {
      console.error('[Dedup] Cross-chapter dedup check failed:', err);
    }
  }

  // If dedup ran, tell the frontend to re-fetch all chapters
  if (chapterNum === 5) {
    const updatedChapters = await prisma.chapterContent.findMany({
      where: { storyId },
      orderBy: { chapterNum: 'asc' },
    });
    res.json({ chapter, dedupApplied: true, allChapters: updatedChapters });
  } else {
    res.json({ chapter });
  }
});

// ─── Refine Chapter ─────────────────────────────────────

router.post('/refine-chapter', requireStoryteller, async (req: Request, res: Response) => {
  const { storyId, chapterNum, feedback } = req.body;
  if (!storyId || !chapterNum || !feedback) {
    res.status(400).json({ error: 'storyId, chapterNum, and feedback are required' });
    return;
  }

  const story = await prisma.fiveChapterStory.findFirst({
    where: { id: storyId, draft: { offering: { workspaceId: req.workspaceId } } },
    include: { chapters: true },
  });
  if (!story) { res.status(404).json({ error: 'Story not found' }); return; }

  const chapter = story.chapters.find((c) => c.chapterNum === chapterNum);
  if (!chapter) { res.status(404).json({ error: 'Chapter not found' }); return; }

  const ch = CHAPTER_CRITERIA[chapterNum - 1];

  const chapterRuleReminders: Record<number, string> = {
    1: 'Category-level ONLY. NEVER mention the specific company or product name. Make the status quo unattractive.',
    2: 'This is the value chapter. Order follows audience priority ranking. NEVER include proof, credentials, or social validation — those belong in Ch3/Ch4.',
    3: 'Reduce perceived risk and build trust. Be specific about HOW you support customers — no vague promises.',
    4: 'Show similar organizations succeeding. Format: problem → solution → result. NEVER invent company names, metrics, or quotes.',
    5: 'Call to action: first 1-3 concrete, simple steps ONLY. Keep it SHORT. NEVER write empty closers like "That\'s it for now."',
  };

  const userMessage = `CHAPTER ${chapterNum}: "${ch.name}"
CHAPTER ${chapterNum} RULE: ${chapterRuleReminders[chapterNum]}
GOAL: ${ch.goal}
DESIRED OUTCOME: ${ch.outcome}

CURRENT CONTENT:
${chapter.content}

USER FEEDBACK: ${feedback}

Please revise this chapter based on the feedback while respecting the chapter rules above.`;

  let content = await callAI(REFINE_CHAPTER_SYSTEM, userMessage, 'fast');

  // Voice check refined chapter
  if (await isVoiceCheckEnabled(req.user!.userId)) {
    try {
      const check = await checkProse(content, `Chapter ${chapterNum}: ${ch.name} (refinement)`);
      if (!check.passed) {
        console.log(`[VoiceCheck] Refine chapter ${chapterNum}: ${check.violations.length} violations, retrying`);
        const feedback2 = buildProseViolationFeedback(check.violations);
        content = await callAI(REFINE_CHAPTER_SYSTEM, userMessage + feedback2, 'fast');
      } else {
        console.log(`[VoiceCheck] Refined chapter ${chapterNum} passed`);
      }
    } catch (err) {
      console.error('[VoiceCheck] Refine chapter evaluation failed, returning original:', err);
    }
  }

  const updated = await prisma.chapterContent.update({
    where: { id: chapter.id },
    data: { content },
  });

  // Create chapter version
  const maxVer = await prisma.chapterVersion.aggregate({
    where: { chapterContentId: chapter.id },
    _max: { versionNum: true },
  });
  await prisma.chapterVersion.create({
    data: {
      chapterContentId: chapter.id,
      title: chapter.title,
      content,
      versionNum: (maxVer._max?.versionNum ?? 0) + 1,
      changeSource: 'ai_refine',
    },
  });

  res.json({ chapter: updated });
});

// ─── Join Chapters ─────────────────────────────────────

router.post('/join-chapters', requireStoryteller, async (req: Request, res: Response) => {
  const { storyId } = req.body;
  if (!storyId) { res.status(400).json({ error: 'storyId required' }); return; }

  const story = await prisma.fiveChapterStory.findFirst({
    where: { id: storyId, draft: { offering: { workspaceId: req.workspaceId } } },
    include: { chapters: { orderBy: { chapterNum: 'asc' } } },
  });
  if (!story) { res.status(404).json({ error: 'Story not found' }); return; }

  if (story.chapters.length < 5) {
    res.status(400).json({ error: 'All 5 chapters must be generated before joining' });
    return;
  }

  const spec = getMediumSpec(story.medium);
  const userMessage = `CONTENT FORMAT: ${spec.label} (${spec.wordRange[0]}-${spec.wordRange[1]} words)
FORMAT RULES: ${spec.format}

${story.chapters.map((ch) => `CHAPTER ${ch.chapterNum}: "${ch.title}"\n${ch.content}`).join('\n\n---\n\n')}

Join these chapters into one flowing text.`;

  let joinedText = await callAI(JOIN_CHAPTERS_SYSTEM, userMessage, 'elite');

  // Voice check joined text
  if (await isVoiceCheckEnabled(req.user!.userId)) {
    try {
      const check = await checkProse(joinedText, 'Joined Five Chapter Story');
      if (!check.passed) {
        console.log(`[VoiceCheck] Join: ${check.violations.length} violations, retrying`);
        const feedback = buildProseViolationFeedback(check.violations);
        joinedText = await callAI(JOIN_CHAPTERS_SYSTEM, userMessage + feedback, 'elite');
      } else {
        console.log('[VoiceCheck] Joined text passed');
      }
    } catch (err) {
      console.error('[VoiceCheck] Join evaluation failed, returning original:', err);
    }
  }

  const updated = await prisma.fiveChapterStory.update({
    where: { id: storyId },
    data: { joinedText, stage: 'joined', version: { increment: 1 } },
    include: { chapters: { orderBy: { chapterNum: 'asc' } } },
  });

  res.json({ story: updated });
});

// ─── Blend Story ────────────────────────────────────────

router.post('/blend-story', requireStoryteller, async (req: Request, res: Response) => {
  const { storyId } = req.body;
  if (!storyId) { res.status(400).json({ error: 'storyId required' }); return; }

  const story = await prisma.fiveChapterStory.findFirst({
    where: { id: storyId, draft: { offering: { workspaceId: req.workspaceId } } },
    include: { chapters: { orderBy: { chapterNum: 'asc' } } },
  });
  if (!story) { res.status(404).json({ error: 'Story not found' }); return; }

  // Snapshot before blend
  const maxSnapVer = await prisma.storyVersion.aggregate({
    where: { storyId },
    _max: { versionNum: true },
  });
  await prisma.storyVersion.create({
    data: {
      storyId,
      snapshot: {
        medium: story.medium, cta: story.cta, emphasis: story.emphasis,
        stage: story.stage, joinedText: story.joinedText, blendedText: story.blendedText,
        chapters: story.chapters.map(c => ({ chapterNum: c.chapterNum, title: c.title, content: c.content })),
      },
      label: 'Before blend',
      versionNum: (maxSnapVer._max?.versionNum ?? 0) + 1,
    },
  });

  // Blend can work from joined text or directly from chapters
  const sourceText = story.joinedText || story.chapters.map((ch) => `${ch.title}\n${ch.content}`).join('\n\n');
  if (!sourceText) {
    res.status(400).json({ error: 'No content to blend. Generate chapters first.' });
    return;
  }

  const spec = getMediumSpec(story.medium);
  const userMessage = `CONTENT FORMAT: ${spec.label} (${spec.wordRange[0]}-${spec.wordRange[1]} words)
FORMAT RULES: ${spec.format}
TONE: ${spec.tone}

${sourceText}

Polish this into a final, cohesive ${spec.label.toLowerCase()}.`;

  let blendedText = await callAI(BLEND_SYSTEM, userMessage, 'elite');

  // Strip markdown artifacts the AI may generate despite "plain text" instruction
  blendedText = blendedText
    .replace(/^#{1,6}\s+/gm, '')          // remove markdown headers (# ## ### ####)
    .replace(/\*\*(.+?)\*\*/g, '$1')      // remove bold markers
    .replace(/\*(.+?)\*/g, '$1')          // remove italic markers
    .replace(/^[\-\*]\s+/gm, '')          // remove bullet markers
    .replace(/^\d+\.\s+/gm, '')           // remove numbered list markers
    .replace(/\n{3,}/g, '\n\n');           // collapse excessive blank lines

  // Voice check blended text
  if (await isVoiceCheckEnabled(req.user!.userId)) {
    try {
      const check = await checkProse(blendedText, `Blended ${spec.label}`);
      if (!check.passed) {
        console.log(`[VoiceCheck] Blend: ${check.violations.length} violations, retrying`);
        const feedback = buildProseViolationFeedback(check.violations);
        blendedText = await callAI(BLEND_SYSTEM, userMessage + feedback, 'elite');
      } else {
        console.log('[VoiceCheck] Blended text passed');
      }
    } catch (err) {
      console.error('[VoiceCheck] Blend evaluation failed, returning original:', err);
    }
  }

  const updated = await prisma.fiveChapterStory.update({
    where: { id: storyId },
    data: { blendedText, stage: 'blended', version: { increment: 1 } },
    include: { chapters: { orderBy: { chapterNum: 'asc' } } },
  });

  res.json({ story: updated });
});

// ─── Copy Edit ─────────────────────────────────────────

router.post('/copy-edit', requireStoryteller, async (req: Request, res: Response) => {
  const { storyId, content, request: editRequest } = req.body;
  if (!storyId || !content || !editRequest) {
    res.status(400).json({ error: 'storyId, content, and request are required' });
    return;
  }

  const story = await prisma.fiveChapterStory.findFirst({
    where: { id: storyId, draft: { offering: { workspaceId: req.workspaceId } } },
  });
  if (!story) { res.status(404).json({ error: 'Story not found' }); return; }

  const spec = getMediumSpec(story.medium);
  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const originalNorm = normalize(content);
  const userMessage = `CONTENT FORMAT: ${spec.label}
USER'S REQUEST: ${editRequest}

CURRENT CONTENT:
${content}

Apply the requested changes.`;

  let revised = await callAI(COPY_EDIT_SYSTEM, userMessage, 'fast');

  // If the AI returned identical text, retry once with a stronger nudge.
  if (normalize(revised) === originalNorm) {
    console.log('[CopyEdit] First pass returned identical text — retrying with stronger instruction');
    const retryMessage = `CONTENT FORMAT: ${spec.label}
USER'S REQUEST: ${editRequest}

CURRENT CONTENT:
${content}

CRITICAL: Your previous attempt returned text identical to the original. You MUST actually apply the requested change. If the request is about rewording a specific sentence or opening, rewrite that sentence. Return the FULL content with the change applied.`;
    revised = await callAI(COPY_EDIT_SYSTEM, retryMessage, 'fast');
  }

  // Voice check copy-edited text
  if (await isVoiceCheckEnabled(req.user!.userId)) {
    try {
      const check = await checkProse(revised, 'Copy edit');
      if (!check.passed) {
        console.log(`[VoiceCheck] Copy edit: ${check.violations.length} violations, retrying`);
        const feedback = buildProseViolationFeedback(check.violations);
        revised = await callAI(COPY_EDIT_SYSTEM, userMessage + feedback, 'fast');
      } else {
        console.log('[VoiceCheck] Copy edit passed');
      }
    } catch (err) {
      console.error('[VoiceCheck] Copy edit evaluation failed, returning original:', err);
    }
  }

  // If we STILL have identical text, signal that to the caller so the UI can say so honestly.
  const unchanged = normalize(revised) === originalNorm;
  res.json({ content: revised, unchanged });
});

// ─── Audience Discovery ────────────────────────────────

router.post('/discover-audiences', requireEditor, async (req: Request, res: Response) => {
  const { description } = req.body;
  if (!description) {
    res.status(400).json({ error: 'description is required' });
    return;
  }

  const result = await callAIWithJSON<{
    audiences: { name: string; description: string }[];
    notes: string;
  }>(AUDIENCE_DISCOVERY_SYSTEM, description, 'fast');

  res.json(result);
});

export default router;
