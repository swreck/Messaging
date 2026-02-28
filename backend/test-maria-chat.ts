/**
 * Maria Chat Test Suite
 *
 * Tests the full breadth of Maria's assistant behavior:
 * - Basic chat on every page context
 * - Methodology knowledge (Three Tier, Five Chapter, Ken's Voice)
 * - read_page triggering (when user references specific content)
 * - read_page NOT triggering (general questions)
 * - Page content endpoint for every context type
 * - Action dispatch (add_priorities, copy_edit)
 * - Conversation history awareness
 * - No internal IDs leaked in responses
 * - Conciseness (1-3 sentences)
 *
 * Run: API_URL=http://localhost:3001/api npx tsx test-maria-chat.ts
 *   or: API_URL=https://messaging-production-6e16.up.railway.app/api npx tsx test-maria-chat.ts
 */

const BASE = process.env.API_URL || 'http://localhost:3001/api';
let TOKEN = '';

// IDs populated during setup
let OFFERING_ID = '';
let AUDIENCE_ID = '';
let DRAFT_ID = '';
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

/** Send a message to Maria and return the full response */
async function askMaria(message: string, context: any, history?: any[]): Promise<any> {
  return req('POST', '/assistant/message', { message, context, history: history || [] });
}

/** Fetch page content for a given context */
async function getPageContent(context: any): Promise<string> {
  const { content } = await req('POST', '/assistant/page-content', { context });
  return content;
}

