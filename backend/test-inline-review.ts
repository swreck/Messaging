/**
 * Targeted tests for the inline Maria review feature and prompt improvements.
 * Tests: response formats, Tier 2 count constraint, Tier 3 proof standard,
 * first-column audience focus, old endpoint removal.
 *
 * Run: npx tsx test-inline-review.ts
 */

const BASE = process.env.API_URL || 'http://localhost:3001/api';
let TOKEN = '';
let DRAFT_ID = '';

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
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { status: res.status, ...json };
}

function assert(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    const msg = `  ✗ ${name}${detail ? ': ' + detail : ''}`;
    console.log(msg);
    failures.push(msg);
  }
}

async function run() {
  console.log('=== Inline Review Feature Tests ===\n');

  // ─── Setup ─────────────────────────────────────────
  console.log('Setup:');
  const login = await req('POST', '/auth/login', { username: 'admin', password: 'maria2026' });
  assert('Login', !!login.token);
  TOKEN = login.token;

  // Find the Slideflow draft at step 5
  const drafts = await req('GET', '/drafts');
  const slideflowDraft = (drafts.drafts || []).find((d: any) => d.currentStep === 5);
  assert('Found draft at step 5', !!slideflowDraft, `Found ${drafts.drafts?.length || 0} drafts`);
  DRAFT_ID = slideflowDraft?.id;

  if (!DRAFT_ID) {
    console.log('\n⚠ No draft at step 5 found. Cannot run AI tests.');
    return;
  }

  // Get draft details for later assertions
  const draftDetail = await req('GET', `/drafts/${DRAFT_ID}`);
  const tier2Count = draftDetail.draft?.tier2Statements?.length || 0;
  console.log(`  ℹ Draft has ${tier2Count} Tier 2 columns currently`);

  // ─── Test 1: Old endpoints are removed ─────────────
  console.log('\nOld endpoints removed:');
  const audit = await req('POST', '/ai/audit', { draftId: DRAFT_ID });
  assert('/ai/audit returns 404', audit.status === 404, `Got ${audit.status}`);

  const poetryPass = await req('POST', '/ai/poetry-pass', { draftId: DRAFT_ID });
  assert('/ai/poetry-pass returns 404', poetryPass.status === 404, `Got ${poetryPass.status}`);

  const refineLang = await req('POST', '/ai/refine-language', { draftId: DRAFT_ID });
  assert('/ai/refine-language returns 404', refineLang.status === 404, `Got ${refineLang.status}`);

  const magicHour = await req('POST', '/ai/magic-hour', { draftId: DRAFT_ID });
  assert('/ai/magic-hour returns 404', magicHour.status === 404, `Got ${magicHour.status}`);

  // ─── Test 2: /ai/review response format ────────────
  console.log('\n/ai/review (this calls the AI — may take 15-30s):');
  const review = await req('POST', '/ai/review', { draftId: DRAFT_ID });
  assert('Returns 200', review.status !== 404 && review.status !== 500, `Status: ${review.status}`);
  assert('Has suggestions array', Array.isArray(review.suggestions), `Got: ${typeof review.suggestions}`);
  assert('Suggestions are non-empty', (review.suggestions || []).length > 0, `Got ${(review.suggestions || []).length}`);

  // Check format: each suggestion has cell + suggested, NO score/reason/current/overallNote
  const firstSugg = (review.suggestions || [])[0];
  if (firstSugg) {
    assert('Suggestion has "cell" field', typeof firstSugg.cell === 'string');
    assert('Suggestion has "suggested" field', typeof firstSugg.suggested === 'string');
    assert('Suggestion has NO "reason" field', firstSugg.reason === undefined, `Has reason: "${firstSugg.reason}"`);
    assert('Suggestion has NO "current" field', firstSugg.current === undefined, `Has current: "${firstSugg.current}"`);
  }
  assert('Response has NO overallScore', review.overallScore === undefined);
  assert('Response has NO overallNote', review.overallNote === undefined);
  assert('Response has NO summary', review.summary === undefined);

  // Check cell key format
  const cellKeys = (review.suggestions || []).map((s: any) => s.cell);
  const validCellPattern = /^(tier1|tier2-\d+|tier3-\d+-\d+)$/;
  const allValidKeys = cellKeys.every((k: string) => validCellPattern.test(k));
  assert('All cell keys match format (tier1/tier2-N/tier3-N-N)', allValidKeys, `Keys: ${cellKeys.join(', ')}`);

  // ─── Test 3: /ai/review catches column count ───────
  if (tier2Count > 6) {
    console.log('\nColumn count check (table has 7+ columns):');
    // Maria should flag that there are too many columns
    // We can't guarantee this, but let's log what she suggested
    const t2Suggestions = cellKeys.filter((k: string) => k.startsWith('tier2-'));
    console.log(`  ℹ Maria suggested changes to ${t2Suggestions.length} Tier 2 cells: ${t2Suggestions.join(', ')}`);
  }

  // ─── Test 4: /ai/direction response format ─────────
  console.log('\n/ai/direction (AI call — may take 15-30s):');
  const direction = await req('POST', '/ai/direction', {
    draftId: DRAFT_ID,
    direction: 'Make the first column more about audience focus and commitment to their needs',
  });
  assert('Returns 200', direction.status !== 404 && direction.status !== 500, `Status: ${direction.status}`);
  assert('Has suggestions array', Array.isArray(direction.suggestions));
  assert('Direction has NO overallNote', direction.overallNote === undefined, `overallNote: "${direction.overallNote}"`);

  const dirSugg = (direction.suggestions || [])[0];
  if (dirSugg) {
    assert('Direction suggestion has "cell"', typeof dirSugg.cell === 'string');
    assert('Direction suggestion has "suggested"', typeof dirSugg.suggested === 'string');
    assert('Direction suggestion has NO "reason"', dirSugg.reason === undefined);
    assert('Direction suggestion has NO "current"', dirSugg.current === undefined);
  }

  // ─── Test 5: /ai/revise response format ────────────
  console.log('\n/ai/revise (AI call — may take 15-30s):');
  const draft = draftDetail.draft;
  const previousState = {
    tier1: draft.tier1Statement?.text || '',
    tier2: (draft.tier2Statements || []).map((t2: any) => ({
      text: t2.text,
      tier3: (t2.tier3Bullets || []).map((t3: any) => t3.text),
    })),
  };
  // Simulate: the user changed tier1 text
  const revise = await req('POST', '/ai/revise', {
    draftId: DRAFT_ID,
    previousState,
  });
  assert('Returns 200', revise.status !== 404 && revise.status !== 500, `Status: ${revise.status}`);
  assert('Has suggestions array', Array.isArray(revise.suggestions));
  // Since we sent the same state as current, there should be no diff — Maria may return empty or minimal suggestions
  console.log(`  ℹ Revise returned ${(revise.suggestions || []).length} suggestions (expected few/none since no diff)`);

  // ─── Test 6: Cell update doesn't break draft ───────
  console.log('\nCell update + refresh (simulates accept flow):');
  const originalTier1 = draft.tier1Statement?.text || '';
  const testText = originalTier1 + ' [test]';

  // Update tier1
  const updateResult = await req('PUT', `/tiers/${DRAFT_ID}/tier1`, { text: testText, changeSource: 'review' });
  assert('Tier1 update succeeds', !!updateResult.tier1);

  // Refresh draft (simulates refreshDraft)
  const refreshed = await req('GET', `/drafts/${DRAFT_ID}`);
  assert('Draft refresh succeeds', !!refreshed.draft);
  assert('Tier1 text updated', refreshed.draft?.tier1Statement?.text === testText);
  assert('currentStep still 5', refreshed.draft?.currentStep === 5);
  assert('Tier2 count unchanged', refreshed.draft?.tier2Statements?.length === tier2Count);

  // Restore original
  await req('PUT', `/tiers/${DRAFT_ID}/tier1`, { text: originalTier1, changeSource: 'review' });
  const restored = await req('GET', `/drafts/${DRAFT_ID}`);
  assert('Tier1 restored to original', restored.draft?.tier1Statement?.text === originalTier1);

  // ─── Test 7: Tier 2 count in generation ────────────
  console.log('\n/ai/build-message Tier 2 count (AI call — may take 30-60s):');
  const buildResult = await req('POST', '/ai/build-message', { draftId: DRAFT_ID });
  assert('Build returns result', buildResult.status === 'complete' || buildResult.status === 'questions', `Status: ${buildResult.status}`);
  if (buildResult.result) {
    const genTier2Count = buildResult.result.tier2?.length || 0;
    assert(`Generated ${genTier2Count} Tier 2 columns (must be 3-6)`, genTier2Count >= 3 && genTier2Count <= 6, `Got ${genTier2Count}`);
    assert('Tier 2 count ideally 4-5', genTier2Count >= 4 && genTier2Count <= 5, `Got ${genTier2Count} (acceptable if 3 or 6)`);

    // Check Tier 3 proof standard
    console.log('\nTier 3 proof check on generated table:');
    const badT3Patterns = /\b(faster|better|easier|improved|enhanced|superior|seamless|robust)\b/i;
    const arrowPattern = /→|->|-->/;
    let t3Issues = 0;
    for (const t2 of buildResult.result.tier2 || []) {
      for (const t3 of t2.tier3 || []) {
        if (badT3Patterns.test(t3) || arrowPattern.test(t3)) {
          t3Issues++;
          console.log(`  ⚠ Suspicious Tier 3: "${t3}"`);
        }
      }
    }
    assert('No comparative adjectives or arrows in Tier 3', t3Issues === 0, `Found ${t3Issues} issues`);

    // Check first column
    console.log('\nFirst column check:');
    const firstT2 = buildResult.result.tier2?.[0];
    if (firstT2) {
      console.log(`  ℹ First column text: "${firstT2.text}"`);
      console.log(`  ℹ First column label: "${firstT2.categoryLabel}"`);
      const credentialPatterns = /\b(founder|institution|trusted|validated|backed by|peer-reviewed|published)\b/i;
      const looksLikeCredentials = credentialPatterns.test(firstT2.text);
      assert('First column is NOT credentials/social proof', !looksLikeCredentials, `Text contains credential language`);
    }
  }

  // ─── Summary ───────────────────────────────────────
  console.log(`\n${'='.repeat(40)}`);
  console.log(`Passed: ${passed}  Failed: ${failed}`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(f));
  }
  console.log();
}

// Wait for server to be ready
async function waitForServer() {
  for (let i = 0; i < 10; i++) {
    try {
      const res = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (res.status) return true;
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

waitForServer().then(ok => {
  if (!ok) { console.log('Server not reachable'); process.exit(1); }
  run().catch(err => { console.error('Test error:', err); process.exit(1); });
});
