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

const CASES: BaselineCase[] = [
  {
    label: 'A — full free-form with explicit ask',
    input: `We make ClarityAudit, a partnership operations platform for healthcare diagnostics companies. We help midmarket diagnostics partner-ops teams (typically VPs of Strategic Partnerships at companies like Veracore Diagnostics or Synthesis Health) close their first-quarter partnership outcomes faster — 31 of our 47 audits last year produced a CRO-buyer outcome inside the first quarter, and four sponsor companies traced their FDA approvals directly to fixes our reviews surfaced.
I'm writing a one-page email to Liam Patel, VP Strategic Partnerships at Veracore Diagnostics. The tone should be partner-to-partner, not sales pitch.
I want them to confirm Veracore's participation in our joint Q3 webinar by May 15.`,
    expectedFields: {
      offeringNameContains: 'ClarityAudit',
      differentiatorsMin: 4,
      audiencesMin: 1,
      primaryMediumValue: 'email',
      situationMinChars: 80,
      verbatimAskExpected: 'present',
    },
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
];

async function runCase(c: BaselineCase): Promise<void> {
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
