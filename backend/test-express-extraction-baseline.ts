/**
 * Express Extraction Baseline Test — Bundle 1A rev6 Phase 1.
 *
 * Cowork Addition A: confirms no quality regression in
 * extractExpressInterpretation after the Phase 1 prompt extension that
 * adds verbatimAsk extraction. Run this BEFORE the prompt change to
 * capture a baseline, then AFTER to confirm the existing extraction
 * fields still produce values of the right shape and similar quality.
 *
 * Run: npx tsx test-express-extraction-baseline.ts
 *
 * Output: stdout JSON. Manual review confirms the extraction's
 * structure-and-quality. The before/after diff lives in your shell
 * scrollback — this script does not auto-compare.
 */

import 'dotenv/config';
import { extractExpressInterpretation } from './src/lib/expressExtraction.js';

interface BaselineCase {
  label: string;
  input: string;
  expectedFields: {
    offeringNameContains?: string;
    differentiatorsMin: number;
    audiencesMin: number;
    primaryMediumValue: string;
    situationMinChars: number;
    verbatimAskExpected: 'present' | 'empty';
  };
}

interface BaselineCaseExtended extends BaselineCase {
  // Bundle 1A rev7 Rule 4 — verbatim ask must contain certain
  // substrings (preserved signal) AND must NOT contain certain
  // substrings (dropped noise).
  verbatimAskMustContain?: string[];
  verbatimAskMustNotContain?: string[];
}

const CASES: BaselineCaseExtended[] = [
  {
    label: 'A — full free-form with explicit ask (rev7: possessive preserved)',
    input: `We make ClarityAudit, a partnership operations platform for healthcare diagnostics companies. We help midmarket diagnostics partner-ops teams (typically VPs of Strategic Partnerships at companies like Veracore Diagnostics or Synthesis Health) close their first-quarter partnership outcomes faster — 31 of our 47 audits last year produced a CRO-buyer outcome inside the first quarter, and four sponsor companies traced their FDA approvals directly to fixes our reviews surfaced.
I'm writing a one-page email to Liam Patel, VP Strategic Partnerships at Veracore Diagnostics. The tone should be partner-to-partner, not sales pitch.
We want him to confirm Veracore's participation in our joint Q3 webinar by May 15.`,
    expectedFields: {
      offeringNameContains: 'ClarityAudit',
      differentiatorsMin: 4,
      audiencesMin: 1,
      primaryMediumValue: 'email',
      situationMinChars: 80,
      verbatimAskExpected: 'present',
    },
    // Rule 4: possessive "Veracore's" must survive into verbatimAsk.
    // Imperative-marker prefix "We want him to" must be dropped.
    verbatimAskMustContain: ["Veracore's", "May 15"],
    verbatimAskMustNotContain: ["We want him to", "we want him to"],
  },
  {
    label: 'B — no explicit ask',
    input: `We sell BlueSky Forecast, a regional-bank treasury risk dashboard. Our buyers are CFOs of community and regional banks under $5B in assets. They worry about FFIEC examiner findings and shrinking margin. We can predict 90 days of liquidity stress with under 5 percent error and run on top of any core (Jack Henry, FIS, Fiserv).
I need a pitch deck for a regional bank CFO conference on Friday in Charlotte.`,
    expectedFields: {
      offeringNameContains: 'BlueSky',
      differentiatorsMin: 3,
      audiencesMin: 1,
      primaryMediumValue: 'pitch_deck',
      situationMinChars: 50,
      verbatimAskExpected: 'empty',
    },
  },
  {
    label: 'C — rev7 Rule 4: filler + hedge dropped, real deadline preserved',
    input: `Selling DemoBox, a sales-tool platform for B2B SaaS demo teams. Buyers are sales-ops managers. Sample-size friction is their main pain.
I need an email to a sales-ops contact at a mid-size SaaS.
we want him to like sign up for the demo by friday or whenever works.`,
    expectedFields: {
      offeringNameContains: 'DemoBox',
      differentiatorsMin: 1,
      audiencesMin: 1,
      primaryMediumValue: 'email',
      situationMinChars: 30,
      verbatimAskExpected: 'present',
    },
    // Rule 4: filler "like" and hedge "or whenever works" must be
    // dropped. Real deadline "Friday" must be preserved. Imperative
    // marker "we want him to" must be dropped.
    verbatimAskMustContain: ["sign up for the demo", "Friday"],
    verbatimAskMustNotContain: ["like ", "or whenever works", "we want him to"],
  },
  {
    label: 'D — rev7 Rule 4: simple imperative, full noun phrase preserved',
    input: `Building OnboardCo, a SaaS onboarding platform. We help RevOps managers shorten onboarding cycles.
I need a follow-up email after our demo last week.
I want them to schedule the partner's onboarding kickoff by Friday.`,
    expectedFields: {
      offeringNameContains: 'OnboardCo',
      differentiatorsMin: 1,
      audiencesMin: 1,
      primaryMediumValue: 'email',
      situationMinChars: 25,
      verbatimAskExpected: 'present',
    },
    // Rule 4: possessive "the partner's" must survive. Imperative
    // marker "I want them to" must be dropped.
    verbatimAskMustContain: ["the partner's", "Friday"],
    verbatimAskMustNotContain: ["I want them to"],
  },
];