async function main() {
  console.log(`\n══════════════════════════════════════`);
  console.log(`  Maria Chat Test Suite`);
  console.log(`  API: ${BASE}`);
  console.log(`══════════════════════════════════════`);

  // ─── Setup ──────────────────────────────────────────
  await test('Setup: Login', async () => {
    const { token } = await req('POST', '/auth/login', { username: 'admin', password: 'maria2026' });
    TOKEN = token;
    assert(!!TOKEN, 'Got auth token');
  });

  await test('Setup: Find or create test data', async () => {
    // Get existing offerings
    const { offerings } = await req('GET', '/offerings');
    if (offerings.length > 0) {
      OFFERING_ID = offerings[0].id;
      console.log(`  Using offering: ${offerings[0].name}`);
    } else {
      const { offering } = await req('POST', '/offerings', { name: 'Maria Test Product', description: 'For testing Maria chat' });
      OFFERING_ID = offering.id;
      await req('POST', `/offerings/${OFFERING_ID}/elements`, { text: 'AI-powered analysis' });
    }

    // Get existing audiences
    const { audiences } = await req('GET', '/audiences');
    if (audiences.length > 0) {
      AUDIENCE_ID = audiences[0].id;
      console.log(`  Using audience: ${audiences[0].name}`);
    } else {
      const { audience } = await req('POST', '/audiences', { name: 'Maria Test Audience', description: 'For testing' });
      AUDIENCE_ID = audience.id;
      await req('POST', `/audiences/${AUDIENCE_ID}/priorities`, { text: 'Faster diagnostic results', rank: 1 });
    }

    // Get existing drafts
    const { drafts } = await req('GET', '/drafts');
    if (drafts.length > 0) {
      DRAFT_ID = drafts[0].id;
      console.log(`  Using draft: ${drafts[0].offering?.name} → ${drafts[0].audience?.name}`);
      // Find a story if one exists
      const stories = drafts.flatMap((d: any) => d.stories || []);
      if (stories.length > 0) {
        STORY_ID = stories[0].id;
        console.log(`  Using story: ${STORY_ID.slice(0, 8)}...`);
      }
    }

    assert(!!OFFERING_ID, 'Have offering ID');
    assert(!!AUDIENCE_ID, 'Have audience ID');
  });

  // ═══════════════════════════════════════════════════════
  // 1. BASIC CHAT — EVERY PAGE CONTEXT
  // ═══════════════════════════════════════════════════════

  await test('Chat: Dashboard — general greeting', async () => {
    const r = await askMaria('Hi Maria, what can you help me with?', { page: 'dashboard' });
    assert(!!r.response, 'Got a response');
    assert(r.response.length > 10, 'Response is substantive');
    assert(r.needsPageContent === false, 'No page read needed for greeting');
    assert(r.action === null || r.action === undefined || r.action?.type === undefined,
      'No action taken for greeting', `action: ${JSON.stringify(r.action)}`);
  });

  await test('Chat: Dashboard — what should I do next?', async () => {
    const r = await askMaria('What should I work on next?', { page: 'dashboard' });
    assert(!!r.response, 'Got a response');
    // Maria might want to read the page to see what exists, OR give general guidance
    // Both are valid responses
    assert(r.response.length > 10, 'Response is substantive');
  });

  await test('Chat: Audiences page — methodology question', async () => {
    const r = await askMaria('What makes a good priority?', { page: 'audiences' });
    assert(!!r.response, 'Got a response');
    assert(r.needsPageContent === false, 'No page read for methodology question');
    // Should mention something about audience priorities
    const lower = r.response.toLowerCase();
    assert(
      lower.includes('priorit') || lower.includes('audience') || lower.includes('important') || lower.includes('desire'),
      'Response relates to priorities/audiences',
      `Response: "${r.response.slice(0, 120)}"`
    );
  });

  await test('Chat: Offerings page — general question', async () => {
    const r = await askMaria('How do offerings relate to audiences?', { page: 'offerings' });
    assert(!!r.response, 'Got a response');
    assert(r.needsPageContent === false, 'No page read for general question');
  });

  if (DRAFT_ID) {
    await test('Chat: Three Tier page — methodology question', async () => {
      const r = await askMaria('What is Tier 1 supposed to be?', { page: 'three-tier', draftId: DRAFT_ID });
      assert(!!r.response, 'Got a response');
      const lower = r.response.toLowerCase();
      assert(
        lower.includes('tier 1') || lower.includes('priority') || lower.includes('message') || lower.includes('top'),
        'Response discusses Tier 1',
        `Response: "${r.response.slice(0, 120)}"`
      );
    });
  }

  if (STORY_ID) {
    await test('Chat: Five Chapter page — methodology question', async () => {
      const r = await askMaria('What is Chapter 1 supposed to accomplish?', { page: 'five-chapter', storyId: STORY_ID });
      assert(!!r.response, 'Got a response');
      const lower = r.response.toLowerCase();
      assert(
        lower.includes('chapter 1') || lower.includes('category') || lower.includes('context') || lower.includes('problem'),
        'Response discusses Chapter 1 goal',
        `Response: "${r.response.slice(0, 150)}"`
      );
    });
  }

  // ═══════════════════════════════════════════════════════
  // 2. READ_PAGE TRIGGERING
  // ═══════════════════════════════════════════════════════

  await test('read_page: Triggered when user references specific content', async () => {
    const r = await askMaria('Can you look at the 2nd priority and tell me if it\'s specific enough?',
      { page: 'audiences', audienceId: AUDIENCE_ID });
    // Maria should want to read the page
    assert(r.needsPageContent === true, 'needsPageContent should be true',
      `needsPageContent: ${r.needsPageContent}, action: ${JSON.stringify(r.action)}`);
  });

  await test('read_page: Triggered for review request', async () => {
    const r = await askMaria('Review what I have so far and tell me what\'s weak.',
      { page: 'audiences', audienceId: AUDIENCE_ID });
    assert(r.needsPageContent === true, 'needsPageContent should be true for review',
      `needsPageContent: ${r.needsPageContent}, response: "${r.response?.slice(0, 80)}"`);
  });

  await test('read_page: NOT triggered for general methodology', async () => {
    const r = await askMaria('Explain the difference between Tier 2 and Tier 3.',
      { page: 'dashboard' });
    assert(r.needsPageContent === false, 'No page read for methodology explanation');
    assert(!!r.response, 'Got a direct response');
  });

  await test('read_page: NOT triggered for navigation help', async () => {
    const r = await askMaria('How do I create a new audience?', { page: 'dashboard' });
    assert(r.needsPageContent === false, 'No page read for navigation question');
  });

  if (DRAFT_ID) {
    await test('read_page: Triggered for "that first column"', async () => {
      const r = await askMaria('What do you think of that first column?',
        { page: 'three-tier', draftId: DRAFT_ID });
      assert(r.needsPageContent === true, 'Should read page for "that first column"',
        `needsPageContent: ${r.needsPageContent}`);
    });
  }

  if (STORY_ID) {
    await test('read_page: Triggered for chapter reference', async () => {
      const r = await askMaria('Is chapter 3 too long?',
        { page: 'five-chapter', storyId: STORY_ID });
      assert(r.needsPageContent === true, 'Should read page for chapter length question',
        `needsPageContent: ${r.needsPageContent}`);
    });
  }

  // ═══════════════════════════════════════════════════════
  // 3. PAGE CONTENT WITH [PAGE CONTENT] PREFIX
  // ═══════════════════════════════════════════════════════

  await test('Page content follow-up: Direct answer after reading', async () => {
    // Simulate what happens after read_page: the frontend fetches content and re-sends
    const content = await getPageContent({ page: 'audiences', audienceId: AUDIENCE_ID });
    assert(content.length > 0, 'Got page content');
    assert(content.includes('Audience:'), 'Content includes audience header');

    // Now send with [PAGE CONTENT] prefix — Maria should answer directly
    const r = await askMaria(
      `[PAGE CONTENT]\n${content}\n\n[USER QUESTION]\nAre these priorities in the right order?`,
      { page: 'audiences', audienceId: AUDIENCE_ID }
    );
    assert(r.needsPageContent === false, 'Should NOT request read_page again after receiving content');
    assert(!!r.response, 'Got a substantive response');
    assert(r.response.length > 20, 'Response engages with the content');
  });

  // ═══════════════════════════════════════════════════════
  // 4. PAGE CONTENT ENDPOINT — ALL CONTEXTS
  // ═══════════════════════════════════════════════════════

  await test('Page content: Dashboard', async () => {
    const content = await getPageContent({ page: 'dashboard' });
    assert(content.includes('Dashboard summary'), 'Has dashboard summary');
    assert(content.includes('audience'), 'Mentions audiences');
    assert(content.includes('offering'), 'Mentions offerings');
  });

  await test('Page content: Audiences listing', async () => {
    const content = await getPageContent({ page: 'audiences' });
    assert(content.includes('Audience:'), 'Has audience listing');
  });

  await test('Page content: Specific audience', async () => {
    const content = await getPageContent({ page: 'audiences', audienceId: AUDIENCE_ID });
    assert(content.includes('Audience:'), 'Has audience name');
    assert(content.includes('Priorities'), 'Has priorities section');
  });

  await test('Page content: Offerings listing', async () => {
    const content = await getPageContent({ page: 'offerings' });
    assert(content.includes('Offering:'), 'Has offering listing');
  });

  await test('Page content: Specific offering', async () => {
    const content = await getPageContent({ page: 'offerings', offeringId: OFFERING_ID });
    assert(content.includes('Offering:'), 'Has offering name');
    assert(content.includes('Capabilities'), 'Has capabilities section');
  });

  if (DRAFT_ID) {
    await test('Page content: Three Tier draft', async () => {
      const content = await getPageContent({ page: 'three-tier', draftId: DRAFT_ID });
      assert(content.includes('Three Tier Message'), 'Has three tier header');
      assert(content.includes('Tier 1'), 'Has Tier 1');
      assert(content.includes('Tier 2'), 'Has Tier 2');
    });
  }

  if (STORY_ID) {
    await test('Page content: Five Chapter story', async () => {
      const content = await getPageContent({ page: 'five-chapter', storyId: STORY_ID });
      assert(content.includes('Five Chapter Story'), 'Has story header');
      assert(content.includes('Chapter'), 'Has chapters');
    });
  }

  await test('Page content: Empty/unknown page', async () => {
    const content = await getPageContent({ page: 'nonexistent' });
    assert(content === 'No content available for this page.', 'Returns fallback message');
  });

  // ═══════════════════════════════════════════════════════
  // 5. ACTION DISPATCH
  // ═══════════════════════════════════════════════════════

  await test('Action: Add priorities via Maria', async () => {
    const r = await askMaria(
      'Add a priority: "Reduced compliance burden for clinical teams"',
      { page: 'audiences', audienceId: AUDIENCE_ID }
    );
    // Maria should either take the add_priorities action directly, or ask for clarification
    if (r.action?.type === 'add_priorities') {
      assert(r.refreshNeeded === true, 'Refresh needed after adding priorities');
      assert(r.actionResult?.includes('Added'), 'Action result confirms addition',
        `actionResult: ${r.actionResult}`);
    } else if (r.needsPageContent) {
      assert(true, 'Maria wants to read page first (acceptable)');
    } else {
      // Maria responded conversationally — also acceptable if she confirms what she'll do
      assert(!!r.response, 'Got conversational response');
      console.log(`    (Maria chose to respond conversationally: "${r.response.slice(0, 80)}")`);
    }
  });

  await test('Action: Edit priorities via Maria', async () => {
    // First read the page so Maria knows what's there
    const content = await getPageContent({ page: 'audiences', audienceId: AUDIENCE_ID });
    const r = await askMaria(
      `[PAGE CONTENT]\n${content}\n\n[USER QUESTION]\nRename the first priority to "Rapid diagnostic turnaround"`,
      { page: 'audiences', audienceId: AUDIENCE_ID }
    );
    if (r.action?.type === 'edit_priorities') {
      assert(r.refreshNeeded === true, 'Refresh needed after edit');
      assert(r.actionResult?.includes('Updated'), 'Action result confirms edit',
        `actionResult: ${r.actionResult}`);
    } else if (r.needsPageContent) {
      assert(true, 'Maria wants to read page first (acceptable)');
    } else {
      assert(!!r.response, 'Got response');
      console.log(`    (Maria responded: "${r.response.slice(0, 100)}")`);
    }
  });

  await test('Action: Delete priorities via Maria', async () => {
    // Add a throwaway priority first
    await askMaria(
      'Add a priority: "Throwaway test priority for deletion"',
      { page: 'audiences', audienceId: AUDIENCE_ID }
    );
    const content = await getPageContent({ page: 'audiences', audienceId: AUDIENCE_ID });
    const r = await askMaria(
      `[PAGE CONTENT]\n${content}\n\n[USER QUESTION]\nDelete the last priority — it was a test.`,
      { page: 'audiences', audienceId: AUDIENCE_ID }
    );
    if (r.action?.type === 'delete_priorities') {
      assert(r.refreshNeeded === true, 'Refresh needed after delete');
      assert(r.actionResult?.includes('Deleted'), 'Action result confirms deletion',
        `actionResult: ${r.actionResult}`);
    } else if (r.needsPageContent) {
      assert(true, 'Maria wants to read page first (acceptable)');
    } else {
      assert(!!r.response, 'Got response');
      console.log(`    (Maria responded: "${r.response.slice(0, 100)}")`);
    }
  });

  await test('Action: Reorder priorities via Maria', async () => {
    const content = await getPageContent({ page: 'audiences', audienceId: AUDIENCE_ID });
    // Count how many priorities exist
    const priCount = (content.match(/^\s+\d+\./gm) || []).length;
    if (priCount >= 2) {
      const r = await askMaria(
        `[PAGE CONTENT]\n${content}\n\n[USER QUESTION]\nSwap the first two priorities — make #2 the new #1 and #1 the new #2.`,
        { page: 'audiences', audienceId: AUDIENCE_ID }
      );
      if (r.action?.type === 'reorder_priorities') {
        assert(r.refreshNeeded === true, 'Refresh needed after reorder');
        assert(r.actionResult?.includes('Reordered'), 'Action result confirms reorder',
          `actionResult: ${r.actionResult}`);
      } else if (r.needsPageContent) {
        assert(true, 'Maria wants to read page first (acceptable)');
      } else {
        assert(!!r.response, 'Got response');
        console.log(`    (Maria responded: "${r.response.slice(0, 100)}")`);
      }
    } else {
      assert(true, `Skipped — only ${priCount} priorities`);
    }
  });

  if (STORY_ID) {
    await test('Action: Copy edit request', async () => {
      // First get page content so Maria has context
      const content = await getPageContent({ page: 'five-chapter', storyId: STORY_ID });
      const r = await askMaria(
        `[PAGE CONTENT]\n${content}\n\n[USER QUESTION]\nMake the opening sentence shorter and more direct.`,
        { page: 'five-chapter', storyId: STORY_ID }
      );
      if (r.action?.type === 'copy_edit') {
        assert(r.refreshNeeded === true, 'Refresh needed after copy edit');
        assert(r.actionResult === 'Applied copy edit', 'Copy edit applied');
      } else {
        // Maria might respond conversationally with guidance
        assert(!!r.response, 'Got response (may not have taken action)');
        console.log(`    (Maria responded: "${r.response.slice(0, 80)}")`);
      }
    });
  }

  // ═══════════════════════════════════════════════════════
  // 6. CONVERSATION HISTORY
  // ═══════════════════════════════════════════════════════

  await test('History: Maria remembers conversation context', async () => {
    // First message
    const r1 = await askMaria('I\'m working on messaging for oncologists.', { page: 'dashboard' });
    assert(!!r1.response, 'Got first response');

    // Second message referencing the first
    const history = [
      { role: 'user', content: 'I\'m working on messaging for oncologists.' },
      { role: 'assistant', content: r1.response },
    ];
    const r2 = await askMaria('What should my first priority focus on for that audience?',
      { page: 'dashboard' }, history);
    assert(!!r2.response, 'Got follow-up response');
    const lower = r2.response.toLowerCase();
    assert(
      lower.includes('oncolog') || lower.includes('priorit') || lower.includes('audience') || lower.includes('clinical'),
      'Follow-up references oncology or priorities context',
      `Response: "${r2.response.slice(0, 150)}"`
    );
  });

  await test('History: Multi-turn conversation stays coherent', async () => {
    const history: any[] = [];

    const r1 = await askMaria('I sell diagnostic software to hospital labs.', { page: 'dashboard' }, history);
    history.push({ role: 'user', content: 'I sell diagnostic software to hospital labs.' });
    history.push({ role: 'assistant', content: r1.response });

    const r2 = await askMaria('My main audience is pathologists.', { page: 'dashboard' }, history);
    history.push({ role: 'user', content: 'My main audience is pathologists.' });
    history.push({ role: 'assistant', content: r2.response });

    const r3 = await askMaria('Given all that, what kind of priority statement would work?',
      { page: 'dashboard' }, history);
    assert(!!r3.response, 'Got response to multi-turn');
    const lower = r3.response.toLowerCase();
    assert(
      lower.includes('patholog') || lower.includes('diagnostic') || lower.includes('lab') || lower.includes('hospital'),
      'Multi-turn response retains full context',
      `Response: "${r3.response.slice(0, 150)}"`
    );
  });

  // ═══════════════════════════════════════════════════════
  // 7. RESPONSE QUALITY
  // ═══════════════════════════════════════════════════════

  await test('Quality: No internal IDs in response', async () => {
    const r = await askMaria('Tell me about my audiences and offerings.',
      { page: 'dashboard', audienceId: AUDIENCE_ID, offeringId: OFFERING_ID });
    // Maria might read the page or respond generally
    if (r.response) {
      const hasId = /\b[a-z0-9]{20,}\b/.test(r.response) || /clu[a-z0-9]{20,}/.test(r.response);
      assert(!hasId, 'No internal IDs in response', `Response: "${r.response.slice(0, 150)}"`);
    }
  });

  await test('Quality: Simple question gets concise response', async () => {
    const r = await askMaria('What page am I on?', { page: 'offerings' });
    const sentences = r.response.split(/[.!?]+/).filter((s: string) => s.trim().length > 5);
    assert(sentences.length <= 4, `Simple question gets concise answer (${sentences.length} sentences)`,
      `Response: "${r.response.slice(0, 200)}"`);
  });

  await test('Quality: Knows page context — dashboard', async () => {
    const r = await askMaria('Where am I right now?', { page: 'dashboard' });
    const lower = r.response.toLowerCase();
    assert(
      lower.includes('dashboard'),
      'Maria correctly identifies dashboard page',
      `Response: "${r.response.slice(0, 120)}"`
    );
  });

  await test('Quality: Knows page context — audiences', async () => {
    const r = await askMaria('What page am I on?', { page: 'audiences' });
    const lower = r.response.toLowerCase();
    assert(
      lower.includes('audience'),
      'Maria correctly identifies audiences page',
      `Response: "${r.response.slice(0, 120)}"`
    );
  });

  await test('Quality: Never says "I can\'t do that"', async () => {
    const r = await askMaria('Can you send an email for me?', { page: 'dashboard' });
    assert(!!r.response, 'Got a response');
    assert(!r.response.toLowerCase().includes("i can't do that"),
      'Does not say "I can\'t do that"',
      `Response: "${r.response.slice(0, 120)}"`);
  });

  // ═══════════════════════════════════════════════════════
  // 8. METHODOLOGY DEPTH — CANONICAL KNOWLEDGE
  // ═══════════════════════════════════════════════════════

  await test('Methodology: Ken\'s Voice explanation', async () => {
    const r = await askMaria('What is Ken\'s Voice and why does it matter?', { page: 'dashboard' });
    assert(!!r.response, 'Got response');
    const lower = r.response.toLowerCase();
    assert(
      lower.includes('voice') || lower.includes('direct') || lower.includes('plain') || lower.includes('honest'),
      'Response describes Ken\'s Voice style',
      `Response: "${r.response.slice(0, 150)}"`
    );
  });

  await test('Methodology: Chapter 4 purpose', async () => {
    const r = await askMaria('What is the purpose of Chapter 4?', { page: 'dashboard' });
    const lower = r.response.toLowerCase();
    console.log(`    Response: "${r.response.slice(0, 200)}"`);
    assert(lower.includes('proof') || lower.includes('not alone'), 'Mentions proof or "You\'re Not Alone"');
    assert(lower.includes('similar') || lower.includes('succeed') || lower.includes('confidence') || lower.includes('organization'),
      'Mentions similar orgs succeeding / giving confidence',
      `Response: "${r.response.slice(0, 200)}"`);
  });

  await test('Methodology: Chapter 2 vs Chapter 4 boundaries', async () => {
    const r = await askMaria('What goes in Chapter 2 vs Chapter 4?', { page: 'dashboard' });
    const lower = r.response.toLowerCase();
    console.log(`    Response: "${r.response.slice(0, 250)}"`);
    // Ch2 = value/advice, Ch4 = proof. Credentials belong in Ch4, not Ch2.
    assert(lower.includes('value') || lower.includes('advice') || lower.includes('version'),
      'Ch2 described as value/advice',
      `Response: "${r.response.slice(0, 200)}"`);
    assert(lower.includes('proof') || lower.includes('evidence') || lower.includes('similar'),
      'Ch4 described as proof',
      `Response: "${r.response.slice(0, 200)}"`);
  });

  await test('Methodology: Chapter 1 — no company name rule', async () => {
    const r = await askMaria('Can I mention my company name in Chapter 1?', { page: 'dashboard' });
    const lower = r.response.toLowerCase();
    console.log(`    Response: "${r.response.slice(0, 200)}"`);
    assert(lower.includes('no') || lower.includes('never') || lower.includes('don\'t') || lower.includes('category'),
      'Says no — Ch1 is category-level, no company mention',
      `Response: "${r.response.slice(0, 200)}"`);
  });

  await test('Methodology: Tier 2 vs Tier 3 classification — "faster and cheaper"', async () => {
    const r = await askMaria(
      'Is "faster and cheaper" more a Tier 2 thing or a Tier 3 proof point? Why?',
      { page: 'dashboard' }
    );
    const lower = r.response.toLowerCase();
    console.log(`    Response: "${r.response.slice(0, 300)}"`);
    // Must say Tier 2 (value claim), NOT Tier 3 (proof requires verifiable data)
    assert(lower.includes('tier 2') || lower.includes('value claim'),
      'Correctly identifies as Tier 2 / value claim',
      `Response: "${r.response.slice(0, 200)}"`);
    assert(lower.includes('comparative') || lower.includes('verify') || lower.includes('skeptic') || lower.includes('specific'),
      'Explains WHY — comparative adjectives aren\'t proof / can\'t be verified',
      `Response: "${r.response.slice(0, 200)}"`);
  });

  await test('Methodology: Tier 3 proof standard — good vs bad examples', async () => {
    const r = await askMaria(
      'Give me an example of a good Tier 3 proof point and a bad one.',
      { page: 'dashboard' }
    );
    const lower = r.response.toLowerCase();
    console.log(`    Response: "${r.response.slice(0, 300)}"`);
    // Good: should include numbers, names, or measurable outcomes
    // Bad: should flag value claims or comparative adjectives
    assert(lower.includes('$') || lower.includes('number') || lower.includes('measur') || lower.includes('fda') || lower.includes('specific'),
      'Good example includes specific/measurable data',
      `Response: "${r.response.slice(0, 250)}"`);
    assert(lower.includes('faster') || lower.includes('better') || lower.includes('easier') || lower.includes('value claim') || lower.includes('comparative'),
      'Bad example identifies value claims or comparative adjectives',
      `Response: "${r.response.slice(0, 250)}"`);
  });

  await test('Methodology: Motivating factor purpose', async () => {
    const r = await askMaria('What is a motivating factor and why do I need it?', { page: 'dashboard' });
    const lower = r.response.toLowerCase();
    console.log(`    Response: "${r.response.slice(0, 200)}"`);
    assert(lower.includes('why') || lower.includes('important') || lower.includes('deeper'),
      'Explains MF as the "why" behind a priority',
      `Response: "${r.response.slice(0, 200)}"`);
    assert(lower.includes('five chapter') || lower.includes('story') || lower.includes('required') || lower.includes('generat'),
      'Mentions MF is required for Five Chapter Story generation',
      `Response: "${r.response.slice(0, 200)}"`);
  });

  await test('Methodology: Priority pull direction', async () => {
    const r = await askMaria(
      'When mapping priorities to capabilities, which direction does it go?',
      { page: 'dashboard' }
    );
    const lower = r.response.toLowerCase();
    console.log(`    Response: "${r.response.slice(0, 200)}"`);
    assert(lower.includes('priority') && (lower.includes('capabilit') || lower.includes('pull')),
      'Mentions priority → capability direction',
      `Response: "${r.response.slice(0, 200)}"`);
  });

  await test('Methodology: Tier 2 column ordering — first column', async () => {
    const r = await askMaria('What should the first Tier 2 column typically be about?', { page: 'dashboard' });
    const lower = r.response.toLowerCase();
    console.log(`    Response: "${r.response.slice(0, 200)}"`);
    assert(lower.includes('audience focus') || lower.includes('exist for') || lower.includes('built for') || lower.includes('focused on'),
      'First column = audience focus, not credentials',
      `Response: "${r.response.slice(0, 200)}"`);
  });

  await test('Methodology: Chapter 5 — what NOT to write', async () => {
    const r = await askMaria('Any common mistakes in Chapter 5?', { page: 'dashboard' });
    const lower = r.response.toLowerCase();
    console.log(`    Response: "${r.response.slice(0, 200)}"`);
    assert(
      lower.includes('vague') || lower.includes('filler') || lower.includes('that\'s it') || lower.includes('empty') || lower.includes('concrete'),
      'Warns against vague/filler/empty closers',
      `Response: "${r.response.slice(0, 200)}"`);
  });

  await test('Methodology: Canonical Tier format', async () => {
    const r = await askMaria('What format should a Tier 1 or Tier 2 statement follow?', { page: 'dashboard' });
    const lower = r.response.toLowerCase();
    console.log(`    Response: "${r.response.slice(0, 200)}"`);
    assert(lower.includes('you get') || lower.includes('priority') || lower.includes('because') || lower.includes('canonical'),
      'References the canonical format: You get [priority] because [differentiator]',
      `Response: "${r.response.slice(0, 200)}"`);
    assert(lower.includes('20 word') || lower.includes('under 20'),
      'Mentions the 20-word limit',
      `Response: "${r.response.slice(0, 200)}"`);
  });

  await test('Methodology: Audience-thinks test for Chapter 1', async () => {
    const r = await askMaria('How do I know if my Chapter 1 is working?', { page: 'dashboard' });
    const lower = r.response.toLowerCase();
    console.log(`    Response: "${r.response.slice(0, 250)}"`);
    assert(
      lower.includes('status quo') || lower.includes('uncomfortable') || lower.includes('need to do something') || lower.includes('didn\'t need'),
      'References the audience-thinks test: make status quo unattractive',
      `Response: "${r.response.slice(0, 200)}"`);
  });

  await test('Methodology: Priority vs capability', async () => {
    const r = await askMaria('What is the difference between a priority and a capability?', { page: 'dashboard' });
    assert(!!r.response, 'Got response');
    const lower = r.response.toLowerCase();
    assert(
      lower.includes('priorit') && (lower.includes('capabilit') || lower.includes('audience') || lower.includes('offering')),
      'Response distinguishes priorities from capabilities',
      `Response: "${r.response.slice(0, 200)}"`
    );
  });

  await test('Methodology: Three Tier structure overview', async () => {
    const r = await askMaria('How do the three tiers relate to each other?', { page: 'dashboard' });
    assert(!!r.response, 'Got response');
    const lower = r.response.toLowerCase();
    assert(
      lower.includes('tier 1') && lower.includes('tier 2'),
      'Mentions Tier 1 and Tier 2 specifically',
      `Response: "${r.response.slice(0, 200)}"`
    );
  });

  // ═══════════════════════════════════════════════════════
  // 9. EDGE CASES
  // ═══════════════════════════════════════════════════════

  await test('Edge: Empty message rejected', async () => {
    try {
      await req('POST', '/assistant/message', { message: '', context: { page: 'dashboard' } });
      assert(false, 'Should have returned 400');
    } catch (e: any) {
      assert(e.message.includes('400'), 'Returns 400 for empty message');
    }
  });

  await test('Edge: No context provided', async () => {
    const r = await askMaria('Hello!', {});
    assert(!!r.response, 'Responds even with empty context');
  });

  await test('Edge: Unknown page context', async () => {
    const r = await askMaria('What can I do here?', { page: 'some_random_page' });
    assert(!!r.response, 'Responds even with unknown page');
  });

  await test('Edge: Very long message', async () => {
    const longMsg = 'I have a question about messaging. '.repeat(50);
    const r = await askMaria(longMsg, { page: 'dashboard' });
    assert(!!r.response, 'Handles long messages');
  });

  // ═══════════════════════════════════════════════════════
  // 10. CLEAR HISTORY
  // ═══════════════════════════════════════════════════════

  await test('History: Clear endpoint works', async () => {
    const r = await req('DELETE', '/assistant/history');
    assert(r.success === true, 'History cleared');
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
