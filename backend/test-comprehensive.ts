/**
 * Comprehensive test suite for the new features:
 * - Prompt quality (per-chapter budgets, format rules)
 * - Editable story parameters (PUT /stories/:id)
 * - Chapter versioning (create, list, restore)
 * - Story version snapshots (create, list, restore)
 * - Global Maria Assistant (message, history, clear)
 * - MF derive → generate flow (skipMFCheck)
 *
 * Run: API_URL=http://localhost:3001/api npx tsx test-comprehensive.ts
 */

const BASE = process.env.API_URL || 'http://localhost:3001/api';
let TOKEN = '';

let OFFERING_ID = '';
let AUDIENCE_ID = '';
let DRAFT_ID = '';
let STORY_ID = '';
let PRI_TOP_ID = '';
let CHAPTER_CONTENT_ID = '';

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
  console.log(`\n=== Comprehensive Test Suite ===`);
  console.log(`API: ${BASE}\n`);

  // ─── Setup ──────────────────────────────────────────
  await test('Auth: Login', async () => {
    const { token } = await req('POST', '/auth/login', { username: 'admin', password: 'maria2026' });
    TOKEN = token;
    assert(!!TOKEN, 'Got auth token');
  });

  await test('Setup: Create test offering', async () => {
    const { offering } = await req('POST', '/offerings', { name: 'TestCo Widget', description: 'A test product for testing' });
    OFFERING_ID = offering.id;
    assert(!!OFFERING_ID, 'Created offering');

    // Add elements
    await req('POST', `/offerings/${OFFERING_ID}/elements`, { text: 'AI-powered analysis in 30 seconds' });
    await req('POST', `/offerings/${OFFERING_ID}/elements`, { text: 'FDA clearance pending' });
    await req('POST', `/offerings/${OFFERING_ID}/elements`, { text: '24/7 support team' });
  });

  await test('Setup: Create test audience with priorities', async () => {
    const { audience } = await req('POST', '/audiences', { name: 'Hospital Lab Directors' });
    AUDIENCE_ID = audience.id;
    assert(!!AUDIENCE_ID, 'Created audience');

    const { priority: p1 } = await req('POST', `/audiences/${AUDIENCE_ID}/priorities`, { text: 'Fast turnaround time', rank: 1 });
    PRI_TOP_ID = p1.id;
    await req('POST', `/audiences/${AUDIENCE_ID}/priorities`, { text: 'Cost control', rank: 2 });
    await req('POST', `/audiences/${AUDIENCE_ID}/priorities`, { text: 'Regulatory compliance', rank: 3 });
    assert(!!PRI_TOP_ID, 'Created priorities');
  });

  await test('Setup: Create draft and build message', async () => {
    const { draft } = await req('POST', '/drafts', { offeringId: OFFERING_ID, audienceId: AUDIENCE_ID });
    DRAFT_ID = draft.id;
    assert(!!DRAFT_ID, 'Created draft');

    // Build message (auto-maps and converts)
    const result = await req('POST', '/ai/build-message', { draftId: DRAFT_ID });
    assert(result.status === 'complete' || result.status === 'questions', 'Build message returned status');

    // Save the tier statements
    if (result.result) {
      await req('PUT', `/tiers/${DRAFT_ID}/tier1`, { text: result.result.tier1.text, priorityId: result.result.tier1.priorityId });
      for (let i = 0; i < result.result.tier2.length; i++) {
        const t2 = result.result.tier2[i];
        await req('POST', `/tiers/${DRAFT_ID}/tier2`, {
          text: t2.text, sortOrder: i, priorityId: t2.priorityId, categoryLabel: t2.categoryLabel,
          tier3: t2.tier3,
        });
      }
    }
  });

  // ─── Driver Derive Flow ──────────────────────────────────
  await test('Driver: Derive for top priority', async () => {
    const result = await req('POST', '/ai/derive-motivation', {
      priorityId: PRI_TOP_ID,
      audienceId: AUDIENCE_ID,
      offeringId: OFFERING_ID,
    });
    assert(!!result.driver, 'Got driver', result.driver?.substring(0, 60));
  });

  // ─── Story CRUD ───────────────────────────────────────
  await test('Story: Create deliverable', async () => {
    const { story } = await req('POST', '/stories', {
      draftId: DRAFT_ID,
      medium: 'email',
      cta: 'Schedule a 15-minute demo',
      emphasis: '',
    });
    STORY_ID = story.id;
    assert(!!STORY_ID, 'Created story');
    assert(story.medium === 'email', 'Medium is email');
  });

  // ─── Editable Params ─────────────────────────────────
  await test('Params: Update story medium', async () => {
    const { story } = await req('PUT', `/stories/${STORY_ID}`, { medium: 'landing_page' });
    assert(story.medium === 'landing_page', 'Medium changed to landing_page');
  });

  await test('Params: Update story CTA', async () => {
    const { story } = await req('PUT', `/stories/${STORY_ID}`, { cta: 'Start free trial' });
    assert(story.cta === 'Start free trial', 'CTA updated');
  });

  await test('Params: Update story emphasis', async () => {
    const { story } = await req('PUT', `/stories/${STORY_ID}`, { emphasis: 'ch2' });
    assert(story.emphasis === 'ch2', 'Emphasis set to ch2');
  });

  // Switch back to email for generation test
  await req('PUT', `/stories/${STORY_ID}`, { medium: 'email', cta: 'Schedule a demo', emphasis: '' });

  // ─── Chapter Generation ───────────────────────────────
  await test('Generate: All 5 chapters', async () => {
    for (let i = 1; i <= 5; i++) {
      const { chapter } = await req('POST', '/ai/generate-chapter', { storyId: STORY_ID, chapterNum: i });
      assert(!!chapter.content, `Chapter ${i} generated (${chapter.content.split(/\s+/).length} words)`);
      if (i === 1) CHAPTER_CONTENT_ID = chapter.id;
    }
  });

  // ─── Prompt Quality Checks ────────────────────────────
  await test('Quality: Email chapter length sanity', async () => {
    const { story } = await req('GET', `/stories/${STORY_ID}`);
    for (const ch of story.chapters) {
      const words = ch.content.split(/\s+/).length;
      // Email chapters should be relatively short
      assert(words < 200, `Ch${ch.chapterNum} word count reasonable (${words})`, `${words} words`);
    }
    // Total should be in a reasonable email range (budgets are guidance, AI may overshoot slightly)
    const totalWords = story.chapters.reduce((sum: number, ch: any) => sum + ch.content.split(/\s+/).length, 0);
    assert(totalWords < 500, `Total email word count reasonable (${totalWords})`, `${totalWords} total words`);
  });

  await test('Quality: No banned narrative phrases', async () => {
    const { story } = await req('GET', `/stories/${STORY_ID}`);
    const fullText = story.chapters.map((ch: any) => ch.content).join(' ').toLowerCase();
    const banned = ['trace back', 'boil down', 'come down to', 'cuts x to y', 'goes from'];
    for (const phrase of banned) {
      assert(!fullText.includes(phrase), `No "${phrase}" in chapters`);
    }
  });

  await test('Quality: No banned metaphorical verbs', async () => {
    const { story } = await req('GET', `/stories/${STORY_ID}`);
    const fullText = story.chapters.map((ch: any) => ch.content).join(' ').toLowerCase();
    // Check for common metaphorical verbs used as marketing verbs (not all occurrences)
    const check = ['unlock your', 'fuel your', 'drive your', 'power your', 'transform your'];
    for (const phrase of check) {
      assert(!fullText.includes(phrase), `No "${phrase}" in chapters`);
    }
  });

  // ─── Chapter Versioning ───────────────────────────────
  await test('Versions: Chapter versions created on generate', async () => {
    const { versions } = await req('GET', `/versions/chapter/${CHAPTER_CONTENT_ID}`);
    assert(versions.length >= 1, `Chapter has ${versions.length} version(s)`);
  });

  await test('Versions: Manual chapter edit creates version', async () => {
    await req('PUT', `/stories/${STORY_ID}/chapters/1`, { content: 'Manually edited chapter 1 content.' });
    const { versions } = await req('GET', `/versions/chapter/${CHAPTER_CONTENT_ID}`);
    assert(versions.length >= 2, `Chapter now has ${versions.length} versions after manual edit`);
  });

  await test('Versions: Restore chapter version', async () => {
    const { versions } = await req('GET', `/versions/chapter/${CHAPTER_CONTENT_ID}`);
    // Restore first version (the AI-generated one)
    const firstVersion = versions[0];
    const result = await req('POST', `/versions/chapter/${CHAPTER_CONTENT_ID}/restore/${firstVersion.versionNum}`);
    assert(!!result.content, 'Restored chapter has content');
    assert(result.content !== 'Manually edited chapter 1 content.', 'Restored to original AI content');
  });

  // ─── Story Version Snapshots ──────────────────────────
  await test('Versions: Create story snapshot', async () => {
    const { version } = await req('POST', `/versions/story/${STORY_ID}`, { label: 'Test snapshot' });
    assert(!!version.id, 'Created story snapshot');
    assert(version.label === 'Test snapshot', 'Label matches');
  });

  await test('Versions: List story versions', async () => {
    const { versions } = await req('GET', `/versions/story/${STORY_ID}`);
    assert(versions.length >= 1, `Got ${versions.length} story version(s)`);
  });

  // ─── Blend (triggers auto-snapshot) ───────────────────
  await test('Blend: Creates snapshot before blending', async () => {
    // Get current version count
    const { versions: before } = await req('GET', `/versions/story/${STORY_ID}`);
    const beforeCount = before.length;

    const { story } = await req('POST', '/ai/blend-story', { storyId: STORY_ID });
    assert(!!story.blendedText, 'Got blended text');
    assert(story.blendedText.length > 50, `Blended text has substance (${story.blendedText.length} chars)`);

    const { versions: after } = await req('GET', `/versions/story/${STORY_ID}`);
    assert(after.length > beforeCount, `New snapshot created (${beforeCount} → ${after.length})`);
  });

  // ─── Copy Edit ────────────────────────────────────────
  await test('Copy edit: Apply edit to blended story', async () => {
    const { story: before } = await req('GET', `/stories/${STORY_ID}`);
    const { content } = await req('POST', '/ai/copy-edit', {
      storyId: STORY_ID,
      content: before.blendedText,
      request: 'Make it shorter and more direct',
    });
    assert(!!content, 'Got edited content');
    assert(content.length < before.blendedText.length * 1.2, 'Edited content is not significantly longer');
  });

  // ─── Maria Assistant ──────────────────────────────────
  await test('Assistant: Send message and get response', async () => {
    const result = await req('POST', '/assistant/message', {
      message: 'What is a Three Tier message?',
      context: { page: 'dashboard' },
    });
    assert(!!result.response, 'Got assistant response');
    assert(result.action === null || result.action === undefined || result.action?.type === undefined,
      'No action for chat-only question');
  });

  await test('Assistant: Get history', async () => {
    const { messages } = await req('GET', '/assistant/history');
    assert(messages.length >= 2, `History has ${messages.length} messages (user + assistant)`);
    assert(messages.some((m: any) => m.role === 'user'), 'Has user message');
    assert(messages.some((m: any) => m.role === 'assistant'), 'Has assistant response');
  });

  await test('Assistant: Context-aware message', async () => {
    const result = await req('POST', '/assistant/message', {
      message: 'Change the medium to blog post',
      context: { page: 'five-chapter', storyId: STORY_ID },
    });
    assert(!!result.response, 'Got context-aware response');
    // The assistant should recognize this as an action request
  });

  await test('Assistant: Clear history', async () => {
    await req('DELETE', '/assistant/history');
    const { messages } = await req('GET', '/assistant/history');
    assert(messages.length === 0, 'History cleared');
  });

  // ─── Cleanup ──────────────────────────────────────────
  await test('Cleanup', async () => {
    await req('DELETE', `/stories/${STORY_ID}`);
    await req('DELETE', `/drafts/${DRAFT_ID}`);
    await req('DELETE', `/audiences/${AUDIENCE_ID}`);
    await req('DELETE', `/offerings/${OFFERING_ID}`);
    assert(true, 'Test data cleaned up');
  });

  // ─── Report ───────────────────────────────────────────
  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\nFailed:');
    failures.forEach(f => console.log(`  ✗ ${f}`));
  }
  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
