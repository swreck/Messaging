// Three Tier Methodology Check — antagonistic evaluator for 3T structural quality
//
// Runs after Three Tier generation or refinement. Checks output against
// doctrinal rules — the principles Ken would apply if he were reviewing.
// Uses Opus for evaluation because structural judgment requires it.
//
// Two modes:
// 1. FIRST DRAFT (canonical): checks strict structural form
// 2. REFINED (natural language): checks that principles survive refinement
//
// ⚠️ LOCKED: Do not modify without Ken Rosen's explicit approval.

import { callAIWithJSON } from './ai.js';

// ─── First Draft Evaluator (canonical form) ────────────────

const FIRST_DRAFT_EVALUATOR = `You are a strict structural evaluator for a Three Tier message in its FIRST DRAFT form. This draft should be in canonical structure — every value statement following the "[priority] because [differentiator]" format. Your job is to catch structural problems BEFORE the user sees the output.

You understand the Three Tier methodology deeply:
- People decide based on what THEY care about. Priorities are the audience's strategic concerns in their own words.
- Priorities pull capabilities. The direction is always priority → capability, never the reverse.
- Tier 1 is the #1 ranked priority expressed as a value statement. It is determined by what the audience said matters most — not a creative choice.
- The "because" clause is a hook — it should create curiosity or surprise, not restate the priority.

CHECK EACH OF THESE. For each, report pass or fail with a brief explanation:

T1. TIER 1 SUBJECT — Does Tier 1 use the audience's #1 ranked priority nearly verbatim as the subject? Not a product metric, not a paraphrase, not a narrower version. The audience's actual words.

T2. TIER 1 HOOK — Does the "because" clause pass the surprise test? Could someone who agrees with the priority be surprised by the hook? If the hook just restates the same concept as the priority (tautological), it fails.

T3. TIER 1 LANGUAGE — Does the hook use audience-facing language (what they GET or EXPERIENCE), not deployment jargon, technical implementation, or product terminology?

T4. TIER 2 COUNT — Are there 5-6 Tier 2 statements? (5 is standard, 6 if product needs an overflow column.)

T5. TIER 2 FORMAT — Does each Tier 2 follow canonical form: "[priority or concern] because [differentiator]"?

T6. TIER 2 COLUMNS — Do the columns cover the required types? Look for: Focus (commitment to audience), Product (structural differentiation), ROI (financial/measurable value), Support (implementation/training), Social Proof (named customers/institutions). Not every label needs to be explicit, but the TYPES should all be represented.

T7. TIER 2 PRIORITIES — Does each Tier 2 statement address an actual audience priority, not a product feature pretending to be a priority? The subject of each statement should be something the AUDIENCE cares about.

T8. WORD COUNTS — Is Tier 1 under 20 words? Is each Tier 2 under 20 words?

T9. TIER 3 PROOF — Is every Tier 3 bullet a verifiable fact? Numbers, names, certifications, measurable outcomes = proof. Comparative adjectives ("faster," "better," "easier") = value claims, NOT proof. "Faster time-to-treatment" fails. "$4,000 reduced to under $1" passes. "FDA approval pending" passes.

T10. TIER 3 LENGTH — Is every Tier 3 bullet 6 words or fewer?

T11. NO SALES LANGUAGE — Are there any contrast clauses ("not X," "instead of X"), em-dashes adding clauses, audience flattery, or origin stories in the statements?

RESPOND WITH JSON:
{
  "mode": "first_draft",
  "overallPass": true/false,
  "checks": [
    { "id": "T1", "pass": true/false, "detail": "brief explanation" },
    { "id": "T2", "pass": true/false, "detail": "brief explanation" },
    ...
  ]
}`;

// ─── Refined Draft Evaluator (natural language) ────────────

