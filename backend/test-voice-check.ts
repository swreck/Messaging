/**
 * Voice Check Test Suite
 *
 * Tests the voice check service with real Opus calls against
 * known-good and known-bad statements and prose.
 *
 * Run: cd backend && npx tsx test-voice-check.ts
 */

import 'dotenv/config';
import {
  checkStatements,
  checkProse,
  buildViolationFeedback,
  buildProseViolationFeedback,
  type StatementInput,
  type StatementViolation,
} from './src/services/voiceCheck.js';

// ─── Test data: statements that SHOULD PASS ──────────────

const GOOD_STATEMENTS: StatementInput[] = [
  // Natural "we" construction — must NOT be flagged as rule 9
  { text: 'We handle the routine screening so your pathologists can work on the complex cases', column: 'Support' },
  // Focus column — company-centric is correct
  { text: 'Oncology diagnosis in a hospital setting is the entire focus of our company', column: 'Focus' },
  // Social proof — factual, named entities
  { text: 'Geisinger Health and Cleveland Clinic are both evaluating the technology', column: 'Social proof' },
  // Clean value statement, audience as subject
  { text: 'You spend under $1 per slide for cancer pathology testing', column: 'Product' },
  // Natural conversational tone, under 20 words
  { text: 'Your project team gets automated monitoring reports every morning', column: 'Support' },
  // ROI with plain fact
  { text: 'Full onboarding takes 30 days, including training for your staff', column: 'Support' },
  // Clean "we" construction
  { text: 'We staff a 24/7 security operations center for you at community bank pay rates', column: 'ROI' },
];

// ─── Test data: statements that SHOULD FAIL ──────────────

const BAD_STATEMENTS: StatementInput[] = [
  // Rule 1: rhetorical question
  { text: 'Worried about compliance? We handle it all for you automatically', column: 'Product' },
  // Rule 2: colon as stylistic device
  { text: 'Your results: under 60 seconds with AI-powered analysis', column: 'Product' },
  // Rule 3: narrated transformation
  { text: 'Testing costs drop from $4,000 to under $1 per slide', column: 'ROI' },
  // Rule 4: metaphorical verb
  { text: 'Our platform unlocks faster pathology results for your team', column: 'Product' },
  // Rule 5: contrast clause
  { text: 'You get results in under a minute, not days or weeks of waiting', column: 'Product' },
  // Rule 8: marketing buzzword
  { text: 'Our seamless end-to-end solution handles all compliance requirements', column: 'Product' },
  // Rule 12: stacked compound nouns
  { text: 'Same-day diagnostic confidence from on-site real-time pathology analysis', column: 'Product' },
  // Rule 13: missing articles
  { text: 'Fixed monthly subscription covers all updates and ongoing support', column: 'ROI' },
  // Rule 11: appended benefit clause
  { text: '40% fewer false negatives, which cuts your malpractice exposure significantly', column: 'ROI' },
];

// ─── Test data: prose that SHOULD PASS ───────────────────

const GOOD_PROSE = `When a tissue sample arrives at the lab, the pathologist needs answers quickly. With on-site digital analysis, slide results are available in under 60 seconds. That means the clinician can begin a treatment conversation during the same visit, rather than scheduling a follow-up days later.

The system digitizes each slide at 40x resolution. Automated quality checks flag tissue artifacts before the pathologist reviews them. In validation studies, this process showed 40% fewer false negatives compared to manual screening alone.

Geisinger Health and Cleveland Clinic are currently evaluating the technology across their pathology departments.`;

// ─── Test data: prose that SHOULD FAIL ───────────────────

const BAD_PROSE = `Our cutting-edge platform unlocks a seamless diagnostic experience that transforms how hospitals approach cancer pathology. From week-long turnaround times to under 60 seconds — the results speak for themselves.

Speed and accuracy. That's what drives everything we do.

At its core, our solution leverages advanced AI to bridge the gap between traditional pathology and modern precision medicine, elevating diagnostic confidence to enterprise-level standards.`;

// ─── Test runner ─────────────────────────────────────────

let passed = 0;
let failed = 0;
let total = 0;

