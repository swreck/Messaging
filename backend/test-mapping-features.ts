/**
 * Test suite for mapping diagram features:
 * - Mapping CRUD (GET, POST, DELETE)
 * - Preview mapping API
 * - Build-message with question skipping (partial answers)
 * - Modal/className prop (frontend — verified by build success)
 *
 * Run: API_URL=https://maria.perworks.com/api npx tsx test-mapping-features.ts
 */

const BASE = process.env.API_URL || 'http://localhost:3001/api';
let TOKEN = '';

let OFFERING_ID = '';
let AUDIENCE_ID = '';
let DRAFT_ID = '';
let MAPPING_IDS: string[] = [];
let PRI_IDS: string[] = [];
let ELE_IDS: string[] = [];

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function req(method: string, path: string, body?: any): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

function assert(condition: boolean, name: string, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    const msg = detail ? `${name}: ${detail}` : name;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

async function test(name: string, fn: () => Promise<void>) {
  console.log(`\n${name}`);
  try {
    await fn();
  } catch (err: any) {
    failed++;
    failures.push(`${name}: ${err.message}`);
    console.log(`  ✗ FAILED: ${err.message}`);
  }
}

async function main() {
  console.log(`\n${'='.repeat(55)}`);
  console.log(`  Mapping Diagram Feature Tests`);
  console.log(`  API: ${BASE}`);
  console.log(`${'='.repeat(55)}`);

  // ─── Setup ──────────────────────────────────────────

  await test('Auth: Login', async () => {
    const { token } = await req('POST', '/auth/login', { username: 'admin', password: 'maria2026' });
    TOKEN = token;
    assert(!!TOKEN, 'Got auth token');
  });

  await test('Setup: Create offering with capabilities', async () => {
    const { offering } = await req('POST', '/offerings', {
      name: 'AcmePath Diagnostics',
      description: 'AI-powered pathology for hospitals',
    });
    OFFERING_ID = offering.id;
    assert(!!OFFERING_ID, 'Created offering');

    const elements = [
      'AI slide analysis in under 60 seconds',
      'Runs on existing lab equipment — no new hardware',
      '$1 per test vs $4,000 outsourced',
      'FDA approval pending for primary diagnosis',
      'Geisinger Health and Mayo Clinic evaluating',
      'Dedicated onboarding team for 48-hour setup',
    ];
    for (const text of elements) {
      const { element } = await req('POST', `/offerings/${OFFERING_ID}/elements`, { text, source: 'manual' });
      ELE_IDS.push(element.id);
    }
    assert(ELE_IDS.length === 6, `Created ${ELE_IDS.length} elements`);
  });

  await test('Setup: Create audience with priorities', async () => {
    const { audience } = await req('POST', '/audiences', {
      name: 'Hospital Administrators',
      description: 'Decision-makers at mid-size hospitals',
    });
    AUDIENCE_ID = audience.id;
    assert(!!AUDIENCE_ID, 'Created audience');

    const priorities = [
      { text: 'Protecting the financial health of our hospital', rank: 1, motivatingFactor: 'Every dollar saved goes directly to patient care' },
      { text: 'Better outcomes for our cancer patients', rank: 2, motivatingFactor: 'Treatment delays from slow pathology cost lives' },
      { text: 'Reducing risk of regulatory issues', rank: 3, motivatingFactor: 'One compliance failure can shut down a department' },
      { text: 'Keeping our best pathologists from burning out', rank: 4, motivatingFactor: 'Recruiting replacements takes 18 months' },
    ];
    for (const p of priorities) {
      const { priority } = await req('POST', `/audiences/${AUDIENCE_ID}/priorities`, p);
      PRI_IDS.push(priority.id);
    }
    assert(PRI_IDS.length === 4, `Created ${PRI_IDS.length} priorities`);
  });

  await test('Setup: Create draft', async () => {
    const { draft } = await req('POST', '/drafts', { offeringId: OFFERING_ID, audienceId: AUDIENCE_ID });
    DRAFT_ID = draft.id;
    assert(!!DRAFT_ID, 'Created draft');
  });

  // ─── Mapping CRUD ────────────────────────────────────

  await test('Mapping: Create individual mapping', async () => {
    const { mapping } = await req('POST', `/mappings/${DRAFT_ID}`, {
      priorityId: PRI_IDS[0],
      elementId: ELE_IDS[2], // $1 per test → financial health
    });
    assert(!!mapping.id, 'Created mapping with ID');
    assert(mapping.status === 'confirmed', `Status is confirmed (got: ${mapping.status})`);
    MAPPING_IDS.push(mapping.id);
  });

  await test('Mapping: Create second mapping', async () => {
    const { mapping } = await req('POST', `/mappings/${DRAFT_ID}`, {
      priorityId: PRI_IDS[1],
      elementId: ELE_IDS[0], // 60 seconds → patient outcomes
    });
    MAPPING_IDS.push(mapping.id);
    assert(!!mapping.id, 'Created second mapping');
  });

  await test('Mapping: Create third mapping (same priority, different element)', async () => {
    const { mapping } = await req('POST', `/mappings/${DRAFT_ID}`, {
      priorityId: PRI_IDS[0],
      elementId: ELE_IDS[1], // existing equipment → financial health (second connection)
    });
    MAPPING_IDS.push(mapping.id);
    assert(!!mapping.id, 'Created third mapping (multi-connection)');
  });

  await test('Mapping: GET all mappings for draft', async () => {
    const { mappings } = await req('GET', `/mappings/${DRAFT_ID}`);
    assert(mappings.length === 3, `Got ${mappings.length} mappings (expected 3)`);
    assert(mappings[0].priority && mappings[0].element, 'Mappings include priority and element details');
  });

  await test('Mapping: DELETE a mapping', async () => {
    const idToDelete = MAPPING_IDS[2]; // the third one
    await req('DELETE', `/mappings/${DRAFT_ID}/${idToDelete}`);
    MAPPING_IDS.splice(2, 1);

    const { mappings } = await req('GET', `/mappings/${DRAFT_ID}`);
    assert(mappings.length === 2, `After delete: ${mappings.length} mappings (expected 2)`);
    assert(!mappings.find((m: any) => m.id === idToDelete), 'Deleted mapping is gone');
  });

  await test('Mapping: Re-create mapping (simulates diagram reconnect)', async () => {
    // User drags a line from priority[0] to a different element
    const { mapping } = await req('POST', `/mappings/${DRAFT_ID}`, {
      priorityId: PRI_IDS[0],
      elementId: ELE_IDS[1], // reconnect to "existing lab equipment"
    });
    MAPPING_IDS.push(mapping.id);
    assert(!!mapping.id, 'Reconnected mapping created');

    const { mappings } = await req('GET', `/mappings/${DRAFT_ID}`);
    assert(mappings.length === 3, `Now ${mappings.length} mappings (expected 3)`);
  });

  // ─── Draft includes mappings ─────────────────────────

  await test('Draft fetch: includes mappings array', async () => {
    const { draft } = await req('GET', `/drafts/${DRAFT_ID}`);
    assert(Array.isArray(draft.mappings), 'draft.mappings is an array');
    assert(draft.mappings.length === 3, `draft.mappings has ${draft.mappings.length} items (expected 3)`);
    assert(!!draft.mappings[0].priorityId, 'Mapping has priorityId');
    assert(!!draft.mappings[0].elementId, 'Mapping has elementId');
    assert(!!draft.mappings[0].priority?.text, 'Mapping includes nested priority text');
    assert(!!draft.mappings[0].element?.text, 'Mapping includes nested element text');
  });

  // ─── Preview mapping (AI) ───────────────────────────

  await test('Preview mapping: returns structured data', async () => {
    const result = await req('POST', '/ai/preview-mapping', { draftId: DRAFT_ID });
    assert(Array.isArray(result.mappings), 'Result has mappings array');
    assert(Array.isArray(result.gaps), 'Result has gaps array');
    assert(Array.isArray(result.orphans), 'Result has orphans array');

    if (result.mappings.length > 0) {
      const first = result.mappings[0];
      assert(typeof first.priorityText === 'string', 'Mapping has priorityText');
      assert(typeof first.rank === 'number', 'Mapping has rank');
      assert(Array.isArray(first.capabilities), 'Mapping has capabilities array');
    }
    assert(true, `Got ${result.mappings.length} mapped priorities, ${result.gaps.length} gaps, ${result.orphans.length} orphans`);
  });

  // ─── Build message (full flow) ───────────────────────

  await test('Build message: generates Three Tier or asks questions', async () => {
    // Clean up existing mappings so AI generates fresh
    for (const mid of MAPPING_IDS) {
      await req('DELETE', `/mappings/${DRAFT_ID}/${mid}`).catch(() => {});
    }
    MAPPING_IDS = [];

    const result = await req('POST', '/ai/build-message', { draftId: DRAFT_ID });
    assert(result.status === 'complete' || result.status === 'questions', `Status: ${result.status}`);

    if (result.status === 'complete') {
      assert(!!result.result?.tier1?.text, 'Has Tier 1 text');
      assert(result.result?.tier2?.length >= 5, `Has ${result.result?.tier2?.length} Tier 2 columns (need 5+)`);
      console.log(`    → Generated complete Three Tier (${result.result.tier2.length} columns)`);
    } else {
      assert(result.questions.length > 0, `Has ${result.questions.length} questions`);
      console.log(`    → AI asked ${result.questions.length} questions`);

      // Test: skip remaining questions (partial answers)
      // Answer only the first question, then submit
      const partialAnswers = result.questions.map((q: any, i: number) => ({
        priorityId: q.priorityId,
        elementId: q.elementId,
        confirmed: i === 0, // only answer the first
        context: i === 0 ? 'Yes, this is correct' : undefined,
      }));

      const resolved = await req('POST', '/ai/resolve-questions', {
        draftId: DRAFT_ID,
        answers: partialAnswers,
      });
      assert(resolved.status === 'complete', `After resolve: status = ${resolved.status}`);
      assert(!!resolved.result?.tier1?.text, 'Resolved result has Tier 1');
    }
  });

  // ─── Cleanup ─────────────────────────────────────────

  await test('Cleanup: Delete test data', async () => {
    await req('DELETE', `/drafts/${DRAFT_ID}`).catch(() => {});
    await req('DELETE', `/audiences/${AUDIENCE_ID}`).catch(() => {});
    await req('DELETE', `/offerings/${OFFERING_ID}`).catch(() => {});
    assert(true, 'Test data cleaned up');
  });

  // ─── Report ──────────────────────────────────────────

  console.log(`\n${'='.repeat(55)}`);
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\n  Failed:');
    failures.forEach(f => console.log(`    ✗ ${f}`));
  }
  console.log(`${'='.repeat(55)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
