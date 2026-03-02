/**
 * AI Evaluator Loop for Prompt Quality
 *
 * Generates refined Tier 2 output, then has a SEPARATE Claude call evaluate
 * it against Ken's Voice rules. In --iterate mode, auto-improves the prompt
 * until the evaluator passes (up to 5 rounds).
 *
 * Run:
 *   cd backend && npx tsx test-prompt-eval.ts
 *   cd backend && npx tsx test-prompt-eval.ts --iterate
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { REFINE_LANGUAGE_SYSTEM } from './src/prompts/generation.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const ITERATE = process.argv.includes('--iterate');
const MAX_ROUNDS = 5;
const GEN_MODEL = 'claude-opus-4-6';    // matches production (elite tier)
const EVAL_MODEL = 'claude-opus-4-6';   // evaluator — same capability, different role

// ─── Test Scenarios ──────────────────────────────────────

interface Tier2Input {
  text: string;
  column: 'Product' | 'ROI' | 'Support' | 'Focus' | 'Social proof';
}

interface Scenario {
  name: string;
  tier2: Tier2Input[];
  priorities: string[];
}

const SCENARIOS: Scenario[] = [
  {
    name: 'Medical Diagnostics',
    tier2: [
      { text: 'You protect the financial health of your hospital because cancer pathology testing can cost under $1 per slide', column: 'Product' },
      { text: 'You get better outcomes for cancer patients because slide results are available in under 60 seconds', column: 'Product' },
      { text: 'You reduce malpractice risk because validated data shows 40% fewer false negatives', column: 'ROI' },
      { text: 'You keep your best pathologists engaged because AI handles routine screening so they focus on complex cases', column: 'Support' },
      { text: 'Our entire company is focused on oncology diagnosis within a hospital setting', column: 'Focus' },
      { text: 'Geisinger Health and Cleveland Clinic are in active evaluation with zero breaches of data protocol', column: 'Social proof' },
    ],
    priorities: [
      'Protecting the financial health of our hospital',
      'Better outcomes for our cancer patients',
      'Reducing our exposure to malpractice risk',
      'Keeping our best pathologists engaged and productive',
    ],
  },
  {
    name: 'Construction Management',
    tier2: [
      { text: 'You keep every project on schedule because the platform monitors 200 risk signals per project daily', column: 'Product' },
      { text: 'You see problems before they become crises because the system predicted 87% of delays 3 weeks early in pilot', column: 'Product' },
      { text: 'You protect your reputation with building owners because real-time budget visibility keeps every stakeholder informed', column: 'ROI' },
      { text: 'You retain your best project managers because automated monitoring replaces manual firefighting', column: 'Support' },
      { text: 'Commercial construction project delivery is the entire focus of our company and platform', column: 'Focus' },
      { text: 'Hensel Phelps and Turner Construction are in active deployment across 40 combined project sites', column: 'Social proof' },
    ],
    priorities: [
      'Keeping every project on schedule and on budget',
      'Seeing problems across all our sites before they become crises',
      'Protecting our reputation with building owners',
      'Retaining our best project managers',
    ],
  },
  {
    name: 'Community Bank Cybersecurity',
    tier2: [
      { text: 'You protect your institution from a data breach because pre-mapped FFIEC controls give you 90% coverage on day one', column: 'Product' },
      { text: 'You prove compliance without drowning in audit prep because automated reports are exam-ready out of the box', column: 'Product' },
      { text: 'You get cybersecurity talent at community bank pay because the 24/7 security operations center is fully staffed for you', column: 'ROI' },
      { text: 'You avoid disrupting your team during implementation because full onboarding completes in 30 days including staff training', column: 'Support' },
      { text: 'Community bank and credit union security is the entire focus of our company', column: 'Focus' },
      { text: '180 community banks protected with zero breaches in 4 years', column: 'Social proof' },
    ],
    priorities: [
      'Protecting our institution from a data breach',
      'Proving compliance without drowning in audit prep',
      'Recruiting and keeping cybersecurity talent at community bank pay',
      'Not disrupting our team during implementation',
    ],
  },
];

// ─── Evaluator Prompt ────────────────────────────────────

const EVALUATOR_SYSTEM = `You are a strict quality evaluator for business messaging text. You are NOT the writer — you are the independent reviewer. Your ONLY job is to check each statement against the rules below and report violations. Be harsh. If something is borderline, call it a violation.

THE SMALL-TABLE TEST: Imagine the statement being said out loud at a small table to one smart but less informed professional acquaintance. Would the person lean in with interest? Or start looking for an excuse to leave because they feel sold to? Pass the first, fail the second.

COLUMN CONTEXT — each statement belongs to a column type:
- **Focus**: A simple declaration of company commitment ("X is the entire focus of our company"). These are SUPPOSED to be company-centric. Do NOT flag rule 9 on Focus statements. They're often the simplest statement in the table.
- **Social proof**: Named customers, institutions, or adoption numbers. These are factual references. Apply rules lightly — the main concern is marketing language, not subject/structure.
- **Product, ROI, Support**: Standard value statements. Apply all rules strictly.

RULES — each statement must pass ALL applicable rules:

1. NO RHETORICAL QUESTIONS. Any sentence ending in "?" is a fail.

2. NO COLONS AS STYLISTIC DEVICE. "Your results: under 60 seconds" or "Accuracy you can trust: oncologist founders..." — these are ad copy layouts. A colon in a natural list is OK ("three things: A, B, and C"). A colon used to create a dramatic reveal is not.

3. NO NARRATED TRANSFORMATIONS. "From X to Y," "drops from X to Y," "goes from X to Y," "one week to seconds," "X reduced to Y." Just state the end result.

4. NO METAPHORICAL VERBS. Watch for: fades, unlocks, fuels, drives, powers, transforms, bridges, reshapes, elevates, ignites, amplifies. "Burns out" is metaphorical. "Secures" and "protects" are OK when literal (actual security/protection), not when abstract.

5. NO CONTRAST CLAUSES after the main claim. "not X," "instead of X," "no tradeoff." Just state the fact and stop.

6. NO EM-DASHES adding extra clauses (" — ").

7. NO DRAMATIC FRAGMENTS. Short punchy sentences used for effect: "Speed and accuracy." "One number says it all."

8. NO MARKETING BUZZWORDS. leverage, seamless, cutting-edge, best-in-class, robust, game-changing, end-to-end, comprehensive, holistic, enterprise-level.

9. RESULT IS THE SUBJECT, NOT THE PRODUCT (except Focus and Social proof columns). The sentence should describe what the audience gets. "The platform monitors 200 signals" — product as subject, fail. "We monitor 200 signals" — acceptable, sounds like a person. "200 risk signals are monitored per project daily" — forced passive, borderline.

10. WORD COUNT ≤ 20.

11. NO APPENDED BENEFIT CLAUSES. ", which protects..." or ", which directly improves..." or ", reducing X" or ", keeping X" or "so X stays Y" tacked onto the end of a fact. These read as persuasive linkage — including participial rewrites. State the fact. Let the connection speak for itself. HOWEVER: a natural "so" or "which" connecting two parts of the SAME fact is OK ("AI handles screening so pathologists focus on complex cases" — both halves describe the same operational reality).

12. NO STACKED COMPOUND NOUNS. Two or more nouns jammed together without articles or verbs. "Same-day diagnostic confidence" is a label, not speech. "Pathologist review" is compressed — "the pathologist reviews it" is how people talk. "Real-time delay detection" is a spec sheet — "we detect delays in real time" is a person talking.

13. NO MISSING ARTICLES OR PREPOSITIONS. "Fixed monthly subscription covers..." is a headline. "A fixed monthly subscription covers..." is a person. "Tracked every session" is compressed — "tracked during every session" is natural. If natural speech would have the article or preposition, it must be there.

14. NO OVER-PRECISE PERCENTAGES. "99.2%" or "94.7%" sound like marketing claims. Should be "over 99%" or "over 94%." Technical metrics (validity coefficients, p-values) should be translated to human-scale comparisons. "3.2 times" should be "over 3x."

15. NO DENSE MULTI-CLAIM PACKING. If a sentence contains more than one impressive number or selling point, it sounds rehearsed. Should be split into two sentences or simplified.

16. NO URGENCY PHRASES. "Ahead of time" manufactures urgency. Just describe the actual timeline plainly.

RESPOND WITH JSON ONLY:
{
  "statements": [
    { "index": 0, "pass": true, "text": "the statement text", "column": "Product" },
    { "index": 1, "pass": false, "text": "the statement text", "column": "ROI", "violations": ["rhetorical question", "metaphorical verb: fades"] }
  ],
  "overallPass": false,
  "passCount": 4,
  "totalCount": 6,
  "summary": "4 of 6 pass. Failures: [1] rhetorical question, [4] narrated transformation"
}`;

// ─── Prompt Improver ─────────────────────────────────────

const IMPROVER_SYSTEM = `You are a prompt engineer. You will receive a system prompt that generates business messaging text, along with specific quality violations found in its output. Your job is to suggest a MINIMAL, TARGETED edit to the system prompt that would fix the violations WITHOUT breaking anything else.

RULES:
- Return the COMPLETE revised system prompt (not just the diff)
- Only change what's necessary to fix the reported violations
- Don't add new sections or restructure — make surgical edits
- If a violation type keeps recurring, add it to the banned patterns with an explicit example
- Keep the prompt length roughly the same — don't bloat it

RESPOND WITH JSON:
{
  "revisedPrompt": "the complete revised system prompt...",
  "changes": ["Added explicit ban on rhetorical questions with example", "Strengthened narrated transformation rule"]
}`;

// ─── Helpers ─────────────────────────────────────────────

async function callJSON<T>(system: string, user: string, model: string): Promise<T> {
  const resp = await client.messages.create({
    model,
    max_tokens: 4000,
    system: system + '\n\nRespond with valid JSON only. No markdown fences, no explanation.',
    messages: [{ role: 'user', content: user }],
  });
  const text = resp.content[0].type === 'text' ? resp.content[0].text : '';
  const cleaned = text.replace(/^```json?\n?/m, '').replace(/\n?```$/m, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in response: ' + cleaned.slice(0, 200));
  return JSON.parse(match[0]) as T;
}

function buildRefineInput(scenario: Scenario): string {
  const stmts = scenario.tier2.map((t, i) => `[${i}] "${t.text}"`).join('\n');
  const pris = scenario.priorities.map((p, i) => `[Rank ${i + 1}] "${p}"`).join('\n');
  return `TIER 2 STATEMENTS TO REFINE:\n${stmts}\n\nAUDIENCE PRIORITIES (for reference):\n${pris}`;
}

interface EvalResult {
  statements: { index: number; pass: boolean; text: string; violations?: string[] }[];
  overallPass: boolean;
  passCount: number;
  totalCount: number;
  summary: string;
}

// ─── Main Loop ───────────────────────────────────────────

async function runScenario(scenario: Scenario, systemPrompt: string, round: number): Promise<{ eval: EvalResult; refined: string[] }> {
  // Step 1: Generate
  const input = buildRefineInput(scenario);
  const genResult = await callJSON<{ refinedTier2: { index: number; text: string }[] }>(
    systemPrompt, input, GEN_MODEL
  );
  const refined = genResult.refinedTier2.map(r => r.text);

  // Step 2: Evaluate
  const evalInput = `ORIGINAL STATEMENTS:\n${scenario.tier2.map((t, i) => `[${i}] (${t.column}) "${t.text}"`).join('\n')}\n\nREFINED STATEMENTS:\n${refined.map((t, i) => `[${i}] (${scenario.tier2[i].column}) "${t}"`).join('\n')}`;
  const evalResult = await callJSON<EvalResult>(EVALUATOR_SYSTEM, evalInput, EVAL_MODEL);

  return { eval: evalResult, refined };
}

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log('  Prompt Quality Evaluator');
  console.log(`  Mode: ${ITERATE ? 'Iterate (up to ' + MAX_ROUNDS + ' rounds)' : 'One-shot'}`);
  console.log(`  Generator: ${GEN_MODEL} | Evaluator: ${EVAL_MODEL}`);
  console.log(`  Scenarios: ${SCENARIOS.length}`);
  console.log(`${'='.repeat(60)}\n`);

  let currentPrompt = REFINE_LANGUAGE_SYSTEM;
  let allPassed = true;

  for (const scenario of SCENARIOS) {
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`  ${scenario.name}`);
    console.log(`${'─'.repeat(50)}`);

    let round = 1;
    let scenarioPrompt = currentPrompt;

    while (round <= (ITERATE ? MAX_ROUNDS : 1)) {
      console.log(`\n  Round ${round}:`);

      const { eval: evalResult, refined } = await runScenario(scenario, scenarioPrompt, round);

      // Print results
      for (const stmt of evalResult.statements) {
        if (stmt.pass) {
          console.log(`    [${stmt.index}] PASS: "${stmt.text}"`);
        } else {
          console.log(`    [${stmt.index}] FAIL: "${stmt.text}"`);
          if (stmt.violations) {
            for (const v of stmt.violations) {
              console.log(`           → ${v}`);
            }
          }
        }
      }

      console.log(`\n    Result: ${evalResult.passCount}/${evalResult.totalCount} pass`);

      if (evalResult.overallPass) {
        console.log('    ✓ All statements pass!');
        break;
      }

      allPassed = false;

      if (!ITERATE || round >= MAX_ROUNDS) {
        console.log(`    ✗ ${evalResult.totalCount - evalResult.passCount} failures remain`);
        break;
      }

      // Step 3: Improve the prompt
      console.log('\n    Adjusting prompt...');
      const violations = evalResult.statements
        .filter(s => !s.pass)
        .map(s => `[${s.index}] "${s.text}" — violations: ${(s.violations || []).join(', ')}`)
        .join('\n');

      const improveInput = `CURRENT SYSTEM PROMPT:\n${scenarioPrompt}\n\nVIOLATIONS FOUND IN OUTPUT:\n${violations}\n\nFix the prompt so these violations don't recur.`;

      const improved = await callJSON<{ revisedPrompt: string; changes: string[] }>(
        IMPROVER_SYSTEM, improveInput, EVAL_MODEL
      );

      for (const change of improved.changes) {
        console.log(`      • ${change}`);
      }

      scenarioPrompt = improved.revisedPrompt;
      round++;
    }

    // If iteration improved the prompt, carry it forward to next scenario
    if (ITERATE) {
      currentPrompt = scenarioPrompt;
    }
  }

  // ─── Final Report ────────────────────────────────────

  console.log(`\n${'='.repeat(60)}`);
  if (allPassed) {
    console.log('  ALL SCENARIOS PASSED ✓');
  } else {
    console.log('  SOME FAILURES REMAIN');
  }

  if (ITERATE && currentPrompt !== REFINE_LANGUAGE_SYSTEM) {
    console.log('\n  IMPROVED PROMPT (copy to generation.ts if satisfied):');
    console.log('  ' + '─'.repeat(48));
    console.log(currentPrompt);
    console.log('  ' + '─'.repeat(48));
  }

  console.log(`${'='.repeat(60)}\n`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
