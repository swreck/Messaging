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
- **Social proof**: Named customers, institutions, or adoption numbers. These are factual references. Apply negative rules lightly. P1 does not apply — Social proof uses orphan data, not mapped priorities. **P2 STILL APPLIES** — the hook (the part after "because", or the body if there is no "because") MUST introduce a specific verifiable fact: a named customer, a named organization, a named award/certification, or a specific adoption number. If the hook just describes the audience back to themselves ("because mid-market B2B operations teams are seeing value," "because leaders in this space are adopting it") or refers vaguely to "customers," "organizations," "teams," "leaders," "peers," "the industry," "the market," without naming anyone specific, it is TAUTOLOGICAL — FAIL P2. Social proof without named specifics is not proof.
- **Product, ROI, Support, Tier 1**: Standard value statements. Apply all rules strictly. P1/P2 apply when priority text is provided.

═══════════════════════════════════════════════════════════
NEGATIVE RULES — things that must NOT appear
═══════════════════════════════════════════════════════════

Each statement must pass ALL applicable rules:

1. NO RHETORICAL QUESTIONS. Any sentence ending in "?" is a fail.

2. NO COLONS AS STYLISTIC DEVICE. "Your results: under 60 seconds" or "Accuracy you can trust: oncologist founders..." — these are ad copy layouts. A colon in a natural list is OK ("three things: A, B, and C"). A colon used to create a dramatic reveal is not.

3. NO NARRATED TRANSFORMATIONS. "From X to Y," "drops from X to Y," "goes from X to Y," "one week to seconds," "X reduced to Y." Just state the end result.

4. NO METAPHORICAL VERBS. Watch for: fades, unlocks, fuels, drives, powers, transforms, bridges, reshapes, elevates, ignites, amplifies. "Burns out" is metaphorical. "Secures" and "protects" are OK when literal (actual security/protection), not when abstract.

