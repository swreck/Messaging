// Voice Check — always-on quality gate for Ken's Voice
//
// Evaluates generated text against Ken's Voice rules before the user sees it.
// If violations are found, the caller retries generation with violation feedback.
// Uses Opus for evaluation — smaller models can't reliably distinguish
// nuanced voice violations (proven through 5 rounds of iterative testing).

import { callAIWithJSON } from './ai.js';
import { prisma } from '../lib/prisma.js';

// ─── Statement Evaluator (Tier 1/2, Refine Language) ────────
//
// Adapted from the battle-tested EVALUATOR_SYSTEM in test-prompt-eval.ts.
// All 16 rules. Column-aware (Focus and Social proof get lighter treatment).

const STATEMENT_EVALUATOR_SYSTEM = `You are a strict quality evaluator for business messaging text. You are NOT the writer — you are the independent reviewer. Your ONLY job is to check each statement against the rules below and report violations. Be harsh. If something is borderline, call it a violation.

THE SMALL-TABLE TEST: Imagine the statement being said out loud at a small table to one smart but less informed professional acquaintance. Would the person lean in with interest? Or start looking for an excuse to leave because they feel sold to? Pass the first, fail the second.

COLUMN CONTEXT — each statement belongs to a column type:
- **Focus**: A simple declaration of company commitment ("X is the entire focus of our company"). These are SUPPOSED to be company-centric. Do NOT flag rule 9 on Focus statements. They're often the simplest statement in the table.
- **Social proof**: Named customers, institutions, or adoption numbers. These are factual references. Apply rules lightly — the main concern is marketing language, not subject/structure.
- **Product, ROI, Support, Tier 1**: Standard value statements. Apply all rules strictly.

RULES — each statement must pass ALL applicable rules:

1. NO RHETORICAL QUESTIONS. Any sentence ending in "?" is a fail.

2. NO COLONS AS STYLISTIC DEVICE. "Your results: under 60 seconds" or "Accuracy you can trust: oncologist founders..." — these are ad copy layouts. A colon in a natural list is OK ("three things: A, B, and C"). A colon used to create a dramatic reveal is not.

3. NO NARRATED TRANSFORMATIONS. "From X to Y," "drops from X to Y," "goes from X to Y," "one week to seconds," "X reduced to Y." Just state the end result.

4. NO METAPHORICAL VERBS. Watch for: fades, unlocks, fuels, drives, powers, transforms, bridges, reshapes, elevates, ignites, amplifies. "Burns out" is metaphorical. "Secures" and "protects" are OK when literal (actual security/protection), not when abstract.

5. NO CONTRAST CLAUSES after the main claim. "not X," "instead of X," "no tradeoff." Just state the fact and stop.

6. NO EM-DASHES adding extra clauses (" — ").

7. NO DRAMATIC FRAGMENTS. Short punchy sentences used for effect: "Speed and accuracy." "One number says it all."

8. NO MARKETING BUZZWORDS. leverage, seamless, cutting-edge, best-in-class, robust, game-changing, end-to-end, comprehensive, holistic, enterprise-level.

9. RESULT IS THE SUBJECT, NOT THE PRODUCT (except Focus and Social proof columns). The sentence should describe what the audience gets. "The platform monitors 200 signals" — product as subject, fail. HOWEVER: "We [verb]..." is acceptable when it sounds like a person talking ("We monitor 200 signals," "We digitize every slide"). "We" as subject is sometimes MORE natural than forced passive voice — do NOT flag "We" constructions as rule 9 violations if they sound like a person speaking. Only flag when the product name, feature name, or system is the grammatical subject.

10. WORD COUNT ≤ 20.

11. NO APPENDED BENEFIT CLAUSES. ", which protects..." or ", which directly improves..." or ", reducing X" or ", keeping X" or "so X stays Y" tacked onto the end of a fact. These read as persuasive linkage — including participial rewrites. State the fact. Let the connection speak for itself. HOWEVER: a natural "so" or "which" connecting two parts of the SAME fact is OK ("AI handles screening so pathologists focus on complex cases" — both halves describe the same operational reality).

12. NO STACKED COMPOUND NOUNS. Three or more nouns jammed together, or two nouns with no article or verb between them, creating label-like compression. "Same-day diagnostic confidence" (noun-noun-noun) is a label, not speech. "Pathologist review" (noun-noun, no article) is compressed — "the pathologist reviews it" is how people talk. "Real-time delay detection" is a spec sheet — "we detect delays in real time" is a person talking. NOTE: adjective-noun pairs ARE natural speech — "daily monitoring," "automated checks," "active evaluation" are fine. Only flag when nouns are stacked into compressed labels.

13. NO MISSING ARTICLES OR PREPOSITIONS. "Fixed monthly subscription covers..." is a headline. "A fixed monthly subscription covers..." is a person. "Tracked every session" is compressed — "tracked during every session" is natural. If natural speech would have the article or preposition, it must be there.

14. NO OVER-PRECISE PERCENTAGES. "99.2%" or "94.7%" sound like marketing claims. Should be "over 99%" or "over 94%." Technical metrics (validity coefficients, p-values) should be translated to human-scale comparisons. "3.2 times" should be "over 3x."

15. NO DENSE MULTI-CLAIM PACKING. If a sentence contains more than one impressive number or selling point, it sounds rehearsed. Should be split into two sentences or simplified.

16. NO URGENCY PHRASES. "Ahead of time" manufactures urgency. Just describe the actual timeline plainly.

RESPOND WITH JSON ONLY:
{
  "statements": [
    { "index": 0, "pass": true, "text": "the statement text", "column": "Product" },
    { "index": 1, "pass": false, "text": "the statement text", "column": "ROI", "violations": ["rule 3: narrated transformation", "rule 4: metaphorical verb: fades"] }
  ],
  "overallPass": false
}`;

