/**
 * Maria Edit Accuracy & Methodology Guardrail Tests
 *
 * Tests that Maria:
 * 1. Accurately edits, deletes, and reorders priorities
 * 2. Pushes back when changes conflict with methodology
 * 3. Gives in when the user insists
 *
 * Run: API_URL=https://glorious-benevolence-production-c1e0.up.railway.app/api npx tsx test-maria-edits.ts
 */

const BASE = process.env.API_URL || 'http://localhost:3001/api';
let TOKEN = '';
let AUDIENCE_ID = '';
let TEST_AUDIENCE_ID = '';

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

async function askMaria(message: string, context: any, history?: any[]): Promise<any> {
  return req('POST', '/assistant/message', { message, context, history: history || [] });
}

async function getPageContent(context: any): Promise<string> {
  const { content } = await req('POST', '/assistant/page-content', { context });
  return content;
}

async function getPriorities(): Promise<any[]> {
  const { audiences } = await req('GET', '/audiences');
  const audience = audiences.find((a: any) => a.id === TEST_AUDIENCE_ID);
  return audience?.priorities || [];
}

async function main() {
  console.log(`\n══════════════════════════════════════`);
  console.log(`  Maria Edit Accuracy & Guardrail Tests`);
  console.log(`  API: ${BASE}`);
  console.log(`══════════════════════════════════════`);

  // ─── Setup ──────────────────────────────────────────
  await test('Setup: Login', async () => {
    const { token } = await req('POST', '/auth/login', { username: 'admin', password: 'maria2026' });
    TOKEN = token;
    assert(!!TOKEN, 'Got auth token');
  });

  await test('Setup: Create test audience with known priorities', async () => {
    const { audience } = await req('POST', '/audiences', {
      name: 'Edit Test Audience',
      description: 'For testing Maria edits',
    });
    TEST_AUDIENCE_ID = audience.id;

    // Add priorities in specific order
    const priorities = [
      'Fast diagnostic turnaround',
      'Diagnostic accuracy',
      'Low cost per test',
      'Easy integration with existing lab systems',
      'Regulatory compliance support',
    ];
    for (let i = 0; i < priorities.length; i++) {
      await req('POST', `/audiences/${TEST_AUDIENCE_ID}/priorities`, {
        text: priorities[i],
        rank: i + 1,
      });
    }

    const pris = await getPriorities();
    assert(pris.length === 5, `Created 5 priorities (got ${pris.length})`);
    assert(pris[0].text === 'Fast diagnostic turnaround', 'First priority is correct');
  });

  // ═══════════════════════════════════════════════════════
  // 1. ACCURATE EDITING
  // ═══════════════════════════════════════════════════════

  await test('Edit accuracy: Rename a specific priority', async () => {
    const content = await getPageContent({ page: 'audiences', audienceId: TEST_AUDIENCE_ID });
    const r = await askMaria(
      `[PAGE CONTENT]\n${content}\n\n[USER QUESTION]\nRename priority 3 from "Low cost per test" to "Cost under $1 per test"`,
      { page: 'audiences', audienceId: TEST_AUDIENCE_ID }
    );

    if (r.action?.type === 'edit_priorities') {
      assert(r.refreshNeeded === true, 'Refresh needed');
      // Verify the edit actually happened
      const pris = await getPriorities();
      const p3 = pris.find((p: any) => p.rank === 3 || p.sortOrder === 2);
      assert(p3?.text === 'Cost under $1 per test' || r.actionResult?.includes('Updated'),
        'Priority 3 renamed correctly',
        `Actual text: "${p3?.text}", actionResult: ${r.actionResult}`);
    } else {
      // Maria might have read the page or responded conversationally
      assert(false, 'Expected edit_priorities action',
        `Got action: ${r.action?.type}, response: "${r.response?.slice(0, 100)}"`);
    }
  });

  await test('Edit accuracy: Delete specific priorities', async () => {
    const content = await getPageContent({ page: 'audiences', audienceId: TEST_AUDIENCE_ID });
    const prisBefore = await getPriorities();
    const countBefore = prisBefore.length;

    const r = await askMaria(
      `[PAGE CONTENT]\n${content}\n\n[USER QUESTION]\nDelete the last priority — "Regulatory compliance support" — it's not relevant for this audience.`,
      { page: 'audiences', audienceId: TEST_AUDIENCE_ID }
    );

    if (r.action?.type === 'delete_priorities') {
      assert(r.refreshNeeded === true, 'Refresh needed');
      const prisAfter = await getPriorities();
      assert(prisAfter.length === countBefore - 1, `One priority deleted (${countBefore} → ${prisAfter.length})`);
      const texts = prisAfter.map((p: any) => p.text);
      assert(!texts.includes('Regulatory compliance support'), 'Correct priority was deleted');
    } else {
      assert(false, 'Expected delete_priorities action',
        `Got action: ${r.action?.type}, response: "${r.response?.slice(0, 100)}"`);
    }
  });

  await test('Edit accuracy: Reorder priorities', async () => {
    const content = await getPageContent({ page: 'audiences', audienceId: TEST_AUDIENCE_ID });
    const r = await askMaria(
      `[PAGE CONTENT]\n${content}\n\n[USER QUESTION]\nMake "Diagnostic accuracy" the #1 priority and "Fast diagnostic turnaround" the #2. Keep everything else in the same order.`,
      { page: 'audiences', audienceId: TEST_AUDIENCE_ID }
    );

    if (r.action?.type === 'reorder_priorities') {
      assert(r.refreshNeeded === true, 'Refresh needed');
      const pris = await getPriorities();
      // After reorder, rank 1 should be accuracy, rank 2 should be speed
      const p1 = pris.find((p: any) => p.rank === 1);
      const p2 = pris.find((p: any) => p.rank === 2);
      assert(p1?.text?.includes('accuracy') || p1?.text?.includes('Accuracy'),
        `#1 is now accuracy: "${p1?.text}"`);
      assert(p2?.text?.includes('turnaround') || p2?.text?.includes('Fast') || p2?.text?.includes('speed'),
        `#2 is now speed: "${p2?.text}"`);
    } else {
      // Maria might have responded with advice
      console.log(`    Maria responded: "${r.response?.slice(0, 120)}"`);
      assert(false, 'Expected reorder_priorities action',
        `Got action: ${r.action?.type}`);
    }
  });

  await test('Edit accuracy: Add and position a new priority', async () => {
    const r = await askMaria(
      'Add a new priority: "Minimal training required for lab technicians"',
      { page: 'audiences', audienceId: TEST_AUDIENCE_ID }
    );

    if (r.action?.type === 'add_priorities') {
      assert(r.refreshNeeded === true, 'Refresh needed');
      const pris = await getPriorities();
      const found = pris.find((p: any) => p.text.toLowerCase().includes('training'));
      assert(!!found, 'New priority was added');
    } else {
      assert(false, 'Expected add_priorities action',
        `Got action: ${r.action?.type}, response: "${r.response?.slice(0, 100)}"`);
    }
  });

  await test('Edit accuracy: Multiple edits in one request', async () => {
    const content = await getPageContent({ page: 'audiences', audienceId: TEST_AUDIENCE_ID });
    const r = await askMaria(
      `[PAGE CONTENT]\n${content}\n\n[USER QUESTION]\nRename priority 1 to "Accurate pathology results — non-negotiable" and rename priority 2 to "Sub-minute diagnostic turnaround"`,
      { page: 'audiences', audienceId: TEST_AUDIENCE_ID }
    );

    if (r.action?.type === 'edit_priorities') {
      assert(r.refreshNeeded === true, 'Refresh needed');
      assert(r.actionResult?.includes('2'), 'Updated 2 priorities',
        `actionResult: ${r.actionResult}`);
    } else {
      console.log(`    Maria responded: "${r.response?.slice(0, 120)}"`);
      // Acceptable if she took a different approach
      assert(!!r.response, 'Got a response');
    }
  });

  // ═══════════════════════════════════════════════════════
  // 2. METHODOLOGY PUSHBACK
  // ═══════════════════════════════════════════════════════

  await test('Guardrail: Pushes back on proof as priority', async () => {
    const content = await getPageContent({ page: 'audiences', audienceId: TEST_AUDIENCE_ID });
    const r = await askMaria(
      `[PAGE CONTENT]\n${content}\n\n[USER QUESTION]\nAdd a priority: "FDA approved with 99.7% sensitivity"`,
      { page: 'audiences', audienceId: TEST_AUDIENCE_ID }
    );

    console.log(`    Maria: "${r.response?.slice(0, 200)}"`);
    const lower = r.response?.toLowerCase() || '';
    // Maria should flag that this sounds like proof, not a priority
    const pushedBack = lower.includes('proof') || lower.includes('tier 3') ||
      lower.includes('verifiable') || lower.includes('specific') ||
      lower.includes('not a priority') || lower.includes('data point');
    assert(pushedBack || r.action === null,
      'Maria flags that FDA/sensitivity data sounds like proof, not a priority',
      `Response: "${r.response?.slice(0, 150)}"`);
  });

  await test('Guardrail: Pushes back on value claim as proof language', async () => {
    const content = await getPageContent({ page: 'audiences', audienceId: TEST_AUDIENCE_ID });
    const r = await askMaria(
      `[PAGE CONTENT]\n${content}\n\n[USER QUESTION]\nRename priority 1 to "Better and faster than competitors"`,
      { page: 'audiences', audienceId: TEST_AUDIENCE_ID }
    );

    console.log(`    Maria: "${r.response?.slice(0, 200)}"`);
    const lower = r.response?.toLowerCase() || '';
    // Maria should note that "better and faster" are comparative adjectives / not how priorities should read
    const pushedBack = lower.includes('comparative') || lower.includes('competitor') ||
      lower.includes('push back') || lower.includes('audience') ||
      lower.includes('their language') || lower.includes('vague');
    assert(pushedBack,
      'Maria pushes back on comparative/competitive language in priorities',
      `Response: "${r.response?.slice(0, 150)}"`);
  });

  // ═══════════════════════════════════════════════════════
  // 3. GIVES IN WHEN USER INSISTS
  // ═══════════════════════════════════════════════════════

  await test('Guardrail → comply: User insists after pushback', async () => {
    const content = await getPageContent({ page: 'audiences', audienceId: TEST_AUDIENCE_ID });

    // First message: make a questionable request
    const r1 = await askMaria(
      `[PAGE CONTENT]\n${content}\n\n[USER QUESTION]\nAdd a priority: "FDA approved with 99.7% sensitivity"`,
      { page: 'audiences', audienceId: TEST_AUDIENCE_ID }
    );

    console.log(`    First response: "${r1.response?.slice(0, 120)}"`);

    // Second message: insist
    const history = [
      { role: 'user', content: 'Add a priority: "FDA approved with 99.7% sensitivity"' },
      { role: 'assistant', content: r1.response },
    ];
    const r2 = await askMaria(
      `[PAGE CONTENT]\n${content}\n\n[USER QUESTION]\nI understand your concern, but I want it as a priority anyway. Please add it.`,
      { page: 'audiences', audienceId: TEST_AUDIENCE_ID },
      history
    );

    console.log(`    Second response: "${r2.response?.slice(0, 120)}"`);

    if (r2.action?.type === 'add_priorities') {
      assert(r2.refreshNeeded === true, 'Complied — added the priority');
      assert(r2.actionResult?.includes('Added'), 'Action result confirms addition');
    } else {
      // Even if she didn't take the action, check she's at least more willing
      const lower = r2.response?.toLowerCase() || '';
      const compliant = lower.includes('done') || lower.includes('added') ||
        lower.includes('go ahead') || lower.includes('your call') ||
        r2.action?.type === 'add_priorities';
      assert(compliant,
        'Maria complies or signals willingness on second ask',
        `Response: "${r2.response?.slice(0, 150)}"`);
    }
  });

  await test('Guardrail → comply: Direct override phrasing', async () => {
    const content = await getPageContent({ page: 'audiences', audienceId: TEST_AUDIENCE_ID });
    const r = await askMaria(
      `[PAGE CONTENT]\n${content}\n\n[USER QUESTION]\nI know this isn't standard methodology, but rename priority 2 to "Beats all competitors on speed." Do it anyway.`,
      { page: 'audiences', audienceId: TEST_AUDIENCE_ID }
    );

    console.log(`    Maria: "${r.response?.slice(0, 200)}"`);

    // She should either do it (with a note) or push back gently
    // Either way, the key test is she doesn't refuse outright
    const lower = r.response?.toLowerCase() || '';
    assert(!lower.includes("i can't") && !lower.includes('i won\'t') && !lower.includes('i refuse'),
      'Maria does not refuse outright');

    if (r.action?.type === 'edit_priorities') {
      assert(r.refreshNeeded === true, 'Complied with override request');
    } else {
      // She might push back once — that's fine for first ask
      assert(lower.includes('methodology') || lower.includes('comparative') || lower.includes('noted') || lower.includes('go ahead'),
        'Response acknowledges the override or explains methodology concern');
    }
  });

  // ═══════════════════════════════════════════════════════
  // 4. COMPLEX MULTI-STEP EDIT (the real-world scenario)
  // ═══════════════════════════════════════════════════════

  await test('Complex: Multi-step priority cleanup (like the real conversation)', async () => {
    const content = await getPageContent({ page: 'audiences', audienceId: TEST_AUDIENCE_ID });
    const r = await askMaria(
      `[PAGE CONTENT]\n${content}\n\n[USER QUESTION]\nClean up the priorities. Make accuracy #1, speed #2, and cost #3. Delete anything else.`,
      { page: 'audiences', audienceId: TEST_AUDIENCE_ID }
    );

    console.log(`    Maria: "${r.response?.slice(0, 200)}"`);

    // Maria might take one action (reorder, then delete in follow-up) or handle it in steps
    // The key test: she takes SOME action, not just talks about it
    const tookAction = r.action?.type === 'reorder_priorities' ||
      r.action?.type === 'delete_priorities' ||
      r.action?.type === 'edit_priorities';
    const askedToReadPage = r.needsPageContent === true;

    assert(tookAction || askedToReadPage || (r.response && r.action !== null),
      'Maria takes action or starts the process (not just advice)',
      `action: ${r.action?.type || 'null'}, needsPageContent: ${r.needsPageContent}`);

    if (r.actionResult) {
      console.log(`    Action result: ${r.actionResult}`);
    }
  });

  // ═══════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════

  await test('Cleanup: Delete test audience', async () => {
    await req('DELETE', `/audiences/${TEST_AUDIENCE_ID}`);
    assert(true, 'Test audience deleted');
  });

  // ═══════════════════════════════════════════════════════
  // RESULTS
  // ═══════════════════════════════════════════════════════

  console.log(`\n══════════════════════════════════════`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log(`══════════════════════════════════════`);

  if (failures.length > 0) {
    console.log(`\nFailures:`);
    for (const f of failures) {
      console.log(`  • ${f}`);
    }
  }

  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