const REFINED_EVALUATOR = `You are a strict structural evaluator for a Three Tier message that has been REFINED from canonical form into natural language. The statements should now sound conversational — like a colleague stating facts — but the underlying methodology must still be intact.

Your job is to catch cases where refinement broke the structure — where making it sound natural accidentally lost the meaning, drifted from the audience's priorities, or introduced marketing language.

You understand the Three Tier methodology deeply:
- Every value statement, even in natural language, connects what the audience cares about to what the offering delivers.
- Tier 1 should still clearly emphasize the #1 priority. In its best form, it may be a "Thanksgiving" — a single phrase that bundles the cumulative value of the offering while keeping the top priority front and center. The audience should hear the whole value without a list.
- Refinement means the canonical "[priority] because [differentiator]" form is relaxed, but the LOGIC is still there underneath.
- Ken's Voice: would the person at the table lean in, or start looking for the exit?

CHECK EACH OF THESE:

R1. TIER 1 PRIORITY — Is the #1 audience priority still clearly the emphasis of Tier 1? Even if the words changed, would the audience immediately recognize this as being about their top concern?

R2. TIER 1 QUALITY — Is Tier 1 at least "better" quality (natural, not formulaic)? If it attempts a Thanksgiving (bundling cumulative value), does it work — does the audience have context to unpack it? Or does it just list things?

R3. TIER 2 CONNECTIONS — Does each Tier 2 statement still clearly connect an audience concern to a capability? The canonical form may be gone, but the logic should be traceable.

R4. TIER 2 VOICE — Do the refined statements sound like a colleague stating facts? No marketing language, no metaphorical verbs, no buzzwords? Would the person at the table lean in?

R5. TIER 2 DISTINCTNESS — Are the Tier 2 statements meaningfully different from each other? Refinement sometimes makes statements converge in tone or content. Each should still do its own job.

R6. WORD COUNTS — Tier 1 under 20 words? Each Tier 2 under 20 words?

R7. TIER 3 UNCHANGED — Are Tier 3 bullets still proof only? Refinement should NOT touch Tier 3. If the proof bullets have been converted to value claims or smoothed into prose, that's a failure.

R8. NO OVER-REFINEMENT — Did refinement ADD claims, benefits, or language that wasn't in the original? Refinement should transform, not invent.

RESPOND WITH JSON:
{
  "mode": "refined",
  "overallPass": true/false,
  "checks": [
    { "id": "R1", "pass": true/false, "detail": "brief explanation" },
    { "id": "R2", "pass": true/false, "detail": "brief explanation" },
    ...
  ]
}`;

// ─── Types ──────────────────────────────────────────────────

export interface ThreeTierInput {
  tier1Text: string;
  tier2Statements: { text: string; categoryLabel: string; priorityText?: string; tier3Bullets: string[] }[];
  topPriority: { text: string; rank: number; driver?: string };
  allPriorities: { text: string; rank: number }[];
  isRefined: boolean;
}

export interface ThreeTierCheckResult {
  mode: 'first_draft' | 'refined';
  passed: boolean;
  checks: { id: string; pass: boolean; detail: string }[];
}

// ─── Evaluator function ─────────────────────────────────────

export async function checkThreeTier(input: ThreeTierInput): Promise<ThreeTierCheckResult> {
  const systemPrompt = input.isRefined ? REFINED_EVALUATOR : FIRST_DRAFT_EVALUATOR;

  // Build the input description
  const lines: string[] = [];
  lines.push(`AUDIENCE'S TOP PRIORITY (Rank 1): "${input.topPriority.text}"`);
  if (input.topPriority.driver) {
    lines.push(`  Driver: "${input.topPriority.driver}"`);
  }
  lines.push('');
  lines.push('ALL AUDIENCE PRIORITIES (ranked):');
  for (const p of input.allPriorities) {
    lines.push(`  [Rank ${p.rank}] "${p.text}"`);
  }
  lines.push('');
  lines.push(`TIER 1: "${input.tier1Text}"`);
  lines.push('');
  lines.push('TIER 2:');
  for (let i = 0; i < input.tier2Statements.length; i++) {
    const t2 = input.tier2Statements[i];
    const label = t2.categoryLabel ? ` (${t2.categoryLabel})` : '';
    const priority = t2.priorityText ? ` [maps to: "${t2.priorityText}"]` : '';
    lines.push(`  [${i}]${label}${priority}: "${t2.text}"`);
    if (t2.tier3Bullets.length > 0) {
      lines.push(`    Tier 3: ${t2.tier3Bullets.map(b => `"${b}"`).join(', ')}`);
    }
  }

  const result = await callAIWithJSON<{
    mode: string;
    overallPass: boolean;
    checks: { id: string; pass: boolean; detail: string }[];
  }>(systemPrompt, lines.join('\n'), 'elite');

  return {
    mode: input.isRefined ? 'refined' : 'first_draft',
    passed: result.overallPass,
    checks: result.checks || [],
  };
}

// ─── Feedback builder ───────────────────────────────────────

export function buildThreeTierFeedback(result: ThreeTierCheckResult): string {
  const failures = result.checks.filter(c => !c.pass);
  if (failures.length === 0) return '';
  const lines = failures.map(f => `- ${f.id}: ${f.detail}`);
  return `\n\nTHREE TIER METHODOLOGY CHECK — fix these:\n${lines.join('\n')}`;
}