// ─── Prose Evaluator (Five Chapter chapters, join, blend) ───
//
// Subset of rules adapted for narrative text. Drops statement-specific
// rules (word count, column context, "because" clauses, result-as-subject).
// Keeps the rules that matter for prose: no marketing language, no
// metaphorical verbs, no stacked compounds, natural speech patterns.

const PROSE_EVALUATOR_SYSTEM = `You are a strict quality evaluator for business narrative text (Five Chapter Stories, joined narratives, blended content). You are NOT the writer — you are the independent reviewer. Check the text against the rules below and report violations.

THE SMALL-TABLE TEST: Imagine reading this text aloud at a small table to one smart but less informed professional acquaintance. Would they stay engaged and interested? Or would they feel like they're reading a brochure or being sold to?

RULES — the text must pass ALL of these:

1. NO RHETORICAL QUESTIONS used for dramatic effect. Questions that genuinely advance the narrative are OK.

2. NO NARRATED TRANSFORMATIONS used as dramatic devices. "From X to Y," "drops from X to Y" as a way to create drama. Simply stating timeline facts ("results in under 60 seconds") is fine.

3. NO METAPHORICAL VERBS. unlocks, fuels, drives, powers, transforms, bridges, reshapes, elevates, ignites, amplifies. Use literal language only. Say what actually happens.

4. NO DRAMATIC FRAGMENTS used for effect. "Speed and accuracy." as a standalone sentence for impact.

5. NO MARKETING BUZZWORDS. leverage, seamless, cutting-edge, best-in-class, robust, game-changing, end-to-end, comprehensive, holistic, enterprise-level.

6. NO EM-DASHES USED AS A PATTERN for adding clauses throughout the text. Occasional use is fine in prose; a pattern of em-dash insertions reads as stylistic copywriting.

7. NO NARRATIVE CAUSALITY PHRASES. "trace back to," "boil down to," "come down to," "rooted in," "stems from," "at its core." These narrate logical chains instead of stating facts.

8. NO STACKED COMPOUND NOUNS. "Same-day diagnostic confidence" — unpack into natural speech: "a confident diagnosis on the same day."

9. NO MISSING ARTICLES OR PREPOSITIONS where natural speech would include them. Headlines drop articles; people don't.

10. TRANSLATE JARGON into plain language the reader would understand. Over-precise percentages ("99.2%") should be rounded ("over 99%"). Technical metrics should become human-scale comparisons.

11. COMPLETE VERB PHRASES, not compressed participial shorthand. "Flagging tissue artifacts before review" → "to flag tissue artifacts before the pathologist reviews them."

NOTE: These rules are ADAPTED for narrative text. Unlike statement evaluation:
- Colons are natural punctuation in prose — not flagged
- Contrast and "but" constructions are sometimes needed in narrative
- Word count limits don't apply to prose paragraphs
- Multiple claims per paragraph are expected; one strong claim per sentence is ideal but not rigid
- Urgency language is acceptable when describing real timelines and stakes

RESPOND WITH JSON ONLY:
{
  "pass": true,
  "violations": []
}
or
{
  "pass": false,
  "violations": ["Paragraph 2: metaphorical verb 'unlocks' — use literal language", "Paragraph 4: marketing buzzword 'seamless'"]
}`;

