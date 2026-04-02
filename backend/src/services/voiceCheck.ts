// Voice Check — always-on quality gate for Ken's Voice
//
// Evaluates generated text against Ken's Voice rules before the user sees it.
// If violations are found, the caller retries generation with violation feedback.
// Uses Opus for evaluation — smaller models can't reliably distinguish
// nuanced voice violations (proven through 5 rounds of iterative testing).
//
// Two categories of checks:
// 1. NEGATIVE ("don't"): 16 rules catching marketing language, stylistic tricks,
//    compressed speech patterns — adapted from test-prompt-eval.ts
// 2. POSITIVE ("do"): priority alignment and tautology checks — the statement
//    must ADDRESS the audience's priority and the hook must ADD new information.
//    These require the priority text to be passed alongside the statement.

import { callAIWithJSON } from './ai.js';
import { prisma } from '../lib/prisma.js';

// ─── Statement Evaluator (Tier 1/2, Refine Language) ────────
//
// All 16 negative rules PLUS 2 positive quality checks when priority
// context is available. Column-aware (Focus/Social proof lighter treatment).

const STATEMENT_EVALUATOR_SYSTEM = `You are a strict quality evaluator for business messaging text. You are NOT the writer — you are the independent reviewer. Your job is to check each statement against BOTH the negative rules (things that must NOT appear) and the positive quality checks (things that MUST be true). Be harsh. If something is borderline, call it a violation.

THE SMALL-TABLE TEST (this is the holistic standard — rules are guardrails underneath it):
Imagine the statement being said out loud at a small table to one smart but less informed professional acquaintance.

POSITIVE: Would the person lean in? Does the statement share a specific fact they'd find genuinely interesting or surprising? Does it sound like a knowledgeable person sharing something worth knowing?
NEGATIVE: Would the person start looking for the exit because they feel sold to? Does it sound like a pitch deck, a brochure, or a marketing team?

Pass the first, fail the second.

COLUMN CONTEXT — each statement belongs to a column type:
- **Focus**: A simple declaration of company commitment ("X is the entire focus of our company"). These are SUPPOSED to be company-centric. Do NOT flag rule 9 on Focus statements. P1/P2 do not apply — Focus statements often have no mapped priority.
- **Social proof**: Named customers, institutions, or adoption numbers. These are factual references. Apply negative rules lightly. P1/P2 do not apply — Social proof uses orphan data, not mapped priorities.
- **Product, ROI, Support, Tier 1**: Standard value statements. Apply all rules strictly. P1/P2 apply when priority text is provided.

═══════════════════════════════════════════════════════════
NEGATIVE RULES — things that must NOT appear
═══════════════════════════════════════════════════════════

Each statement must pass ALL applicable rules:

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

═══════════════════════════════════════════════════════════
POSITIVE QUALITY CHECKS — apply ONLY when a priority is provided
═══════════════════════════════════════════════════════════

Some statements include the audience's priority text. When present, these additional checks apply. When no priority is provided (Focus, Social proof, or statements without mapped priorities), skip P1 and P2.

P1. PRIORITY ALIGNMENT — the statement must clearly ADDRESS the audience's priority. The priority is their strategic concern — what they care about at a business or personal level. The statement must serve that concern, not substitute a product metric or a different concern.

The exact priority words don't need to appear (especially in refined/conversational statements), but the statement must be ABOUT that priority. Ask: "If I told the audience their priority is [priority text], would they immediately see this statement as addressing it?"

FAIL examples:
  Priority: "Protecting the financial health of our hospital"
  Statement: "Fast processing speed for pathology slides" — FAIL P1
  WHY: Substitutes a product metric (processing speed) for the audience's concern (financial health). The audience didn't say "fast processing" — they said "financial health."

  Priority: "Better outcomes for our cancer patients"
  Statement: "Low cost per test because AI runs on existing equipment" — FAIL P1
  WHY: Substitutes cost for patient outcomes. Completely different concern.

  Priority: "Keeping every project on schedule and on budget"
  Statement: "Avoid project delays because AI monitors schedules" — FAIL P1
  WHY: Narrows the priority. They said "on schedule AND on budget" — dropping "on budget" loses half of what they care about.

PASS examples:
  Priority: "Protecting the financial health of our hospital"
  Statement: "Cancer pathology testing costs under $1 per slide" — PASS P1
  WHY: Testing costs directly serve hospital financial health. The connection is clear.

  Priority: "Better outcomes for our cancer patients"
  Statement: "Slide results are available in under 60 seconds" — PASS P1
  WHY: Fast results mean faster treatment decisions, which serves patient outcomes.

  Priority: "Proving compliance without drowning in audit prep"
  Statement: "You get exam-ready audit reports automatically" — PASS P1
  WHY: Directly addresses both compliance AND the audit prep pain.

P2. NO TAUTOLOGY — the hook or fact portion must provide DIFFERENT, SURPRISING information beyond what the priority already states. Apply the SURPRISE TEST: could someone who agrees with the priority be surprised by this fact?

IMPORTANT: Many statements use the "because" format: "[priority echo] because [hook]." The first half naturally echoes the priority — that is by design. Only evaluate the HOOK (the part after "because") for tautology. If the hook introduces a specific, surprising fact that goes beyond the priority, it passes P2 even when the first half restates the priority.

When the priority is a BROAD strategic concern and the hook is a SPECIFIC dramatic fact supporting it → NOT tautological (the specificity is the surprise).
When the priority is NARROW and the hook just restates the same concept with different words → TAUTOLOGICAL.

TAUTOLOGICAL (FAIL P2):
  Priority: "Low cost" → "...because testing costs under $1" — "low cost" and "under $1" express the same concept
  Priority: "Speed of results" → "...because answers come in 60 seconds" — "speed" and "60 seconds" are the same concept
  Priority: "Accurate testing" → "...because 40% fewer false negatives" — "accurate" and "fewer false negatives" are synonyms

NOT TAUTOLOGICAL (PASS P2):
  Priority: "Financial health of hospital" → "...testing costs under $1 per slide" — financial health is BROADER, $1/slide is a surprising specific
  Priority: "Patient outcomes" → "...results in under 60 seconds" — outcomes is BROADER, 60 seconds is a dramatic specific fact
  Priority: "Protecting from regulatory penalties" → "...pre-mapped controls cover 90% on day one" — penalties is BROADER, 90% day-one coverage is a surprising specific

═══════════════════════════════════════════════════════════

RESPOND WITH JSON ONLY:
{
  "statements": [
    { "index": 0, "pass": true, "text": "the statement text", "column": "Product" },
    { "index": 1, "pass": false, "text": "the statement text", "column": "ROI", "violations": ["rule 3: narrated transformation", "P1: substitutes product metric for audience priority"] }
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

THE SMALL-TABLE TEST (this is the holistic standard — rules are guardrails underneath it):
Imagine reading this text aloud at a small table to one smart but less informed professional acquaintance.

POSITIVE: Would they stay engaged? Does the text sound like a knowledgeable person sharing something genuinely interesting — something worth knowing? Does it read like someone who has real expertise and is speaking plainly about what they know?
NEGATIVE: Would they feel like they're reading a brochure, a pitch deck, or corporate marketing? Does it sound like someone trying to sell or impress rather than inform?

If the text sounds more like marketing than expertise, flag it — even if no specific rule below is violated. The small-table test is the primary check. The rules below catch specific failure patterns.

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
  priorityText?: string; // When provided, P1 and P2 positive checks apply
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

export async function isMethodologyCheckEnabled(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { settings: true },
  });
  const settings = (user?.settings as Record<string, any>) || {};
  // Default: DISABLED. Must be explicitly enabled for testing.
  return settings.methodologyCheckEnabled === true;
}

// ─── Statement evaluator ────────────────────────────────────

export async function checkStatements(statements: StatementInput[]): Promise<StatementCheckResult> {
  // Format input with priority context when available
  const input = statements.map((s, i) => {
    if (s.priorityText) {
      return `[${i}] (${s.column}) Priority: "${s.priorityText}" → "${s.text}"`;
    }
    return `[${i}] (${s.column}) "${s.text}"`;
  }).join('\n');

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