function assert(label: string, condition: boolean, detail?: string) {
  total++;
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function testGoodStatements() {
  console.log('\n── Good statements (should all pass) ──');
  const result = await checkStatements(GOOD_STATEMENTS);

  // Overall should pass
  assert('All good statements pass overall', result.passed,
    result.passed ? undefined : `${result.violations.length} violations found`);

  // Check each individually
  for (let i = 0; i < GOOD_STATEMENTS.length; i++) {
    const violation = result.violations.find(v => v.index === i);
    assert(
      `[${i}] "${GOOD_STATEMENTS[i].text.substring(0, 60)}..."`,
      !violation,
      violation ? `False positive: ${violation.rules.join(', ')}` : undefined,
    );
  }
}

async function testBadStatements() {
  console.log('\n── Bad statements (should all fail) ──');
  const result = await checkStatements(BAD_STATEMENTS);

  // Overall should fail
  assert('Bad statements fail overall', !result.passed);

  // Check each individually
  for (let i = 0; i < BAD_STATEMENTS.length; i++) {
    const violation = result.violations.find(v => v.index === i);
    assert(
      `[${i}] "${BAD_STATEMENTS[i].text.substring(0, 60)}..."`,
      !!violation,
      violation ? `Caught: ${violation.rules.join(', ')}` : 'False negative — evaluator missed this',
    );
  }
}

async function testGoodProse() {
  console.log('\n── Good prose (should pass) ──');
  const result = await checkProse(GOOD_PROSE, 'Chapter 4: The Proof');
  assert('Good prose passes', result.passed,
    result.passed ? undefined : `False positives: ${result.violations.join('; ')}`);
}

async function testBadProse() {
  console.log('\n── Bad prose (should fail) ──');
  const result = await checkProse(BAD_PROSE, 'Chapter 1: The Opening');
  assert('Bad prose fails', !result.passed);
  if (!result.passed && result.violations.length > 0) {
    for (const v of result.violations) {
      console.log(`    Caught: ${v}`);
    }
    assert('Multiple violations detected', result.violations.length >= 3,
      `Found ${result.violations.length} (expected 3+)`);
  }
}

async function testFeedbackBuilders() {
  console.log('\n── Feedback builders ──');

  const violations: StatementViolation[] = [
    { index: 0, text: 'Same-day diagnostic confidence', rules: ['rule 12: stacked compound nouns'] },
    { index: 2, text: 'Your results: under 60 seconds', rules: ['rule 2: colon as stylistic device'] },
  ];

  const feedback = buildViolationFeedback(violations);
  assert('Statement feedback is non-empty', feedback.length > 0);
  assert('Statement feedback includes VOICE CHECK header', feedback.includes('VOICE CHECK VIOLATIONS'));
  assert('Statement feedback includes violation text', feedback.includes('Same-day diagnostic confidence'));
  assert('Statement feedback includes rule reference', feedback.includes('rule 12'));

  const proseFeedback = buildProseViolationFeedback(['metaphorical verb: unlocks', 'marketing buzzword: seamless']);
  assert('Prose feedback is non-empty', proseFeedback.length > 0);
  assert('Prose feedback includes violations', proseFeedback.includes('unlocks'));

  const emptyFeedback = buildViolationFeedback([]);
  assert('Empty violations returns empty string', emptyFeedback === '');
}

async function testPositiveChecksGood() {
  console.log('\n── Positive checks: good statements with priority context (should pass) ──');

  const goodWithPriority: StatementInput[] = [
    // Priority is broad, hook is specific — not tautological, addresses the priority
    {
      text: 'Support your hospital\'s financial health because cancer pathology testing can cost under $1 per slide',
      column: 'Tier 1',
      priorityText: 'Protecting the financial health of our hospital',
    },
    // Refined statement — priority is conceptually present (testing cost → financial health)
    {
      text: 'Cancer pathology testing costs under $1 per slide',
      column: 'Product',
      priorityText: 'Protecting the financial health of our hospital',
    },
    // Fast results → patient outcomes (conceptual alignment)
    {
      text: 'Slide results are available in under 60 seconds',
      column: 'Product',
      priorityText: 'Better outcomes for our cancer patients',
    },
    // Addresses compliance AND audit prep pain
    {
      text: 'You get exam-ready audit reports automatically',
      column: 'Product',
      priorityText: 'Proving compliance without drowning in audit prep',
    },
    // Focus column — no priority, P1/P2 should not apply
    {
      text: 'Community bank and credit union security is the entire focus of our company',
      column: 'Focus',
    },
  ];

  const result = await checkStatements(goodWithPriority);
  assert('Good statements with priority pass overall', result.passed,
    result.passed ? undefined : `${result.violations.length} violations found`);

  for (let i = 0; i < goodWithPriority.length; i++) {
    const violation = result.violations.find(v => v.index === i);
    assert(
      `[${i}] "${goodWithPriority[i].text.substring(0, 55)}..."`,
      !violation,
      violation ? `False positive: ${violation.rules.join(', ')}` : undefined,
    );
  }
}

async function testPrioritySubstitution() {
  console.log('\n── P1: Priority substitution (should FAIL) ──');

  const substitutions: StatementInput[] = [
    // Product metric substituted for audience priority
    {
      text: 'Low cost per test because AI runs on your existing lab equipment',
      column: 'Product',
      priorityText: 'Protecting the financial health of our hospital',
    },
    // Completely different concern
    {
      text: 'Fast processing speed for every pathology slide',
      column: 'Product',
      priorityText: 'Better outcomes for our cancer patients',
    },
    // Narrows the priority — drops "on budget"
    {
      text: 'Avoid project delays because AI monitors schedule variances',
      column: 'Product',
      priorityText: 'Keeping every project on schedule and on budget',
    },
  ];

  const result = await checkStatements(substitutions);
  assert('Priority substitutions fail overall', !result.passed);

  for (let i = 0; i < substitutions.length; i++) {
    const violation = result.violations.find(v => v.index === i);
    const hasP1 = violation?.rules.some(r => r.toLowerCase().includes('p1') || r.toLowerCase().includes('priority'));
    assert(
      `[${i}] "${substitutions[i].text.substring(0, 55)}..."`,
      !!violation,
      violation
        ? `Caught: ${violation.rules.join(', ')}${hasP1 ? '' : ' (but no P1 flag)'}`
        : 'False negative — evaluator missed priority substitution',
    );
  }
}

async function testTautology() {
  console.log('\n── P2: Tautology (should FAIL) ──');

  const tautological: StatementInput[] = [
    // Same concept: "low cost" and "under $1"
    {
      text: 'Low cost because testing costs under $1 per slide',
      column: 'Product',
      priorityText: 'Low cost',
    },
    // Same concept: "speed" and "60 seconds"
    {
      text: 'Speed of results because answers come in under 60 seconds',
      column: 'Product',
      priorityText: 'Speed of results',
    },
    // Same concept: "accurate" and "fewer false negatives"
    {
      text: 'Accurate testing because there are 40% fewer false negatives',
      column: 'Product',
      priorityText: 'Accurate testing',
    },
  ];

  const result = await checkStatements(tautological);
  assert('Tautological statements fail overall', !result.passed);

  for (let i = 0; i < tautological.length; i++) {
    const violation = result.violations.find(v => v.index === i);
    const hasP2 = violation?.rules.some(r => r.toLowerCase().includes('p2') || r.toLowerCase().includes('tautolog'));
    assert(
      `[${i}] "${tautological[i].text.substring(0, 55)}..."`,
      !!violation,
      violation
        ? `Caught: ${violation.rules.join(', ')}${hasP2 ? '' : ' (but no P2/tautology flag)'}`
        : 'False negative — evaluator missed tautology',
    );
  }
}

async function testEdgeCases() {
  console.log('\n── Edge cases ──');

  // Single Focus statement (no priority)
  const single = await checkStatements([
    { text: 'Community bank and credit union security is the entire focus of our company', column: 'Focus' },
  ]);
  assert('Single Focus statement passes', single.passed);

  // Very short statement
  const short = await checkStatements([
    { text: 'We digitize every slide at 40x resolution', column: 'Product' },
  ]);
  assert('Short clean statement passes', short.passed);

  // Tier 1 with priority context (should pass — good alignment)
  const tier1 = await checkStatements([
    {
      text: 'Support your hospital\'s financial health because cancer pathology testing can cost under $1 per slide',
      column: 'Tier 1',
      priorityText: 'Protecting the financial health of our hospital',
    },
  ]);
  assert('Tier 1 with aligned priority passes', tier1.passed);
}

// ─── Main ────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(60));
  console.log('  Voice Check Test Suite');
  console.log('  Using Opus for evaluation (matching production)');
  console.log('='.repeat(60));

  try {
    await testGoodStatements();
    await testBadStatements();
    await testGoodProse();
    await testBadProse();
    await testFeedbackBuilders();
    await testPositiveChecksGood();
    await testPrioritySubstitution();
    await testTautology();
    await testEdgeCases();
  } catch (err) {
    console.error('\nFATAL ERROR:', err);
    process.exit(1);
  }

  console.log('\n' + '='.repeat(60));
  console.log(`  Results: ${passed}/${total} passed, ${failed} failed`);
  if (failed === 0) {
    console.log('  ALL TESTS PASSED');
  } else {
    console.log(`  ${failed} FAILURES — review above`);
  }
  console.log('='.repeat(60) + '\n');

  process.exit(failed > 0 ? 1 : 0);
}

main();
