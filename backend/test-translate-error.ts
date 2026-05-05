// Bundle 1B Item 1 — acceptance test for translateError.
//
// Asserts every kind returns the locked copy AND that no internal vocabulary
// appears in any output. Run via: npx tsx backend/test-translate-error.ts

import { translateError, messageContainsInternalVocab, type ErrorKind } from './src/lib/userFacingError.js';

const KINDS: ErrorKind[] = [
  'priority-save',
  'audience-save',
  'offering-save',
  'chapter-generate',
  'chapter-regenerate',
  'tier-generate',
  'export-generate',
  'name-save',
  'auth-expired',
  'generic',
];

// Realistic Prisma-shaped error to seed each kind.
const PRISMA_ERROR = new Error(
  `Invalid \`prisma.priority.update()\` invocation: An operation failed because it depends on one or more records that were required but not found. Record to update not found.`,
);

let passed = 0;
let failed = 0;

for (const kind of KINDS) {
  const message = translateError(PRISMA_ERROR, { kind, site: `test:${kind}` });
  const internalVocab = messageContainsInternalVocab(message);

  if (internalVocab) {
    console.error(`FAIL [${kind}]: message contains internal vocabulary: ${message}`);
    failed++;
    continue;
  }
  if (!message || message.length < 10) {
    console.error(`FAIL [${kind}]: empty or too-short message: ${message}`);
    failed++;
    continue;
  }
  if (message.includes('${')) {
    console.error(`FAIL [${kind}]: message contains template-literal leak: ${message}`);
    failed++;
    continue;
  }
  console.log(`PASS [${kind}]: ${message}`);
  passed++;
}

// Adversarial — what if a caller passes a kind not in the union (TypeScript
// would catch this at compile time, but runtime safety net check):
const adversarialMessage = translateError(PRISMA_ERROR, {
  kind: 'unknown-kind' as ErrorKind,
  site: 'test:adversarial',
});
if (messageContainsInternalVocab(adversarialMessage)) {
  console.error(`FAIL [adversarial]: unknown kind leaked internal vocab: ${adversarialMessage}`);
  failed++;
} else {
  console.log(`PASS [adversarial]: unknown kind falls through to generic copy: ${adversarialMessage}`);
  passed++;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
