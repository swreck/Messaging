/**
 * Integration test suite for Maria backend.
 * Tests all API endpoints against the running server.
 * Run: npx tsx test-suite.ts
 */

const BASE = process.env.API_URL || 'http://localhost:8080/api';
let TOKEN = '';
let OFFERING_ID = '';
let AUDIENCE_ID = '';
let DRAFT_ID = '';
let TIER2_ID = '';
let TIER3_ID = '';
let STORY_ID = '';

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
  console.log('=== Maria Integration Test Suite ===\n');

  // ─── Auth ─────────────────────────────────────────
  console.log('Auth:');
  const login = await req('POST', '/auth/login', { username: 'admin', password: 'maria2026' });
  assert('Login returns token', !!login.token);
  TOKEN = login.token;

  // ─── Offerings ────────────────────────────────────
  console.log('\nOfferings:');
  const newOff = await req('POST', '/offerings', { name: 'Test Widget Pro', smeRole: 'PM', description: 'Test offering' });
  assert('Create offering', newOff.status === 201 || !!newOff.offering);
  OFFERING_ID = newOff.offering?.id;

  const listOff = await req('GET', '/offerings');
  assert('List offerings', Array.isArray(listOff.offerings) && listOff.offerings.length > 0);

  const updOff = await req('PUT', `/offerings/${OFFERING_ID}`, { name: 'Test Widget Pro v2' });
  assert('Update offering', updOff.offering?.name === 'Test Widget Pro v2');

  // Add elements
  const elem1 = await req('POST', `/offerings/${OFFERING_ID}/elements`, { text: 'AI-powered analytics' });
  assert('Add offering element', !!elem1.element?.id);
  const elem2 = await req('POST', `/offerings/${OFFERING_ID}/elements`, { text: 'Real-time dashboard' });
  assert('Add second element', !!elem2.element?.id);

  // ─── Audiences ────────────────────────────────────
  console.log('\nAudiences:');
  const newAud = await req('POST', '/audiences', { name: 'IT Directors', description: 'Mid-market IT leaders' });
  assert('Create audience', !!newAud.audience?.id);
  AUDIENCE_ID = newAud.audience?.id;

  const listAud = await req('GET', '/audiences');
  assert('List audiences', Array.isArray(listAud.audiences) && listAud.audiences.length > 0);

  // Bulk create audiences
  const bulkAud = await req('POST', '/audiences/bulk', {
    audiences: [{ name: 'CFOs', description: 'Financial decision makers' }, { name: 'CTOs', description: 'Tech leaders' }],
  });
  assert('Bulk create audiences', Array.isArray(bulkAud.audiences) && bulkAud.audiences.length === 2);

  // Add priorities
  const pri1 = await req('POST', `/audiences/${AUDIENCE_ID}/priorities`, { text: 'Reduce downtime', rank: 1, driver: 'Board pressure' });
  assert('Add priority', !!pri1.priority?.id);
  const pri2 = await req('POST', `/audiences/${AUDIENCE_ID}/priorities`, { text: 'Cut costs by 20%', rank: 2, driver: 'Budget constraints' });
  assert('Add second priority', !!pri2.priority?.id);

  // ─── Drafts ───────────────────────────────────────
  console.log('\nDrafts:');
  const newDraft = await req('POST', '/drafts', { offeringId: OFFERING_ID, audienceId: AUDIENCE_ID });
  assert('Create draft', !!newDraft.draft?.id);
  DRAFT_ID = newDraft.draft?.id;

  // Duplicate should 409
  const dupDraft = await req('POST', '/drafts', { offeringId: OFFERING_ID, audienceId: AUDIENCE_ID });
  assert('Duplicate draft returns 409', dupDraft.status === 409 || dupDraft.error?.includes('already exists'));

  const getDraft = await req('GET', `/drafts/${DRAFT_ID}`);
  assert('Get draft with relations', !!getDraft.draft?.offering && !!getDraft.draft?.audience);

  const patchDraft = await req('PATCH', `/drafts/${DRAFT_ID}`, { currentStep: 3 });
  assert('Patch draft step', patchDraft.draft?.currentStep === 3);

  // Hierarchy
  const hier = await req('GET', '/drafts/hierarchy');
  assert('Hierarchy endpoint returns data', Array.isArray(hier.hierarchy) && hier.hierarchy.length > 0);
  assert('Hierarchy includes audiences array', !!hier.audiences);

  // ─── Tiers ────────────────────────────────────────
  console.log('\nTiers:');
  const t1 = await req('PUT', `/tiers/${DRAFT_ID}/tier1`, { text: 'You get reliability because we never go down', changeSource: 'manual' });
  assert('Set tier1', !!t1.tier1?.id);

  const t2 = await req('POST', `/tiers/${DRAFT_ID}/tier2`, { text: 'Tier 2 statement', priorityId: pri1.priority?.id, categoryLabel: 'Reliability', changeSource: 'manual' });
  assert('Create tier2 with categoryLabel', !!t2.tier2?.id);
  TIER2_ID = t2.tier2?.id;

  const t2Upd = await req('PUT', `/tiers/${DRAFT_ID}/tier2/${TIER2_ID}`, { text: 'Updated tier2', categoryLabel: 'Uptime' });
  assert('Update tier2 with categoryLabel', t2Upd.tier2?.text === 'Updated tier2');

  // Bulk tier2
  const bulkT2 = await req('POST', `/tiers/${DRAFT_ID}/tier2/bulk`, {
    statements: [
      { text: 'Bulk stmt 1', priorityId: pri1.priority?.id, categoryLabel: 'Focus' },
      { text: 'Bulk stmt 2', priorityId: pri2.priority?.id, categoryLabel: 'Value' },
    ],
    changeSource: 'ai_generate',
  });
  assert('Bulk tier2 creates statements', Array.isArray(bulkT2.tier2Statements) && bulkT2.tier2Statements.length === 2);
  TIER2_ID = bulkT2.tier2Statements[0]?.id;

  // Tier3
  const t3 = await req('POST', `/tiers/${DRAFT_ID}/tier2/${TIER2_ID}/tier3`, { text: '99.99% uptime' });
  assert('Create tier3 bullet', !!t3.tier3?.id);
  TIER3_ID = t3.tier3?.id;

  const t3Upd = await req('PUT', `/tiers/${DRAFT_ID}/tier3/${TIER3_ID}`, { text: '99.999% uptime' });
  assert('Update tier3', t3Upd.tier3?.text === '99.999% uptime');

  // Bulk tier3
  const bulkT3 = await req('POST', `/tiers/${DRAFT_ID}/tier2/${TIER2_ID}/tier3/bulk`, {
    bullets: ['Proof 1', 'Proof 2', 'Proof 3'],
  });
  assert('Bulk tier3 creates bullets', Array.isArray(bulkT3.tier3Bullets) && bulkT3.tier3Bullets.length === 3);

  // ─── Versions ─────────────────────────────────────
  console.log('\nVersions:');
  const snap = await req('POST', `/versions/table/${DRAFT_ID}`, { label: 'Test snapshot' });
  assert('Create table snapshot', !!snap.version?.id);

  const snaps = await req('GET', `/versions/table/${DRAFT_ID}`);
  assert('List table snapshots', Array.isArray(snaps.versions) && snaps.versions.length > 0);

  const restore = await req('POST', `/versions/table/${DRAFT_ID}/restore/${snap.version?.id}`);
  assert('Restore table snapshot', restore.success === true);

  // Cell version history
  if (t1.tier1?.id) {
    const cellVersions = await req('GET', `/versions/cell/tier1/${t1.tier1.id}`);
    assert('Cell version history', Array.isArray(cellVersions.versions));
  }

  // ─── AI Conversation ──────────────────────────────
  console.log('\nAI Conversation:');
  const convHistory = await req('GET', `/ai/conversation/${DRAFT_ID}/2`);
  assert('Get conversation history (empty)', Array.isArray(convHistory.messages));

  // ─── Stories ──────────────────────────────────────
  console.log('\nStories:');
  const newStory = await req('POST', '/stories', { draftId: DRAFT_ID, medium: 'email', cta: 'Schedule a demo' });
  assert('Create story with new medium type', !!newStory.story?.id && newStory.story?.medium === 'email');
  STORY_ID = newStory.story?.id;

  const listStories = await req('GET', `/stories?draftId=${DRAFT_ID}`);
  assert('List stories', Array.isArray(listStories.stories) && listStories.stories.length > 0);

  const getStory = await req('GET', `/stories/${STORY_ID}`);
  assert('Get story', getStory.story?.id === STORY_ID);
  assert('Story has stage field', getStory.story?.stage === 'chapters');

  const updStory = await req('PUT', `/stories/${STORY_ID}`, { emphasis: 'ch2', stage: 'joined', joinedText: 'Test joined text' });
  assert('Update story stage and joinedText', updStory.story?.stage === 'joined' && updStory.story?.joinedText === 'Test joined text');

  // Story chapter
  const chapterPut = await req('PUT', `/stories/${STORY_ID}/chapters/1`, { title: 'Test Chapter', content: 'Test content' });
  assert('Upsert chapter', !!chapterPut.chapter?.id);

  // Story version
  const storySnap = await req('POST', `/versions/story/${STORY_ID}`, { label: 'Test story snapshot' });
  assert('Create story snapshot', !!storySnap.version?.id);

  const storySnaps = await req('GET', `/versions/story/${STORY_ID}`);
  assert('List story snapshots', Array.isArray(storySnaps.versions) && storySnaps.versions.length > 0);

  // ─── AI Endpoints (structure only, no actual AI calls) ──
  console.log('\nAI Endpoints (validation only):');
  const badBuild = await req('POST', '/ai/build-message', {});
  assert('build-message rejects without draftId', badBuild.status === 400 || !!badBuild.error);

  const badDirection = await req('POST', '/ai/direction', {});
  assert('direction rejects without params', badDirection.status === 400 || !!badDirection.error);

  const badCopyEdit = await req('POST', '/ai/copy-edit', {});
  assert('copy-edit rejects without params', badCopyEdit.status === 400 || !!badCopyEdit.error);

  const badJoin = await req('POST', '/ai/join-chapters', {});
  assert('join-chapters rejects without storyId', badJoin.status === 400 || !!badJoin.error);

  const badDiscover = await req('POST', '/ai/discover-audiences', {});
  assert('discover-audiences rejects without description', badDiscover.status === 400 || !!badDiscover.error);

  const badResolve = await req('POST', '/ai/resolve-questions', {});
  assert('resolve-questions rejects without params', badResolve.status === 400 || !!badResolve.error);

  // ─── Cleanup ──────────────────────────────────────
  console.log('\nCleanup:');
  // Delete story
  const delStory = await req('DELETE', `/stories/${STORY_ID}`);
  assert('Delete story', delStory.success === true);

  // Delete bulk-created audiences
  for (const a of bulkAud.audiences || []) {
    await req('DELETE', `/audiences/${a.id}`);
  }
  assert('Delete bulk audiences', true);

  // Delete test audience
  await req('DELETE', `/audiences/${AUDIENCE_ID}`);
  // Delete test offering (cascades draft)
  await req('DELETE', `/offerings/${OFFERING_ID}`);
  assert('Cleanup complete', true);

  // ─── Summary ──────────────────────────────────────
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
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