5. NO CONTRAST CLAUSES anywhere in the main claim. Ban: "not X," "instead of X," "rather than X," "without X" (e.g., "without degrading," "without compromising," "without the hassle"), "no tradeoff," "not just X." These turn a plain fact into a salesperson anticipating objections. State the fact and stop. Applies whether the contrast appears before or after the mechanism. The only "without" that passes is when it describes a natural mechanism AFTER "because" (e.g., "because AI answers without human intervention" — that's HOW it works, not a hedge).

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

Some statements include the audience's priority text. When present, P1 and P2 both apply. When no priority is provided, skip P1. P2 still applies to Social proof statements (named-specifics rule above) even with no priority provided. For Focus statements and other orphan-data cases, skip both P1 and P2.

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

SOCIAL PROOF — special P2 rule. Social proof statements have no priority to compare against, so the tautology test collapses to: did the hook introduce a NAMED SPECIFIC? Rule: there must be at least one named organization, named award/certification, or specific adoption number (a digit). Generic gestures at "customers," "teams," "leaders," "peers," or "the industry" fail.

  TAUTOLOGICAL (FAIL P2):
    "Trusted by mid-market B2B operations teams" — describes the audience back to themselves, no named specific
    "Industry leaders are adopting our platform" — no named specific
    "Customers in your space are seeing results" — no named specific
    "Recognized by peers across the industry" — no named specific

  NOT TAUTOLOGICAL (PASS P2):
    "Geisinger Clinic and Mayo Clinic in active evaluation" — two named organizations
    "300+ hospitals live in production" — specific adoption number
    "SOC 2 Type II certified; HIPAA audit complete" — named certifications
    "Finalist, 2024 HIMSS Innovation Award" — named award with year
    "Used by the FDA for companion diagnostic validation" — named organization

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

12. NO AMBIGUOUS ATTRIBUTION. When a sentence describes a problem (status quo) near product benefits, make clear which is which. "Audit prep takes weeks" next to product features could be read as "our audit prep takes weeks" (sounds like a limitation) rather than "audit prep normally takes weeks" (the intended status quo pain). If a sentence could reasonably be read as describing the product's limitation rather than the status quo problem, flag it. The reader must always know: is this what happens WITHOUT the product, or what happens WITH it?

NOTE: These rules are ADAPTED for narrative text. Unlike statement evaluation:
- Colons are natural punctuation in prose — not flagged
- "But" for natural narrative flow is OK. However, CONTRAST CLAUSES that negate ("not X," "instead of X," "no tradeoff," "rather than X," "without the X") after stating the main claim are still violations — they sound like sales copy defending against objections. State the fact and stop.
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

// Round 3.4 Bug 10 — Tier 1 market-truth sentinel. Pattern checks that
// run BEFORE Opus statement evaluation. Cheap regexes catch the most
// common vendor-speak shapes the generation prompt explicitly forbids.
// On any flag, the caller (generation pipeline) regenerates with the
// rule reiterated. Three-retry hard cap is applied at the call site.

export interface Tier1SentinelResult {
  passed: boolean;
  violations: string[];
}

// Imperative-verb openings forbidden by Bug 10 rule 2.
// Round 3.4 coaching-fix Finding 2 — list expanded after Cowork's walk
// surfaced "Stop slipped deals from blindsiding you..." passing the
// sentinel.
//
// Bundle 1A rev3 W1 — list reverted to 36 terms. Cowork's shape rule
// for Round 3.4: the cheap regex is a fast-path pre-filter, not a
// classifier. The Opus judge (judgeTier1AgainstRuleOpus) is the
// methodology floor. If a Tier 1 violation slips through, the fix
// belongs in the judge prompt or the rule articulation in
// generation.ts — not in growing this list.
const TIER1_FORBIDDEN_IMPERATIVES = [
  'stop', 'eliminate', 'prevent', 'drive', 'boost', 'accelerate',
  'reduce', 'increase', 'maximize', 'achieve', 'deliver', 'transform',
  'streamline', 'optimize', 'unlock', 'empower',
  'get', 'improve', 'discover', 'build', 'enable', 'fuel', 'gain',
  'scale', 'grow', 'win', 'beat', 'crush', 'master', 'capture',
  'protect', 'avoid', 'minimize', 'simplify', 'modernize',
];

// Mechanism vocabulary forbidden by Bug 10 rule 4. Tier 1 names a
// discipline or consequence; mechanism words belong in Tier 2/3.
// Round 3.4 coaching-fix Finding 2 — list expanded. Lila's Tier 1
// contained "scoring" and "signals" and the prior list missed both.
// Now covers the common analytics/automation shapes that signal
// vendor-speak in a Tier 1 statement.
const TIER1_FORBIDDEN_MECHANISM = [
  'scoring', 'signals', 'dashboards', 'dashboard', 'analytics',
  'tracking', 'monitoring', 'reporting', 'visibility', 'intelligence',
  'insights', 'predictions', 'automation', 'workflows', 'workflow',
  'ranking', 'alerting', 'flagging', 'platform', 'engine', 'model',
  'ai-powered', 'machine-learning', 'machine learning', 'automated',
  'algorithm', 'integration', 'api', 'data-driven',
];

export function checkTier1MarketTruth(
  tier1Text: string,
  offeringName?: string,
): Tier1SentinelResult {
  const violations: string[] = [];
  const text = (tier1Text || '').trim();
  if (!text) {
    return { passed: true, violations: [] };
  }
  const lower = text.toLowerCase();

  // Rule 2 — imperative-verb opening.
  const firstWord = (text.match(/^\s*([A-Za-z']+)/)?.[1] || '').toLowerCase();
  if (TIER1_FORBIDDEN_IMPERATIVES.includes(firstWord)) {
    violations.push(
      `Tier 1 begins with imperative verb "${firstWord}" — forbidden by market-truth rule. Tier 1 is not a command directed at the reader. Rewrite so the audience is the subject of their own situation, not the object of a verb.`
    );
  }

  // Rule 3 — offering name presence (case-insensitive substring match).
  if (offeringName && offeringName.trim().length >= 2) {
    const trimmedOffering = offeringName.trim().toLowerCase();
    // Word-boundary check so "Acme" doesn't match "academy" etc.
    const pattern = new RegExp(`\\b${trimmedOffering.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (pattern.test(lower)) {
      violations.push(
        `Tier 1 contains the offering name "${offeringName}" — forbidden. The audience reads Tier 1 as a truth about their world; the offering's role is the answer the rest of the message delivers.`
      );
    }
  }

  // Rule 4 — mechanism vocabulary.
  for (const mech of TIER1_FORBIDDEN_MECHANISM) {
    const pattern = new RegExp(`\\b${mech.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (pattern.test(lower)) {
      violations.push(
        `Tier 1 contains mechanism vocabulary "${mech}" — forbidden. The mechanism that addresses the audience's discipline goes in Tier 2 or Tier 3, not the headline.`
      );
      break; // One mechanism flag is enough; no need to enumerate every match.
    }
  }

  // Rule 1 — compound jargon detector. Flag 3+ consecutive nouns/
  // nominalized verbs without intervening common words. Heuristic:
  // identify any 3-word run where each word is 4+ characters AND ends
  // in a noun-like suffix (-tion, -ment, -ity, -ness, -ization, -ing
  // when nominalized) OR is a known business/marketing term. This is
  // cheap and catches the obvious cases like "reactive churn
  // firefighting" or "stakeholder engagement enablement".
  const nominalSuffixes = /(tion|ment|ity|ness|ization|ization|ization|ance|ence|ization|ing)$/i;
  const stopwords = new Set([
    'the', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'for', 'and', 'or',
    'but', 'with', 'by', 'as', 'is', 'are', 'was', 'were', 'be', 'been',
    'have', 'has', 'had', 'this', 'that', 'these', 'those', 'it', 'its',
    'their', 'they', 'we', 'you', 'your', 'our', 'us', 'them', 'because',
    'when', 'while', 'so', 'than',
  ]);
  const tokens = text.split(/[\s\-]+/).filter(t => t.trim().length > 0).map(t => t.replace(/[.,;:!?'"()]/g, ''));
  let runLen = 0;
  for (const t of tokens) {
    if (!t) { runLen = 0; continue; }
    const lc = t.toLowerCase();
    if (stopwords.has(lc) || lc.length < 4) {
      runLen = 0;
      continue;
    }
    // Treat nominalized words OR business/marketing-shaped words as run-eligible.
    const isNominal = nominalSuffixes.test(lc);
    // Heuristic: any 4+-char non-stopword can extend the run; a non-nominal
    // verb won't typically appear in a stack of three. False positives are
    // recoverable via the prompt rule on retry.
    if (isNominal || lc.length >= 6) {
      runLen += 1;
    } else {
      runLen = 0;
    }
    if (runLen >= 3) {
      violations.push(
        `Tier 1 contains a compound-jargon stack near "${t}" — three or more consecutive nominalized terms read as vendor-speak. Replace with everyday language a senior leader would use in private.`
      );
      break;
    }
  }

  return { passed: violations.length === 0, violations };
}

export function buildTier1SentinelFeedback(violations: string[]): string {
  if (violations.length === 0) return '';
  return [
    'TIER 1 MARKET-TRUTH RULE VIOLATIONS — regenerate Tier 1 satisfying these:',
    ...violations.map((v, i) => `${i + 1}. ${v}`),
    '',
    'Re-read the closed-door test: write Tier 1 as if you were summarizing a problem a senior leader at the audience\'s company nodded at in a closed-door conversation, not a tagline. The reader should think "yes, I live in that world" — not "what is this trying to sell me."',
  ].join('\n');
}

// Round 3.4 coaching-fix Finding 2 — second-pass Opus judgment on Tier 1.
// Pattern-match alone is insufficient: Cowork's walk surfaced cases where
// Tier 1 violated the rule in ways the regex lists couldn't catch (subtle
// vendor-speak, paraphrased mechanism vocabulary, novel imperative shapes).
// This second-pass uses Opus to evaluate the Tier 1 against the rule and
// returns a typed yes/no judgment plus a one-sentence reason. Caller
// regenerates on no, with the reason as feedback.

const TIER1_OPUS_JUDGE_SYSTEM = `You evaluate a single Tier 1 message statement against Ken Rosen's market-truth rule.

The Tier 1 must read as something the audience would say to themselves about their own world — not vendor-speak. Specifically:
1. It must NOT begin with an imperative verb directed at the reader (Stop, Get, Improve, Boost, Eliminate, etc.).
2. It must NOT contain the offering's name or describe the offering's mechanism (scoring, ranking, tracking, monitoring, dashboards, analytics, predictions, AI, automation, etc.).
3. It must read like something a senior leader at the audience's company would say to themselves on a Tuesday morning — not a tagline you'd put on a billboard.
4. It must not stack compound jargon ("reactive churn firefighting", "stakeholder engagement enablement").

Your only job: judge whether this Tier 1 follows the rule. Return a single yes/no plus a one-sentence reason naming the specific violation if no.

Return ONLY valid JSON, no markdown fences:
{
  "follows_rule": true | false,
  "reason": "one short sentence — what passes or what fails"
}`;

export interface Tier1OpusJudgeResult {
  followsRule: boolean;
  reason: string;
}

export async function judgeTier1AgainstRuleOpus(tier1Text: string, offeringName?: string): Promise<Tier1OpusJudgeResult> {
  const userMessage = `TIER 1 STATEMENT TO JUDGE:
"${tier1Text}"${offeringName ? `

Offering name (must NOT appear in Tier 1): "${offeringName}"` : ''}

Does this Tier 1 follow the market-truth rule? Be rigorous. If it begins with an imperative verb, contains the offering name, names a mechanism, or reads like a billboard tagline, the answer is no.`;
  const { callAIWithJSON } = await import('./ai.js');
  const result = await callAIWithJSON<{ follows_rule: boolean; reason: string }>(
    TIER1_OPUS_JUDGE_SYSTEM,
    userMessage,
    'elite',
  );
  return {
    followsRule: result.follows_rule === true,
    reason: typeof result.reason === 'string' ? result.reason : '',
  };
}

// ─── Bundle 1A rev3 W1 — shared Tier 1 guard helper ───────────────────
// One source of truth for the Tier 1 market-truth retry logic. Both the
// guided 3T flow (routes/ai.ts:generateTierWithVoiceCheck) and the
// autonomous-build pipeline (lib/expressPipeline.ts: its local tier-
// generation helper) call this same function. The previous rev2 wired
// the retry logic into routes/ai.ts only — Cowork verified Lila's
// "Make the ClarityAudit partnership..." Tier 1 ran through the
// autonomous-build path which had its OWN local tier helper that
// never called the sentinel or the judge. This shared helper closes
// that gap.
//
// Caller passes a `regenerate` closure that re-runs the underlying
// tier-1 generation with the appended feedback. Helper returns the
// final Tier 1 text (possibly prefixed with [TIER1_RETRY_FAILED] if
// the offering name still appears after all retries exhaust).

export async function runTier1MarketTruthGuard(
  initialTier1Text: string,
  offeringName: string | undefined,
  regenerate: (feedbackToAppend: string) => Promise<string>,
): Promise<string> {
  // Bundle 1A rev4 — diagnostic log at entry. When the next regression
  // surfaces, the log trace says exactly which pass crashed.
  console.log(
    `[Tier1Guard] ENTER initial="${initialTier1Text.slice(0, 200)}${initialTier1Text.length > 200 ? '…' : ''}" offering=${offeringName ? `"${offeringName}"` : '(none)'}`,
  );
  let tier1Text = initialTier1Text;
  let exitReason: 'sentinel-passed' | 'opus-passed' | 'hard-blocked' | 'retries-exhausted' = 'sentinel-passed';

  // Pass 1 — cheap regex sentinel with up to 3 retries. Catches the
  // obvious imperative-verb / offering-name / mechanism violations
  // without an Opus round-trip.
  // Bundle 1A rev4 — inner try/catch around regenerate. If regenerate
  // throws (network glitch, JSON parse error from Opus), keep the
  // current tier1Text and break out of Pass 1 — DO NOT propagate.
  // The pipeline must continue with whatever Tier 1 we have.
  let sentinelPassed = false;
  for (let sentinelAttempt = 1; sentinelAttempt <= 3; sentinelAttempt++) {
    const sentinel = checkTier1MarketTruth(tier1Text, offeringName);
    if (sentinel.passed) {
      if (sentinelAttempt > 1) {
        console.log(`[Tier1Sentinel] passed on attempt ${sentinelAttempt}`);
      }
      sentinelPassed = true;
      break;
    }
    console.log(`[Tier1Sentinel] attempt ${sentinelAttempt}/3 — ${sentinel.violations.length} violations:`, sentinel.violations);
    if (sentinelAttempt === 3) {
      console.warn('[Tier1Sentinel] FAILED after 3 retries — handing to Opus judge. Violations:', sentinel.violations);
      break;
    }
    const feedback = '\n\n' + buildTier1SentinelFeedback(sentinel.violations);
    try {
      tier1Text = await regenerate(feedback);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Tier1Sentinel] regenerate threw on attempt ${sentinelAttempt} — keeping current Tier 1, breaking out. Error: ${errMsg}`);
      break;
    }
  }

  // Pass 2 — Opus judge (the methodology floor). Catches subtle vendor-
  // speak the regex can't see. Up to 3 retries.
  let opusPassed = false;
  for (let opusAttempt = 1; opusAttempt <= 3; opusAttempt++) {
    try {
      const judge = await judgeTier1AgainstRuleOpus(tier1Text, offeringName);
      if (judge.followsRule) {
        if (opusAttempt > 1) {
          console.log(`[Tier1OpusJudge] passed on attempt ${opusAttempt}`);
        }
        opusPassed = true;
        break;
      }
      console.log(`[Tier1OpusJudge] attempt ${opusAttempt}/3 — failed: ${judge.reason}`);
      if (opusAttempt === 3) {
        console.warn('[Tier1OpusJudge] FAILED after 3 retries — surfacing for Cowork QA. Reason:', judge.reason);
        break;
      }
      const feedback = `\n\nTIER 1 SECOND-PASS JUDGMENT FAILED. Reason: ${judge.reason}\nRegenerate Tier 1 satisfying the market-truth rule. Do not begin with an imperative verb. Do not contain the offering name. Do not name the offering's mechanism (scoring, ranking, tracking, monitoring, dashboards, analytics, etc.). Write as if summarizing a problem a senior leader nodded at in a closed-door conversation.`;
      tier1Text = await regenerate(feedback);
    } catch (err) {
      console.error('[Tier1OpusJudge] error (fail-open):', err);
      break;
    }
  }

  // Pass 3 — hard-block. After all retries exhaust, if the offering
  // name STILL appears in Tier 1, prepend the [TIER1_RETRY_FAILED]
  // sentinel marker. The deliverable surfaces with a visible failure
  // flag that QA can route. Idempotent — does not double-prefix.
  let hardBlocked = false;
  if (offeringName && offeringName.trim().length >= 2) {
    const offeringPattern = new RegExp(
      `\\b${offeringName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
      'i',
    );
    if (offeringPattern.test(tier1Text) && !tier1Text.startsWith('[TIER1_RETRY_FAILED]')) {
      console.error(
        `[Tier1HardBlock] OFFERING NAME "${offeringName}" still in Tier 1 after all retries — flagging with [TIER1_RETRY_FAILED] sentinel. Final Tier 1: "${tier1Text}"`,
      );
      tier1Text = `[TIER1_RETRY_FAILED] ${tier1Text}`;
      hardBlocked = true;
    }
  }

  if (hardBlocked) exitReason = 'hard-blocked';
  else if (opusPassed) exitReason = 'opus-passed';
  else if (sentinelPassed) exitReason = 'sentinel-passed';
  else exitReason = 'retries-exhausted';

  console.log(
    `[Tier1Guard] EXIT reason=${exitReason} final="${tier1Text.slice(0, 200)}${tier1Text.length > 200 ? '…' : ''}"`,
  );
  return tier1Text;
}

// ─── Settings check ─────────────────────────────────────────

export async function isVoiceCheckEnabled(_userId: string): Promise<boolean> {
  // Always-on voice check. Ken's Voice is the highest-leverage quality gate —
  // if it catches a violation, the generator retries once with feedback.
  // The extra Opus latency is worth it for reliable quality. The cheap regex
  // voice guard in lib/voiceGuard.ts runs first and short-circuits retries
  // for the syntactic cases it can detect, so most violations never reach this.
  return true;
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
