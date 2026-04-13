/**
 * Comprehensive test suite for the Five Chapter Story redesign.
 * Tests: derive-motivation endpoint, MF validation (top priority only),
 * story CRUD, chapter generation, blend (no join), chapter editing,
 * copy edit, and cleanup.
 *
 * Run: API_URL=http://localhost:3001/api npx tsx test-five-chapter-redesign.ts
 * Or against Railway: API_URL=https://glorious-benevolence-production-c1e0.up.railway.app/api npx tsx test-five-chapter-redesign.ts
 */

const BASE = process.env.API_URL || 'http://localhost:3001/api';
let TOKEN = '';

// Test data IDs
let OFFERING_ID = '';
let AUDIENCE_ID = '';
let DRAFT_ID = '';
let STORY_ID = '';
let PRI_TOP_ID = '';
let PRI_2_ID = '';
let PRI_3_ID = '';
let CHAPTER_IDS: string[] = [];

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
  console.log('=== Five Chapter Story Redesign — Comprehensive Test ===\n');

  // ─── Auth ──────────────────────────────────────────
  console.log('Auth:');
  const login = await req('POST', '/auth/login', { username: 'admin', password: 'maria2026' });
  assert('Login returns token', !!login.token);
  TOKEN = login.token;
  if (!TOKEN) { console.log('FATAL: Cannot proceed without auth.'); process.exit(1); }

  // ═══════════════════════════════════════════════════
  // SECTION 1: Setup test data
  // ═══════════════════════════════════════════════════
  console.log('\n── Setup: Create offering, audience, priorities, elements, draft ──');

  // Create offering with elements
  const off = await req('POST', '/offerings', { name: '5CS Test Product', smeRole: 'PM', description: 'Testing five chapter redesign' });
  assert('Create offering', off.status === 201 && !!off.offering?.id);
  OFFERING_ID = off.offering?.id;

  for (const text of ['AI-powered analysis', 'Real-time processing', 'Cloud-native platform', 'Enterprise security']) {
    const el = await req('POST', `/offerings/${OFFERING_ID}/elements`, { text, source: 'manual' });
    assert(`Add element: ${text.substring(0, 20)}`, el.status === 201);
  }

  // Create audience with 3 priorities (NO motivating factors initially)
  const aud = await req('POST', '/audiences', { name: '5CS Test Audience', description: 'Clinical leads' });
  assert('Create audience', aud.status === 201 && !!aud.audience?.id);
  AUDIENCE_ID = aud.audience?.id;

  const pri1 = await req('POST', `/audiences/${AUDIENCE_ID}/priorities`, { text: 'Faster diagnostic results', rank: 1 });
  assert('Create priority #1 (no MF)', pri1.status === 201 && !!pri1.priority?.id);
  PRI_TOP_ID = pri1.priority?.id;

  const pri2 = await req('POST', `/audiences/${AUDIENCE_ID}/priorities`, { text: 'Lower per-test cost', rank: 2 });
  assert('Create priority #2 (no MF)', pri2.status === 201);
  PRI_2_ID = pri2.priority?.id;

  const pri3 = await req('POST', `/audiences/${AUDIENCE_ID}/priorities`, { text: 'FDA compliance', rank: 3 });
  assert('Create priority #3 (no MF)', pri3.status === 201);
  PRI_3_ID = pri3.priority?.id;

  // Create draft and advance to step 5 (complete) so 5CS can work
  const draft = await req('POST', '/drafts', { offeringId: OFFERING_ID, audienceId: AUDIENCE_ID });
  assert('Create draft', draft.status === 201 && !!draft.draft?.id);
  DRAFT_ID = draft.draft?.id;

  // Advance draft to complete status (PATCH, not PUT)
  const advance = await req('PATCH', `/drafts/${DRAFT_ID}`, { currentStep: 5, status: 'complete' });
  assert('Advance draft to step 5 complete', advance.status === 200);

  // Create a tier 1 statement for the draft (PUT /api/tiers/:draftId/tier1)
  const t1 = await req('PUT', `/tiers/${DRAFT_ID}/tier1`, { text: 'You get faster, more affordable diagnostics because AI replaces manual analysis', changeSource: 'test' });
  assert('Create tier 1 statement', t1.status === 200 || t1.status === 201);

  // ═══════════════════════════════════════════════════
  // SECTION 2: Story creation
  // ═══════════════════════════════════════════════════
  console.log('\n── Story CRUD ──');

  const story = await req('POST', '/stories', { draftId: DRAFT_ID, medium: 'email', cta: 'Schedule a demo', emphasis: '' });
  assert('Create story', story.status === 201 && !!story.story?.id);
  STORY_ID = story.story?.id;
  assert('Story has correct medium', story.story?.medium === 'email');
  assert('Story has correct CTA', story.story?.cta === 'Schedule a demo');
  assert('Story starts at chapters stage', story.story?.stage === 'chapters');
  assert('Story has empty chapters array', story.story?.chapters?.length === 0);

  // GET stories for draft
  const storiesList = await req('GET', `/stories?draftId=${DRAFT_ID}`);
  assert('GET stories returns array', Array.isArray(storiesList.stories));
  assert('Stories list includes our story', storiesList.stories?.some((s: any) => s.id === STORY_ID));

  // GET single story
  const storyGet = await req('GET', `/stories/${STORY_ID}`);
  assert('GET single story returns story', storyGet.story?.id === STORY_ID);

  // Update story metadata
  const storyUpd = await req('PUT', `/stories/${STORY_ID}`, { cta: 'Start a free trial' });
  assert('Update story CTA', storyUpd.status === 200 && storyUpd.story?.cta === 'Start a free trial');

  // ═══════════════════════════════════════════════════
  // SECTION 3: Motivating factor validation
  // ═══════════════════════════════════════════════════
  console.log('\n── MF Validation (top priority only) ──');

  // Try to generate chapter WITHOUT motivating factor on #1 — should fail
  const genNoMF = await req('POST', '/ai/generate-chapter', { storyId: STORY_ID, chapterNum: 1 });
  assert('Generate chapter fails without top MF', genNoMF.status === 400);
  assert('Error mentions top priority', genNoMF.error?.includes('top priority'));
  assert('Error includes missingTopPriority', !!genNoMF.missingTopPriority);
  assert('Missing priority is our #1', genNoMF.missingTopPriority?.id === PRI_TOP_ID);

  // Add MF to priority #2 only — should still fail (top priority matters)
  await req('PUT', `/audiences/${AUDIENCE_ID}/priorities/${PRI_2_ID}`, { driver: 'Budget matters' });
  const genMF2Only = await req('POST', '/ai/generate-chapter', { storyId: STORY_ID, chapterNum: 1 });
  assert('Generate still fails with MF only on #2', genMF2Only.status === 400);

  // ═══════════════════════════════════════════════════
  // SECTION 4: AI-derived motivation
  // ═══════════════════════════════════════════════════
  console.log('\n── Derive Motivation Endpoint ──');

  // Derive motivation for top priority
  const deriveMF = await req('POST', '/ai/derive-motivation', {
    priorityId: PRI_TOP_ID,
    audienceId: AUDIENCE_ID,
    offeringId: OFFERING_ID,
  });
  assert('Derive motivation returns 200', deriveMF.status === 200);
  assert('Returns driver string', typeof deriveMF.driver === 'string' && deriveMF.driver.length > 10);
  console.log(`    AI-derived MF: "${deriveMF.driver?.substring(0, 80)}..."`);

  // Verify it was saved to the priority
  const audCheck = await req('GET', '/audiences');
  const testAud = audCheck.audiences?.find((a: any) => a.id === AUDIENCE_ID);
  const topPri = testAud?.priorities?.find((p: any) => p.id === PRI_TOP_ID);
  assert('MF was persisted to priority', !!topPri?.driver && topPri.driver.length > 10);

  // Test derive-motivation validation
  const deriveBadPri = await req('POST', '/ai/derive-motivation', { priorityId: 'fake-id', audienceId: AUDIENCE_ID });
  assert('Derive with fake priorityId returns 404', deriveBadPri.status === 404);

  const deriveMissingParams = await req('POST', '/ai/derive-motivation', { priorityId: PRI_TOP_ID });
  assert('Derive without audienceId returns 400', deriveMissingParams.status === 400);

  // ═══════════════════════════════════════════════════
  // SECTION 5: Chapter generation
  // ═══════════════════════════════════════════════════
  console.log('\n── Chapter Generation (sequential, all 5) ──');

  // Now generate chapter 1 — should succeed since top priority has MF
  const gen1 = await req('POST', '/ai/generate-chapter', { storyId: STORY_ID, chapterNum: 1 });
  assert('Generate chapter 1 succeeds', gen1.status === 200 && !!gen1.chapter);
  assert('Chapter 1 has content', gen1.chapter?.content?.length > 50);
  assert('Chapter 1 has correct chapterNum', gen1.chapter?.chapterNum === 1);
  assert('Chapter 1 has title', !!gen1.chapter?.title);
  console.log(`    Ch1 length: ${gen1.chapter?.content?.length} chars`);

  // Generate chapters 2–5
  for (let i = 2; i <= 5; i++) {
    const gen = await req('POST', '/ai/generate-chapter', { storyId: STORY_ID, chapterNum: i });
    assert(`Generate chapter ${i} succeeds`, gen.status === 200 && !!gen.chapter?.content);
    assert(`Chapter ${i} has content (>50 chars)`, gen.chapter?.content?.length > 50);
    console.log(`    Ch${i} length: ${gen.chapter?.content?.length} chars`);
  }

  // Verify all 5 chapters exist
  const storyAfterGen = await req('GET', `/stories/${STORY_ID}`);
  assert('Story has 5 chapters after generation', storyAfterGen.story?.chapters?.length === 5);
  for (let i = 1; i <= 5; i++) {
    const ch = storyAfterGen.story?.chapters?.find((c: any) => c.chapterNum === i);
    assert(`Chapter ${i} exists in story`, !!ch);
    CHAPTER_IDS.push(ch?.id);
  }

  // Test that priority #2 and #3 NOT having MF is fine (only top matters)
  // (We already proved this works because generation succeeded)
  const pri3Check = testAud?.priorities?.find((p: any) => p.id === PRI_3_ID);
  assert('Priority #3 has no MF (and that is OK)', !pri3Check?.driver);

  // ═══════════════════════════════════════════════════
  // SECTION 6: Chapter editing
  // ═══════════════════════════════════════════════════
  console.log('\n── Chapter Editing ──');

  const editContent = 'This is manually edited chapter 3 content for testing purposes.';
  const editCh = await req('PUT', `/stories/${STORY_ID}/chapters/3`, { content: editContent });
  assert('Edit chapter 3 returns 200', editCh.status === 200);

  const verifyEdit = await req('GET', `/stories/${STORY_ID}`);
  const ch3 = verifyEdit.story?.chapters?.find((c: any) => c.chapterNum === 3);
  assert('Chapter 3 content was updated', ch3?.content === editContent);

  // Edit with empty content — should still work (user might clear and regenerate)
  const editEmpty = await req('PUT', `/stories/${STORY_ID}/chapters/3`, { content: '' });
  assert('Edit chapter with empty content works', editEmpty.status === 200);

  // Restore content for blend test
  await req('PUT', `/stories/${STORY_ID}/chapters/3`, { content: editContent });

  // ═══════════════════════════════════════════════════
  // SECTION 7: Regenerate single chapter
  // ═══════════════════════════════════════════════════
  console.log('\n── Regenerate Single Chapter ──');

  const regenCh2 = await req('POST', '/ai/generate-chapter', { storyId: STORY_ID, chapterNum: 2 });
  assert('Regenerate chapter 2 succeeds', regenCh2.status === 200 && !!regenCh2.chapter?.content);
  assert('Regenerated content differs or exists', regenCh2.chapter?.content?.length > 50);

  // ═══════════════════════════════════════════════════
  // SECTION 8: Blend (skip join)
  // ═══════════════════════════════════════════════════
  console.log('\n── Blend Story (no join step) ──');

  const blend = await req('POST', '/ai/blend-story', { storyId: STORY_ID });
  assert('Blend returns 200', blend.status === 200);
  assert('Blended text exists', blend.story?.blendedText?.length > 100);
  assert('Stage is blended', blend.story?.stage === 'blended');
  console.log(`    Blended story length: ${blend.story?.blendedText?.length} chars`);

  // Verify blended text persisted
  const storyAfterBlend = await req('GET', `/stories/${STORY_ID}`);
  assert('Blended text persisted', storyAfterBlend.story?.blendedText?.length > 100);
  assert('Stage persisted as blended', storyAfterBlend.story?.stage === 'blended');
  // Chapters should still be there
  assert('Chapters still exist after blend', storyAfterBlend.story?.chapters?.length === 5);

  // ═══════════════════════════════════════════════════
  // SECTION 9: Edit blended text
  // ═══════════════════════════════════════════════════
  console.log('\n── Edit Blended Text ──');

  const newBlended = 'Manually edited blended story for testing.';
  const editBlend = await req('PUT', `/stories/${STORY_ID}`, { blendedText: newBlended });
  assert('Edit blended text returns 200', editBlend.status === 200);
  assert('Blended text updated', editBlend.story?.blendedText === newBlended);

  // ═══════════════════════════════════════════════════
  // SECTION 10: Copy edit
  // ═══════════════════════════════════════════════════
  console.log('\n── Copy Edit ──');

  // Restore a real blended text first
  await req('PUT', `/stories/${STORY_ID}`, { blendedText: blend.story?.blendedText });

  const copyEditRes = await req('POST', '/ai/copy-edit', {
    storyId: STORY_ID,
    content: blend.story?.blendedText?.substring(0, 500),
    request: 'Make it shorter and more direct',
  });
  assert('Copy edit returns 200', copyEditRes.status === 200);
  assert('Copy edit returns revised content', typeof copyEditRes.content === 'string' && copyEditRes.content.length > 20);

  // ═══════════════════════════════════════════════════
  // SECTION 11: Stories/all endpoint
  // ═══════════════════════════════════════════════════
  console.log('\n── Stories All Endpoint ──');

  const allStories = await req('GET', '/stories/all');
  assert('GET /stories/all returns 200', allStories.status === 200);
  assert('Returns stories array', Array.isArray(allStories.stories));
  const ourStory = allStories.stories?.find((s: any) => s.id === STORY_ID);
  assert('Our test story appears in /all', !!ourStory);

  // ═══════════════════════════════════════════════════
  // SECTION 12: Multiple stories per draft
  // ═══════════════════════════════════════════════════
  console.log('\n── Multiple Stories per Draft ──');

  const story2 = await req('POST', '/stories', { draftId: DRAFT_ID, medium: 'blog', cta: 'Read more', emphasis: 'ch1' });
  assert('Create second story (blog)', story2.status === 201 && !!story2.story?.id);
  assert('Second story has blog medium', story2.story?.medium === 'blog');
  assert('Second story has emphasis', story2.story?.emphasis === 'ch1');

  const storiesForDraft = await req('GET', `/stories?draftId=${DRAFT_ID}`);
  assert('Draft has 2 stories', storiesForDraft.stories?.length === 2);

  // Delete second story
  const delStory2 = await req('DELETE', `/stories/${story2.story?.id}`);
  assert('Delete second story', delStory2.status === 200);

  const storiesAfterDel = await req('GET', `/stories?draftId=${DRAFT_ID}`);
  assert('After delete, draft has 1 story', storiesAfterDel.stories?.length === 1);

  // ═══════════════════════════════════════════════════
  // SECTION 13: Edge cases
  // ═══════════════════════════════════════════════════
  console.log('\n── Edge Cases ──');

  // Generate chapter with invalid storyId
  const genBadStory = await req('POST', '/ai/generate-chapter', { storyId: 'fake-id', chapterNum: 1 });
  assert('Generate with fake storyId returns 404', genBadStory.status === 404);

  // Generate chapter with missing params
  const genMissing = await req('POST', '/ai/generate-chapter', { storyId: STORY_ID });
  assert('Generate without chapterNum returns 400', genMissing.status === 400);

  // Blend with no chapters
  const emptyStory = await req('POST', '/stories', { draftId: DRAFT_ID, medium: 'social', cta: 'Learn more' });
  const blendEmpty = await req('POST', '/ai/blend-story', { storyId: emptyStory.story?.id });
  assert('Blend with no chapters fails gracefully', blendEmpty.status === 400 || blendEmpty.status === 500);
  await req('DELETE', `/stories/${emptyStory.story?.id}`);

  // Create story without required fields
  const storyNoMedium = await req('POST', '/stories', { draftId: DRAFT_ID });
  assert('Create story without medium fails', storyNoMedium.status === 400 || storyNoMedium.status === 500);

  const storyNoDraft = await req('POST', '/stories', { medium: 'email', cta: 'Test' });
  assert('Create story without draftId fails', storyNoDraft.status === 400 || storyNoDraft.status === 500);

  // ═══════════════════════════════════════════════════
  // SECTION 14: Priority reorder with MF implications
  // ═══════════════════════════════════════════════════
  console.log('\n── Priority Reorder + MF implications ──');

  // Current order: pri1 (has MF), pri2 (has MF), pri3 (no MF)
  // Reorder to: pri3, pri1, pri2 — now top priority has no MF
  const reorderRes = await req('PUT', `/audiences/${AUDIENCE_ID}/priorities/reorder`, {
    priorityIds: [PRI_3_ID, PRI_TOP_ID, PRI_2_ID],
  });
  assert('Reorder priorities succeeds', reorderRes.status === 200);

  // Now try to generate — should fail because new #1 (pri3) has no MF
  const genAfterReorder = await req('POST', '/ai/generate-chapter', { storyId: STORY_ID, chapterNum: 1 });
  assert('Generate fails after reorder (new #1 has no MF)', genAfterReorder.status === 400);
  assert('Error points to correct priority', genAfterReorder.missingTopPriority?.id === PRI_3_ID);

  // Derive motivation for new top priority
  const deriveMF3 = await req('POST', '/ai/derive-motivation', {
    priorityId: PRI_3_ID,
    audienceId: AUDIENCE_ID,
    offeringId: OFFERING_ID,
  });
  assert('Derive MF for new #1 succeeds', deriveMF3.status === 200 && !!deriveMF3.driver);

  // Now generation should work
  const genAfterDerive = await req('POST', '/ai/generate-chapter', { storyId: STORY_ID, chapterNum: 1 });
  assert('Generate succeeds after deriving MF for new #1', genAfterDerive.status === 200);

  // Restore original order
  await req('PUT', `/audiences/${AUDIENCE_ID}/priorities/reorder`, {
    priorityIds: [PRI_TOP_ID, PRI_2_ID, PRI_3_ID],
  });

  // ═══════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════
  console.log('\n── Cleanup ──');

  const delStory = await req('DELETE', `/stories/${STORY_ID}`);
  assert('Delete test story', delStory.status === 200);

  const delDraft = await req('DELETE', `/drafts/${DRAFT_ID}`);
  assert('Delete test draft', delDraft.status === 200);

  const delAud = await req('DELETE', `/audiences/${AUDIENCE_ID}`);
  assert('Delete test audience', delAud.status === 200);

  const delOff = await req('DELETE', `/offerings/${OFFERING_ID}`);
  assert('Delete test offering', delOff.status === 200);

  // Verify cleanup
  const finalAud = await req('GET', '/audiences');
  const leftoverAud = finalAud.audiences?.find((a: any) => a.id === AUDIENCE_ID);
  assert('Audience fully deleted', !leftoverAud);

  const finalOff = await req('GET', '/offerings');
  const leftoverOff = finalOff.offerings?.find((o: any) => o.id === OFFERING_ID);
  assert('Offering fully deleted', !leftoverOff);

  // ═══════════════════════════════════════════════════
  // RESULTS
  // ═══════════════════════════════════════════════════
  console.log('\n' + '='.repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(f));
  }
  console.log('='.repeat(50));
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