async function runCase(c: BaselineCaseExtended): Promise<void> {
  console.log(`\n═══ CASE ${c.label} ═══`);
  console.log(`Input: ${c.input.slice(0, 200)}…\n`);
  const t0 = Date.now();
  let result;
  try {
    result = await extractExpressInterpretation(c.input);
  } catch (err: any) {
    console.error(`  FAIL — extraction threw: ${err?.message || String(err)}`);
    return;
  }
  const ms = Date.now() - t0;
  console.log(`  latency: ${ms}ms`);

  // Structure assertions.
  const checks: { label: string; pass: boolean; detail?: string }[] = [];
  checks.push({
    label: 'mode === "autonomous" (rev6 coercion)',
    pass: result.mode === 'autonomous',
    detail: `mode=${JSON.stringify(result.mode)}`,
  });
  checks.push({
    label: `offering.name contains "${c.expectedFields.offeringNameContains || ''}"`,
    pass: c.expectedFields.offeringNameContains
      ? result.offering.name.toLowerCase().includes(c.expectedFields.offeringNameContains.toLowerCase())
      : true,
    detail: `name="${result.offering.name}"`,
  });
  checks.push({
    label: `differentiators >= ${c.expectedFields.differentiatorsMin}`,
    pass: (result.offering.differentiators || []).length >= c.expectedFields.differentiatorsMin,
    detail: `count=${(result.offering.differentiators || []).length}`,
  });
  checks.push({
    label: `audiences >= ${c.expectedFields.audiencesMin}`,
    pass: (result.audiences || []).length >= c.expectedFields.audiencesMin,
    detail: `count=${(result.audiences || []).length}`,
  });
  checks.push({
    label: `primaryMedium.value === "${c.expectedFields.primaryMediumValue}"`,
    pass: result.primaryMedium?.value === c.expectedFields.primaryMediumValue,
    detail: `value=${JSON.stringify(result.primaryMedium?.value)}`,
  });
  checks.push({
    label: `situation length >= ${c.expectedFields.situationMinChars}`,
    pass: (result.situation || '').length >= c.expectedFields.situationMinChars,
    detail: `length=${(result.situation || '').length}`,
  });
  // verbatimAsk shape check (rev6 Phase 1.D).
  if (c.expectedFields.verbatimAskExpected === 'present') {
    checks.push({
      label: 'verbatimAsk non-empty (user stated an ask)',
      pass: typeof result.verbatimAsk === 'string' && result.verbatimAsk.length > 0,
      detail: `verbatimAsk=${JSON.stringify(result.verbatimAsk).slice(0, 200)}`,
    });
    // Tone-note exclusion check.
    checks.push({
      label: 'verbatimAsk does not contain tone language',
      pass: !/\b(tone|partner-to-partner|sales pitch)\b/i.test(result.verbatimAsk || ''),
      detail: `verbatimAsk=${JSON.stringify(result.verbatimAsk)}`,
    });
  } else {
    checks.push({
      label: 'verbatimAsk is empty (user did not state an ask)',
      pass: typeof result.verbatimAsk === 'string' && result.verbatimAsk.length === 0,
      detail: `verbatimAsk=${JSON.stringify(result.verbatimAsk)}`,
    });
  }
  // Rule 4 — preserved-signal / dropped-noise assertions.
  if (c.verbatimAskMustContain) {
    for (const must of c.verbatimAskMustContain) {
      checks.push({
        label: `verbatimAsk preserves "${must}"`,
        pass: typeof result.verbatimAsk === 'string' && result.verbatimAsk.includes(must),
        detail: `verbatimAsk=${JSON.stringify(result.verbatimAsk)}`,
      });
    }
  }
  if (c.verbatimAskMustNotContain) {
    for (const mustNot of c.verbatimAskMustNotContain) {
      checks.push({
        label: `verbatimAsk drops "${mustNot}"`,
        pass: typeof result.verbatimAsk === 'string' && !result.verbatimAsk.includes(mustNot),
        detail: `verbatimAsk=${JSON.stringify(result.verbatimAsk)}`,
      });
    }
  }
  for (const ck of checks) {
    console.log(`  ${ck.pass ? '✓' : '✗'} ${ck.label}${ck.detail ? ` — ${ck.detail}` : ''}`);
  }
}

async function main(): Promise<void> {
  console.log('Express Extraction Baseline — Bundle 1A rev6 Phase 1');
  console.log('Two cases, manual review of stdout. Run before AND after prompt change.');
  for (const c of CASES) {
    await runCase(c);
  }
  console.log('\nDone.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
