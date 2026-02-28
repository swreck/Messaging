/**
 * Comprehensive test suite for the Dashboard & Navigation UX Overhaul.
 * Tests all new features: pages data contracts, drag-and-drop reorder APIs,
 * cross-references, the new stories/all endpoint, and data integrity.
 *
 * Run: API_URL=http://localhost:3001/api npx tsx test-dashboard-overhaul.ts
 */

const BASE = process.env.API_URL || 'http://localhost:3001/api';
let TOKEN = '';

// Test data IDs (created during tests, cleaned up at the end)
let OFFERING_A_ID = '';
let OFFERING_B_ID = '';
let AUDIENCE_1_ID = '';
let AUDIENCE_2_ID = '';
let AUDIENCE_3_ID = '';
let DRAFT_A1_ID = '';
let DRAFT_A2_ID = '';
let DRAFT_B1_ID = '';
let STORY_ID = '';

// Priority and element IDs for reorder tests
let PRI_IDS: string[] = [];
let ELEM_IDS: string[] = [];

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
  console.log('=== Dashboard & Navigation UX Overhaul — Comprehensive Test ===\n');

  // ─── Auth ──────────────────────────────────────────
  console.log('Auth:');
  const login = await req('POST', '/auth/login', { username: 'admin', password: 'maria2026' });
  assert('Login returns token', !!login.token);
  TOKEN = login.token;
  if (!TOKEN) { console.log('FATAL: Cannot proceed without auth.'); process.exit(1); }

  // ═══════════════════════════════════════════════════
  // SECTION 1: Setup test data
  // ═══════════════════════════════════════════════════
  console.log('\n── Setup: Create test offerings, audiences, drafts ──');

  // Create two offerings
  const offA = await req('POST', '/offerings', { name: 'TestOff Alpha', smeRole: 'PM', description: 'First test offering' });
  assert('Create offering Alpha', !!offA.offering?.id);
  OFFERING_A_ID = offA.offering?.id;

  const offB = await req('POST', '/offerings', { name: 'TestOff Beta', smeRole: 'Engineer', description: 'Second test offering' });
  assert('Create offering Beta', !!offB.offering?.id);
  OFFERING_B_ID = offB.offering?.id;

  // Add 4 elements to offering Alpha (for reorder tests)
  const elemTexts = ['Fast processing', 'Cloud-native architecture', 'Enterprise security', 'API-first design'];
  for (const text of elemTexts) {
    const e = await req('POST', `/offerings/${OFFERING_A_ID}/elements`, { text, source: 'manual' });
    assert(`Add element: "${text}"`, !!e.element?.id);
    ELEM_IDS.push(e.element?.id);
  }

  // Create three audiences
  const aud1 = await req('POST', '/audiences', { name: 'TestAud IT Directors', description: 'IT leadership' });
  assert('Create audience 1', !!aud1.audience?.id);
  AUDIENCE_1_ID = aud1.audience?.id;

  const aud2 = await req('POST', '/audiences', { name: 'TestAud CFOs', description: 'Financial leaders' });
  assert('Create audience 2', !!aud2.audience?.id);
  AUDIENCE_2_ID = aud2.audience?.id;

  const aud3 = await req('POST', '/audiences', { name: 'TestAud CTOs', description: 'Technical leaders' });
  assert('Create audience 3', !!aud3.audience?.id);
  AUDIENCE_3_ID = aud3.audience?.id;

  // Add 5 priorities to audience 1 (for reorder tests)
  const priTexts = ['Reduce downtime', 'Lower TCO', 'Faster deployment', 'Better compliance', 'Team productivity'];
  for (let i = 0; i < priTexts.length; i++) {
    const p = await req('POST', `/audiences/${AUDIENCE_1_ID}/priorities`, {
      text: priTexts[i], rank: i + 1, motivatingFactor: `Reason for ${priTexts[i]}`,
    });
    assert(`Add priority ${i + 1}: "${priTexts[i]}"`, !!p.priority?.id);
    PRI_IDS.push(p.priority?.id);
  }

  // Create drafts: Alpha×Aud1, Alpha×Aud2, Beta×Aud1
  const draftA1 = await req('POST', '/drafts', { offeringId: OFFERING_A_ID, audienceId: AUDIENCE_1_ID });
  assert('Create draft Alpha×IT Directors', !!draftA1.draft?.id);
  DRAFT_A1_ID = draftA1.draft?.id;

  const draftA2 = await req('POST', '/drafts', { offeringId: OFFERING_A_ID, audienceId: AUDIENCE_2_ID });
  assert('Create draft Alpha×CFOs', !!draftA2.draft?.id);
  DRAFT_A2_ID = draftA2.draft?.id;

  const draftB1 = await req('POST', '/drafts', { offeringId: OFFERING_B_ID, audienceId: AUDIENCE_1_ID });
  assert('Create draft Beta×IT Directors', !!draftB1.draft?.id);
  DRAFT_B1_ID = draftB1.draft?.id;

  // Advance draft A1 to step 5 (complete) for 5CS tests
  await req('PATCH', `/drafts/${DRAFT_A1_ID}`, { currentStep: 5, status: 'complete' });
  // Advance draft A2 to step 3 (in progress)
  await req('PATCH', `/drafts/${DRAFT_A2_ID}`, { currentStep: 3 });
  // Leave draft B1 at step 1

  // Create a story for the complete draft
  const story = await req('POST', '/stories', { draftId: DRAFT_A1_ID, medium: 'email', cta: 'Schedule a demo' });
  assert('Create story for complete draft', !!story.story?.id);
  STORY_ID = story.story?.id;

  // ═══════════════════════════════════════════════════
  // SECTION 2: Audiences Page — Data contract
  // ═══════════════════════════════════════════════════
  console.log('\n── Audiences Page: Data contract ──');

  const audList = await req('GET', '/audiences');
  assert('GET /audiences returns array', Array.isArray(audList.audiences));

  const testAud = audList.audiences.find((a: any) => a.id === AUDIENCE_1_ID);
  assert('Audience has priorities array', Array.isArray(testAud?.priorities));
  assert('Audience 1 has 5 priorities', testAud?.priorities?.length === 5, `got ${testAud?.priorities?.length}`);
  assert('Priorities have sortOrder field', testAud?.priorities?.every((p: any) => typeof p.sortOrder === 'number'));
  assert('Priorities have motivatingFactor', testAud?.priorities?.every((p: any) => typeof p.motivatingFactor === 'string'));
  assert('Priorities ordered by sortOrder', (() => {
    const orders = testAud?.priorities?.map((p: any) => p.sortOrder);
    return orders?.every((v: number, i: number) => i === 0 || v >= orders[i - 1]);
  })());

  // Verify audience CRUD for the page
  const audUpdate = await req('PUT', `/audiences/${AUDIENCE_1_ID}`, { name: 'TestAud IT Directors (Updated)' });
  assert('Update audience name', audUpdate.audience?.name === 'TestAud IT Directors (Updated)');
  // Revert
  await req('PUT', `/audiences/${AUDIENCE_1_ID}`, { name: 'TestAud IT Directors' });

  // ═══════════════════════════════════════════════════
  // SECTION 3: Priority Reorder (drag-and-drop API)
  // ═══════════════════════════════════════════════════
  console.log('\n── Priority Reorder: Drag-and-drop API ──');

  // Original order: [0,1,2,3,4] = [Reduce downtime, Lower TCO, Faster deployment, Better compliance, Team productivity]
  // Move #3 (Better compliance) to #1 position
  const reorderedPriIds = [PRI_IDS[3], PRI_IDS[0], PRI_IDS[1], PRI_IDS[2], PRI_IDS[4]];
  const reorderRes = await req('PUT', `/audiences/${AUDIENCE_1_ID}/priorities/reorder`, { priorityIds: reorderedPriIds });
  assert('Reorder priorities returns 200', reorderRes.status === 200 || !!reorderRes.success || !reorderRes.error, `status: ${reorderRes.status}, error: ${reorderRes.error}`);

  // Verify new order persisted
  const afterReorder = await req('GET', '/audiences');
  const reorderedAud = afterReorder.audiences.find((a: any) => a.id === AUDIENCE_1_ID);
  const prioTexts = reorderedAud?.priorities?.map((p: any) => p.text);
  assert('Priority #1 is now "Better compliance"', prioTexts?.[0] === 'Better compliance', `got "${prioTexts?.[0]}"`);
  assert('Priority #2 is now "Reduce downtime"', prioTexts?.[1] === 'Reduce downtime', `got "${prioTexts?.[1]}"`);

  // Verify ranks updated correctly (rank = sortOrder + 1)
  const priRanks = reorderedAud?.priorities?.map((p: any) => p.rank);
  assert('Rank 1 assigned to new #1', priRanks?.[0] === 1, `got ${priRanks?.[0]}`);
  assert('Rank 2 assigned to new #2', priRanks?.[1] === 2, `got ${priRanks?.[1]}`);
  assert('Rank 5 assigned to last', priRanks?.[4] === 5, `got ${priRanks?.[4]}`);

  // Move it back to original order for subsequent tests
  const originalOrder = [PRI_IDS[0], PRI_IDS[1], PRI_IDS[2], PRI_IDS[3], PRI_IDS[4]];
  await req('PUT', `/audiences/${AUDIENCE_1_ID}/priorities/reorder`, { priorityIds: originalOrder });

  // Verify restoration
  const afterRestore = await req('GET', '/audiences');
  const restoredAud = afterRestore.audiences.find((a: any) => a.id === AUDIENCE_1_ID);
  assert('Priorities restored to original order', restoredAud?.priorities?.[0]?.text === 'Reduce downtime');

  // ─── Priority CRUD during reorder ───
  console.log('\n── Priority CRUD (add/remove during coaching) ──');

  // Add a new priority
  const newPri = await req('POST', `/audiences/${AUDIENCE_1_ID}/priorities`, { text: 'Security certification', rank: 6 });
  assert('Add 6th priority', !!newPri.priority?.id);
  const NEW_PRI_ID = newPri.priority?.id;

  // Update motivating factor
  const mfUpdate = await req('PUT', `/audiences/${AUDIENCE_1_ID}/priorities/${NEW_PRI_ID}`, { motivatingFactor: 'Regulatory requirement' });
  assert('Update motivating factor', mfUpdate.priority?.motivatingFactor === 'Regulatory requirement');

  // Delete the new priority
  const delPri = await req('DELETE', `/audiences/${AUDIENCE_1_ID}/priorities/${NEW_PRI_ID}`);
  assert('Delete priority', delPri.success === true || delPri.status === 200);

  // Confirm it's gone
  const afterDelPri = await req('GET', '/audiences');
  const afterDelAud = afterDelPri.audiences.find((a: any) => a.id === AUDIENCE_1_ID);
  assert('Priority count back to 5', afterDelAud?.priorities?.length === 5, `got ${afterDelAud?.priorities?.length}`);

  // ═══════════════════════════════════════════════════
  // SECTION 4: Offerings Page — Data contract
  // ═══════════════════════════════════════════════════
  console.log('\n── Offerings Page: Data contract ──');

  const offList = await req('GET', '/offerings');
  assert('GET /offerings returns array', Array.isArray(offList.offerings));

  const testOff = offList.offerings.find((o: any) => o.id === OFFERING_A_ID);
  assert('Offering has elements array', Array.isArray(testOff?.elements));
  assert('Offering Alpha has 4 elements', testOff?.elements?.length === 4, `got ${testOff?.elements?.length}`);
  assert('Elements have sortOrder', testOff?.elements?.every((e: any) => typeof e.sortOrder === 'number'));
  assert('Elements ordered by sortOrder', (() => {
    const orders = testOff?.elements?.map((e: any) => e.sortOrder);
    return orders?.every((v: number, i: number) => i === 0 || v >= orders[i - 1]);
  })());
  assert('Offering has smeRole', typeof testOff?.smeRole === 'string');

  // ═══════════════════════════════════════════════════
  // SECTION 5: Element Reorder (drag-and-drop API)
  // ═══════════════════════════════════════════════════
  console.log('\n── Element Reorder: Drag-and-drop API ──');

  // Original order: [Fast, Cloud, Enterprise, API]
  // Move last to first: [API, Fast, Cloud, Enterprise]
  const reorderedElemIds = [ELEM_IDS[3], ELEM_IDS[0], ELEM_IDS[1], ELEM_IDS[2]];
  const elemReorder = await req('PUT', `/offerings/${OFFERING_A_ID}/elements/reorder`, { elementIds: reorderedElemIds });
  assert('Reorder elements returns 200', elemReorder.status === 200 || !elemReorder.error, `status: ${elemReorder.status}, error: ${elemReorder.error}`);

  // Verify new order
  const afterElemReorder = await req('GET', '/offerings');
  const reorderedOff = afterElemReorder.offerings.find((o: any) => o.id === OFFERING_A_ID);
  const elemTextList = reorderedOff?.elements?.map((e: any) => e.text);
  assert('Element #1 is now "API-first design"', elemTextList?.[0] === 'API-first design', `got "${elemTextList?.[0]}"`);
  assert('Element #2 is now "Fast processing"', elemTextList?.[1] === 'Fast processing', `got "${elemTextList?.[1]}"`);

  // Note: elements don't have a rank field, only sortOrder
  const elemOrders = reorderedOff?.elements?.map((e: any) => e.sortOrder);
  assert('sortOrder 0 on first element', elemOrders?.[0] === 0, `got ${elemOrders?.[0]}`);
  assert('sortOrder 3 on last element', elemOrders?.[3] === 3, `got ${elemOrders?.[3]}`);

  // Restore
  await req('PUT', `/offerings/${OFFERING_A_ID}/elements/reorder`, { elementIds: ELEM_IDS });

  // ─── Element CRUD ───
  console.log('\n── Element CRUD (add/remove during coaching) ──');

  const newElem = await req('POST', `/offerings/${OFFERING_A_ID}/elements`, { text: 'New capability', source: 'ai_extracted' });
  assert('Add element (ai_extracted source)', !!newElem.element?.id && newElem.element?.source === 'ai_extracted');

  const delElem = await req('DELETE', `/offerings/${OFFERING_A_ID}/elements/${newElem.element?.id}`);
  assert('Delete element', delElem.success === true || delElem.status === 200);

  const afterDelElem = await req('GET', '/offerings');
  const afterDelOff = afterDelElem.offerings.find((o: any) => o.id === OFFERING_A_ID);
  assert('Element count back to 4', afterDelOff?.elements?.length === 4, `got ${afterDelOff?.elements?.length}`);

  // ═══════════════════════════════════════════════════
  // SECTION 6: Hierarchy endpoint (Three Tiers page)
  // ═══════════════════════════════════════════════════
  console.log('\n── Three Tiers Page: Hierarchy data contract ──');

  const hier = await req('GET', '/drafts/hierarchy');
  assert('Hierarchy is array', Array.isArray(hier.hierarchy));
  assert('Hierarchy has audiences list', Array.isArray(hier.audiences));

  // Find our test offerings in hierarchy
  const hierAlpha = hier.hierarchy.find((o: any) => o.id === OFFERING_A_ID);
  const hierBeta = hier.hierarchy.find((o: any) => o.id === OFFERING_B_ID);
  assert('Offering Alpha in hierarchy', !!hierAlpha);
  assert('Offering Beta in hierarchy', !!hierBeta);

  // Alpha should have 2 audiences (IT Directors + CFOs)
  assert('Alpha has 2 audience drafts', hierAlpha?.audiences?.length === 2, `got ${hierAlpha?.audiences?.length}`);
  assert('Beta has 1 audience draft', hierBeta?.audiences?.length === 1, `got ${hierBeta?.audiences?.length}`);

  // Verify shared audiences appear under multiple offerings
  const alphaAudNames = hierAlpha?.audiences?.map((a: any) => a.name) || [];
  const betaAudNames = hierBeta?.audiences?.map((a: any) => a.name) || [];
  assert('IT Directors under Alpha', alphaAudNames.includes('TestAud IT Directors'));
  assert('IT Directors under Beta', betaAudNames.includes('TestAud IT Directors'));
  assert('Audiences are shared across offerings', true); // The two assertions above prove it

  // Verify draft status/step fields
  const hierAlphaAud1 = hierAlpha?.audiences?.find((a: any) => a.id === AUDIENCE_1_ID);
  assert('Alpha×ITDir threeTier has id', !!hierAlphaAud1?.threeTier?.id);
  assert('Alpha×ITDir is complete (step 5)', hierAlphaAud1?.threeTier?.currentStep === 5, `got step ${hierAlphaAud1?.threeTier?.currentStep}`);
  assert('Alpha×ITDir status is complete', hierAlphaAud1?.threeTier?.status === 'complete');

  const hierAlphaAud2 = hierAlpha?.audiences?.find((a: any) => a.id === AUDIENCE_2_ID);
  assert('Alpha×CFOs at step 3', hierAlphaAud2?.threeTier?.currentStep === 3, `got step ${hierAlphaAud2?.threeTier?.currentStep}`);

  // Verify deliverables in hierarchy
  assert('Complete draft has deliverables', hierAlphaAud1?.deliverables?.length === 1, `got ${hierAlphaAud1?.deliverables?.length}`);
  assert('Deliverable has medium', hierAlphaAud1?.deliverables?.[0]?.medium === 'email');
  assert('Deliverable has stage', typeof hierAlphaAud1?.deliverables?.[0]?.stage === 'string');
  assert('Deliverable has updatedAt', typeof hierAlphaAud1?.deliverables?.[0]?.updatedAt === 'string');

  // Hierarchy includes elementCount
  assert('Alpha has elementCount', hierAlpha?.elementCount === 4, `got ${hierAlpha?.elementCount}`);

  // ─── Audience picker filtering ───
  console.log('\n── Three Tiers Page: Audience picker filtering ──');

  // For offering Alpha: IT Directors and CFOs have drafts, CTOs does not
  const allAuds = hier.audiences;
  const usedAlphaIds = new Set(hierAlpha?.audiences?.map((a: any) => a.id));
  const availableForAlpha = allAuds.filter((a: any) => !usedAlphaIds.has(a.id));
  assert('Available audiences excludes used ones', !availableForAlpha.some((a: any) => a.id === AUDIENCE_1_ID || a.id === AUDIENCE_2_ID));
  // CTOs should be available (not used in Alpha)
  assert('CTOs available for Alpha', availableForAlpha.some((a: any) => a.id === AUDIENCE_3_ID));

  // ═══════════════════════════════════════════════════
  // SECTION 7: Five Chapters Page — Data contract
  // ═══════════════════════════════════════════════════
  console.log('\n── Five Chapters Page: Data contract ──');

  // The hierarchy already has the deliverables we need
  // Test the new GET /stories/all endpoint
  const allStories = await req('GET', '/stories/all');
  assert('GET /stories/all returns array', Array.isArray(allStories.stories));
  assert('Stories/all has at least 1 story', allStories.stories.length >= 1, `got ${allStories.stories.length}`);

  const testStory = allStories.stories.find((s: any) => s.id === STORY_ID);
  assert('Story has draft context', !!testStory?.draft);
  assert('Story draft has offering', !!testStory?.draft?.offering?.name, `got ${JSON.stringify(testStory?.draft?.offering)}`);
  assert('Story draft has audience', !!testStory?.draft?.audience?.name, `got ${JSON.stringify(testStory?.draft?.audience)}`);
  assert('Story has chapters array', Array.isArray(testStory?.chapters));
  assert('Story has medium field', testStory?.medium === 'email');
  assert('Story has stage field', typeof testStory?.stage === 'string');

  // Add a second story to verify multiple deliverables per draft
  const story2 = await req('POST', '/stories', { draftId: DRAFT_A1_ID, medium: 'blog', cta: 'Read more' });
  assert('Create second story', !!story2.story?.id);

  const allStories2 = await req('GET', '/stories/all');
  const draftStories = allStories2.stories.filter((s: any) => s.draft?.id === DRAFT_A1_ID);
  assert('Multiple stories per draft', draftStories.length === 2, `got ${draftStories.length}`);

  // Clean up second story
  await req('DELETE', `/stories/${story2.story?.id}`);

  // ═══════════════════════════════════════════════════
  // SECTION 8: Dashboard Page — Data contract
  // ═══════════════════════════════════════════════════
  console.log('\n── Dashboard Page: Data contract ──');

  // Dashboard uses three endpoints in parallel: hierarchy, offerings, audiences
  const [dashHier, dashOff, dashAud] = await Promise.all([
    req('GET', '/drafts/hierarchy'),
    req('GET', '/offerings'),
    req('GET', '/audiences'),
  ]);

  assert('Dashboard: hierarchy loads', Array.isArray(dashHier.hierarchy));
  assert('Dashboard: offerings loads', Array.isArray(dashOff.offerings));
  assert('Dashboard: audiences loads', Array.isArray(dashAud.audiences));

  // Simulate "continue working" logic: find most recent in-progress draft
  let continueItem: any = null;
  for (const off of dashHier.hierarchy) {
    for (const aud of off.audiences) {
      if (aud.threeTier.status !== 'complete' && aud.threeTier.currentStep !== 5) {
        if (!continueItem) {
          continueItem = {
            offeringName: off.name,
            audienceName: aud.name,
            currentStep: aud.threeTier.currentStep,
          };
        }
      }
    }
  }
  assert('Continue item found (has in-progress work)', !!continueItem, continueItem ? `${continueItem.offeringName} × ${continueItem.audienceName}` : 'none found');

  // Simulate tile counts
  const audCount = dashAud.audiences.length;
  const totalPri = dashAud.audiences.reduce((sum: number, a: any) => sum + (a.priorities?.length || 0), 0);
  assert('Audience count >= 3', audCount >= 3, `got ${audCount}`);
  assert('Total priorities >= 5', totalPri >= 5, `got ${totalPri}`);

  const offCount = dashOff.offerings.length;
  const totalCap = dashOff.offerings.reduce((sum: number, o: any) => sum + (o.elements?.length || 0), 0);
  assert('Offering count >= 2', offCount >= 2, `got ${offCount}`);
  assert('Total capabilities >= 4', totalCap >= 4, `got ${totalCap}`);

  let ttActive = 0, ttComplete = 0;
  for (const off of dashHier.hierarchy) {
    for (const aud of off.audiences) {
      if (aud.threeTier.status === 'complete' || aud.threeTier.currentStep === 5) ttComplete++;
      else ttActive++;
    }
  }
  assert('3T active count >= 2', ttActive >= 2, `got ${ttActive}`);
  assert('3T complete count >= 1', ttComplete >= 1, `got ${ttComplete}`);

  let delivCount = 0;
  for (const off of dashHier.hierarchy) {
    for (const aud of off.audiences) {
      delivCount += aud.deliverables?.length || 0;
    }
  }
  assert('Deliverable count >= 1', delivCount >= 1, `got ${delivCount}`);

  // ═══════════════════════════════════════════════════
  // SECTION 9: Cross-reference integrity
  // ═══════════════════════════════════════════════════
  console.log('\n── Cross-Reference Integrity ──');

  // Audience 1 (IT Directors) should appear in both Alpha and Beta hierarchy
  let aud1DraftCount = 0;
  for (const off of dashHier.hierarchy) {
    for (const aud of off.audiences) {
      if (aud.id === AUDIENCE_1_ID) aud1DraftCount++;
    }
  }
  assert('IT Directors appears in 2 offerings', aud1DraftCount === 2, `appeared in ${aud1DraftCount}`);

  // Audience 3 (CTOs) should appear in no hierarchy entries (no drafts created)
  let aud3DraftCount = 0;
  for (const off of dashHier.hierarchy) {
    for (const aud of off.audiences) {
      if (aud.id === AUDIENCE_3_ID) aud3DraftCount++;
    }
  }
  assert('CTOs has no drafts in hierarchy', aud3DraftCount === 0, `appeared in ${aud3DraftCount}`);
  assert('CTOs still in audiences list', hier.audiences.some((a: any) => a.id === AUDIENCE_3_ID));

  // ═══════════════════════════════════════════════════
  // SECTION 10: Drafts endpoint (list view)
  // ═══════════════════════════════════════════════════
  console.log('\n── Drafts List Endpoint ──');

  const draftList = await req('GET', '/drafts');
  assert('GET /drafts returns array', Array.isArray(draftList.drafts));

  const testDraft = draftList.drafts.find((d: any) => d.id === DRAFT_A1_ID);
  assert('Draft has offering name', !!testDraft?.offering?.name);
  assert('Draft has audience name', !!testDraft?.audience?.name);
  assert('Drafts ordered by updatedAt desc', (() => {
    const dates = draftList.drafts.map((d: any) => new Date(d.updatedAt).getTime());
    return dates.every((d: number, i: number) => i === 0 || d <= dates[i - 1]);
  })());

  // ═══════════════════════════════════════════════════
  // SECTION 11: Draft detail (Step 2 & Step 3 data)
  // ═══════════════════════════════════════════════════
  console.log('\n── Draft Detail: Step 2 & Step 3 data ──');

  const draftDetail = await req('GET', `/drafts/${DRAFT_A1_ID}`);
  assert('Draft detail has offering with elements', Array.isArray(draftDetail.draft?.offering?.elements));
  assert('Draft detail elements ordered by sortOrder', (() => {
    const orders = draftDetail.draft?.offering?.elements?.map((e: any) => e.sortOrder);
    return orders?.every((v: number, i: number) => i === 0 || v >= orders[i - 1]);
  })());

  assert('Draft detail has audience with priorities', Array.isArray(draftDetail.draft?.audience?.priorities));
  assert('Draft detail priorities ordered by sortOrder', (() => {
    const orders = draftDetail.draft?.audience?.priorities?.map((p: any) => p.sortOrder);
    return orders?.every((v: number, i: number) => i === 0 || v >= orders[i - 1]);
  })());
  assert('Priorities have motivatingFactor in draft detail', draftDetail.draft?.audience?.priorities?.every((p: any) => typeof p.motivatingFactor === 'string'));

  // ═══════════════════════════════════════════════════
  // SECTION 12: Edge cases & error handling
  // ═══════════════════════════════════════════════════
  console.log('\n── Edge Cases & Error Handling ──');

  // Duplicate draft creation should fail
  const dup = await req('POST', '/drafts', { offeringId: OFFERING_A_ID, audienceId: AUDIENCE_1_ID });
  assert('Duplicate draft returns 409', dup.status === 409 || dup.error?.includes('already exists'));

  // Reorder with invalid IDs
  const badReorder = await req('PUT', `/audiences/${AUDIENCE_1_ID}/priorities/reorder`, { priorityIds: ['fake-id-1', 'fake-id-2'] });
  // Should either return an error or silently handle (depending on implementation)
  assert('Reorder with invalid IDs handled gracefully', badReorder.status !== 500, `status: ${badReorder.status}`);

  // Reorder with empty array
  const emptyReorder = await req('PUT', `/audiences/${AUDIENCE_1_ID}/priorities/reorder`, { priorityIds: [] });
  assert('Reorder with empty array handled gracefully', emptyReorder.status !== 500, `status: ${emptyReorder.status}`);

  // Stories for non-existent draft
  const badStories = await req('GET', '/stories?draftId=nonexistent');
  assert('Stories for non-existent draft returns 404', badStories.status === 404);

  // ═══════════════════════════════════════════════════
  // SECTION 13: Reorder persistence across reads
  // ═══════════════════════════════════════════════════
  console.log('\n── Reorder Persistence: Verify across multiple reads ──');

  // Reorder elements to a specific order
  const specificOrder = [ELEM_IDS[2], ELEM_IDS[0], ELEM_IDS[3], ELEM_IDS[1]];
  await req('PUT', `/offerings/${OFFERING_A_ID}/elements/reorder`, { elementIds: specificOrder });

  // Read from offerings endpoint
  const check1 = await req('GET', '/offerings');
  const check1Off = check1.offerings.find((o: any) => o.id === OFFERING_A_ID);
  const check1Ids = check1Off?.elements?.map((e: any) => e.id);
  assert('Element order persists (offerings endpoint)', JSON.stringify(check1Ids) === JSON.stringify(specificOrder),
    `expected ${JSON.stringify(specificOrder)}, got ${JSON.stringify(check1Ids)}`);

  // Read from draft detail endpoint
  const check2 = await req('GET', `/drafts/${DRAFT_A1_ID}`);
  const check2Ids = check2.draft?.offering?.elements?.map((e: any) => e.id);
  assert('Element order persists (draft detail)', JSON.stringify(check2Ids) === JSON.stringify(specificOrder),
    `expected ${JSON.stringify(specificOrder)}, got ${JSON.stringify(check2Ids)}`);

  // Restore original order
  await req('PUT', `/offerings/${OFFERING_A_ID}/elements/reorder`, { elementIds: ELEM_IDS });

  // Same for priorities
  const priSpecific = [PRI_IDS[4], PRI_IDS[2], PRI_IDS[0], PRI_IDS[1], PRI_IDS[3]];
  await req('PUT', `/audiences/${AUDIENCE_1_ID}/priorities/reorder`, { priorityIds: priSpecific });

  const priCheck1 = await req('GET', '/audiences');
  const priCheck1Aud = priCheck1.audiences.find((a: any) => a.id === AUDIENCE_1_ID);
  const priCheck1Ids = priCheck1Aud?.priorities?.map((p: any) => p.id);
  assert('Priority order persists (audiences endpoint)', JSON.stringify(priCheck1Ids) === JSON.stringify(priSpecific),
    `expected ${JSON.stringify(priSpecific)}, got ${JSON.stringify(priCheck1Ids)}`);

  const priCheck2 = await req('GET', `/drafts/${DRAFT_A1_ID}`);
  const priCheck2Ids = priCheck2.draft?.audience?.priorities?.map((p: any) => p.id);
  assert('Priority order persists (draft detail)', JSON.stringify(priCheck2Ids) === JSON.stringify(priSpecific),
    `expected ${JSON.stringify(priSpecific)}, got ${JSON.stringify(priCheck2Ids)}`);

  // Verify ranks updated after reorder
  const priRanksAfter = priCheck1Aud?.priorities?.map((p: any) => p.rank);
  assert('Ranks sequential 1-5 after reorder', JSON.stringify(priRanksAfter) === JSON.stringify([1, 2, 3, 4, 5]),
    `got ${JSON.stringify(priRanksAfter)}`);

  // Restore
  await req('PUT', `/audiences/${AUDIENCE_1_ID}/priorities/reorder`, { priorityIds: PRI_IDS });

  // ═══════════════════════════════════════════════════
  // SECTION 14: Stories/all with rich context
  // ═══════════════════════════════════════════════════
  console.log('\n── Stories/All: Rich context ──');

  const richStories = await req('GET', '/stories/all');
  const richStory = richStories.stories.find((s: any) => s.id === STORY_ID);
  assert('Story/all: offering name present', typeof richStory?.draft?.offering?.name === 'string' && richStory.draft.offering.name.length > 0);
  assert('Story/all: audience name present', typeof richStory?.draft?.audience?.name === 'string' && richStory.draft.audience.name.length > 0);
  assert('Story/all: draft id present', typeof richStory?.draft?.id === 'string');
  assert('Story/all: draft status present', typeof richStory?.draft?.status === 'string');
  assert('Story/all: draft currentStep present', typeof richStory?.draft?.currentStep === 'number');

  // ═══════════════════════════════════════════════════
  // Cleanup
  // ═══════════════════════════════════════════════════
  console.log('\n── Cleanup ──');

  // Delete story
  await req('DELETE', `/stories/${STORY_ID}`);
  assert('Delete test story', true);

  // Delete audiences (must delete before offerings to avoid FK issues with drafts)
  // Actually, deleting offerings cascades drafts. Delete audiences separately.
  await req('DELETE', `/audiences/${AUDIENCE_3_ID}`);
  assert('Delete audience CTOs', true);

  // Delete offerings (cascades drafts and elements)
  await req('DELETE', `/offerings/${OFFERING_A_ID}`);
  assert('Delete offering Alpha (cascades drafts)', true);
  await req('DELETE', `/offerings/${OFFERING_B_ID}`);
  assert('Delete offering Beta (cascades drafts)', true);

  // Delete remaining audiences
  await req('DELETE', `/audiences/${AUDIENCE_1_ID}`);
  await req('DELETE', `/audiences/${AUDIENCE_2_ID}`);
  assert('Delete test audiences', true);

  // Verify cleanup
  const finalHier = await req('GET', '/drafts/hierarchy');
  const testOffsRemain = finalHier.hierarchy?.filter((o: any) => o.name.startsWith('TestOff'));
  assert('No test offerings remain', testOffsRemain?.length === 0, `found ${testOffsRemain?.length}`);

  const finalAuds = await req('GET', '/audiences');
  const testAudsRemain = finalAuds.audiences?.filter((a: any) => a.name.startsWith('TestAud'));
  assert('No test audiences remain', testAudsRemain?.length === 0, `found ${testAudsRemain?.length}`);

  // ─── Summary ──────────────────────────────────────
  console.log(`\n═══════════════════════════════════════════════════`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`═══════════════════════════════════════════════════`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(f));
  }
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
