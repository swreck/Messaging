/**
 * Interpretation helpers unit-test — Bundle 1A rev6 Phase 1.F
 *
 * Tests getInterpretationMode and getInterpretationVerbatimAsk against:
 * - Canonical (rev6+) shape: explicit mode/verbatimAsk fields
 * - Legacy rev5 shape: autonomousMode boolean + verbatim_ask snake_case
 * - Legacy guided-old shape: guided=true + cta field
 * - Defensive: empty / null / undefined
 *
 * Run: npx tsx test-interpretation-helpers.ts
 */

import {
  getInterpretationMode,
  getInterpretationVerbatimAsk,
} from './src/lib/expressExtraction.js';

interface TestCase<T> {
  label: string;
  input: any;
  expected: T;
}

function assert<T>(cases: TestCase<T>[], fn: (input: any) => T, name: string): void {
  console.log(`\n═══ ${name} ═══`);
  let pass = 0;
  let fail = 0;
  for (const c of cases) {
    const actual = fn(c.input);
    const ok = actual === c.expected;
    console.log(`  ${ok ? '✓' : '✗'} ${c.label}${ok ? '' : ` — expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(actual)}`}`);
    if (ok) pass++;
    else fail++;
  }
  console.log(`  ${pass}/${cases.length} passed${fail > 0 ? ` (${fail} FAILED)` : ''}`);
}

const modeCases: TestCase<'autonomous' | 'guided'>[] = [
  { label: 'canonical mode=autonomous', input: { mode: 'autonomous' }, expected: 'autonomous' },
  { label: 'canonical mode=guided', input: { mode: 'guided' }, expected: 'guided' },
  { label: 'legacy rev2-5 autonomousMode=true', input: { autonomousMode: true }, expected: 'autonomous' },
  { label: 'legacy guided-old guided=true', input: { guided: true }, expected: 'guided' },
  { label: 'canonical wins over legacy autonomousMode', input: { mode: 'guided', autonomousMode: true }, expected: 'guided' },
  { label: 'empty object → guided default', input: {}, expected: 'guided' },
  { label: 'null → guided default', input: null, expected: 'guided' },
  { label: 'undefined → guided default', input: undefined, expected: 'guided' },
  { label: 'random string → guided default', input: 'not-an-object', expected: 'guided' },
  { label: 'autonomousMode=false → guided default', input: { autonomousMode: false }, expected: 'guided' },
];

const verbatimAskCases: TestCase<string>[] = [
  { label: 'canonical verbatimAsk', input: { verbatimAsk: 'confirm by Friday' }, expected: 'confirm by Friday' },
  { label: 'canonical verbatimAsk trimmed', input: { verbatimAsk: '  confirm by Friday  ' }, expected: 'confirm by Friday' },
  { label: 'legacy rev5 verbatim_ask snake_case', input: { verbatim_ask: 'reply with availability' }, expected: 'reply with availability' },
  { label: 'legacy rev5 verbatim_ask trimmed', input: { verbatim_ask: '  reply with availability  ' }, expected: 'reply with availability' },
  { label: 'legacy guided-old cta', input: { cta: 'schedule a demo' }, expected: 'schedule a demo' },
  { label: 'legacy guided-old cta trimmed', input: { cta: '  schedule a demo  ' }, expected: 'schedule a demo' },
  { label: 'canonical wins over rev5 snake_case', input: { verbatimAsk: 'CANON', verbatim_ask: 'rev5' }, expected: 'CANON' },
  { label: 'rev5 wins over guided-old cta', input: { verbatim_ask: 'rev5', cta: 'guided-old' }, expected: 'rev5' },
  { label: 'empty object → empty string', input: {}, expected: '' },
  { label: 'null → empty string', input: null, expected: '' },
  { label: 'undefined → empty string', input: undefined, expected: '' },
  { label: 'empty verbatimAsk falls through to verbatim_ask', input: { verbatimAsk: '', verbatim_ask: 'fallback' }, expected: 'fallback' },
  { label: 'empty verbatim_ask falls through to cta', input: { verbatim_ask: '', cta: 'fallback' }, expected: 'fallback' },
  { label: 'whitespace-only verbatimAsk falls through', input: { verbatimAsk: '   ', verbatim_ask: 'fallback' }, expected: 'fallback' },
];

assert(modeCases, getInterpretationMode, 'getInterpretationMode');
assert(verbatimAskCases, getInterpretationVerbatimAsk, 'getInterpretationVerbatimAsk');
console.log('\nDone.');
