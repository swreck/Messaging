// Boot-time guardrail — ensures TEST_MODE runs cannot reach the production
// database. Imported FIRST in index.ts, before any module that uses Prisma.
// In production (TEST_MODE unset) this is a no-op.

import 'dotenv/config';

if (process.env.TEST_MODE === 'true') {
  const testUrl = process.env.TEST_DATABASE_URL;
  const prodUrl = process.env.DATABASE_URL;

  if (!testUrl) {
    console.error(
      '\n[FATAL] TEST_MODE=true but TEST_DATABASE_URL is not set.\n' +
      'Failure-path tests must point at an isolated test database, not production.\n' +
      'Set TEST_DATABASE_URL in your .env to a Neon test branch or separate test project.\n'
    );
    process.exit(1);
  }

  function hostOf(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return '';
    }
  }

  const testHost = hostOf(testUrl);
  const prodHost = prodUrl ? hostOf(prodUrl) : '';

  if (!testHost) {
    console.error('\n[FATAL] TEST_DATABASE_URL is not a parseable URL.\n');
    process.exit(1);
  }

  if (prodHost && testHost === prodHost) {
    console.error(
      '\n[FATAL] TEST_DATABASE_URL and DATABASE_URL point to the same host.\n' +
      `  host: ${testHost}\n` +
      'Failure-path tests would write to production. Refusing to start.\n' +
      'Configure TEST_DATABASE_URL to a separate Neon project or branch.\n'
    );
    process.exit(1);
  }

  // Override DATABASE_URL so Prisma uses the test DB for the rest of the process.
  process.env.DATABASE_URL = testUrl;
  console.log(`[TEST_MODE] Using TEST_DATABASE_URL (host=${testHost}) — production DB unreachable.`);
}