// ─── Types ──────────────────────────────────────────────────

export interface StatementInput {
  text: string;
  column: string;
}

export interface StatementViolation {
  index: number;
  text: string;
  rules: string[];
}

export interface StatementCheckResult {
  passed: boolean;
  violations: StatementViolation[];
}

export interface ProseCheckResult {
  passed: boolean;
  violations: string[];
}

// ─── Settings check ─────────────────────────────────────────

export async function isVoiceCheckEnabled(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { settings: true },
  });
  const settings = (user?.settings as Record<string, any>) || {};
  // Default: enabled. User must explicitly disable.
  return settings.voiceCheckEnabled !== false;
}

// ─── Statement evaluator ────────────────────────────────────

export async function checkStatements(statements: StatementInput[]): Promise<StatementCheckResult> {
  const input = statements.map((s, i) => `[${i}] (${s.column}) "${s.text}"`).join('\n');

  const result = await callAIWithJSON<{
    statements: { index: number; pass: boolean; text: string; column?: string; violations?: string[] }[];
    overallPass: boolean;
  }>(STATEMENT_EVALUATOR_SYSTEM, `STATEMENTS TO EVALUATE:\n${input}`, 'elite');

  const violations = result.statements
    .filter(s => !s.pass)
    .map(s => ({ index: s.index, text: s.text, rules: s.violations || [] }));

  return { passed: result.overallPass, violations };
}

// ─── Prose evaluator ────────────────────────────────────────

export async function checkProse(text: string, context: string): Promise<ProseCheckResult> {
  const result = await callAIWithJSON<{
    pass: boolean;
    violations: string[];
  }>(PROSE_EVALUATOR_SYSTEM, `CONTEXT: ${context}\n\nTEXT TO EVALUATE:\n${text}`, 'elite');

  return { passed: result.pass, violations: result.violations || [] };
}

// ─── Feedback builders ──────────────────────────────────────

export function buildViolationFeedback(violations: StatementViolation[]): string {
  if (violations.length === 0) return '';
  const lines = violations.map(v =>
    `[${v.index}] "${v.text}" — ${v.rules.join(', ')}`
  );
  return `\n\nVOICE CHECK VIOLATIONS — fix these in your regeneration:\n${lines.join('\n')}`;
}

export function buildProseViolationFeedback(violations: string[]): string {
  if (violations.length === 0) return '';
  return `\n\nVOICE CHECK VIOLATIONS — fix these in your regeneration:\n${violations.map(v => `- ${v}`).join('\n')}`;
}
