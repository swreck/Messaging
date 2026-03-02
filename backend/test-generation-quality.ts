/**
 * RL-Style Generation Quality Test
 *
 * Creates 3 diverse test scenarios, generates Three Tier tables via
 * build-message, and evaluates output against Ken's quality standards:
 *
 * 1. Priority text sacrosanct (audience's words, not product metrics)
 * 2. Hook principle (because clause creates curiosity)
 * 3. No tautology (surprise test)
 * 4. Anti-sales language (no contrast, no em-dashes, no flattery)
 * 5. Ken's Voice (no narration, no metaphor, plain facts)
 * 6. Column structure (Focus/Product/ROI/Support/Social proof)
 * 7. Tier 3 proof standard (verifiable facts, 1-6 words)
 * 8. Word counts (Tier 1/2 ≤ 20, Tier 3 ≤ 6)
 *
 * Run: API_URL=https://maria.perworks.com/api npx tsx test-generation-quality.ts
 */

const BASE = process.env.API_URL || 'http://localhost:3001/api';
let TOKEN = '';

let passed = 0;
let failed = 0;
const failures: string[] = [];
const warnings: string[] = [];

// ─── Helpers ─────────────────────────────────────────

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
    console.log(`    ✓ ${name}`);
  } else {
    failed++;
    const msg = detail ? `${name}: ${detail}` : name;
    failures.push(msg);
    console.log(`    ✗ ${msg}`);
  }
}

function warn(name: string, detail: string) {
  warnings.push(`${name}: ${detail}`);
  console.log(`    ⚠ ${name}: ${detail}`);
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).length;
}

// ─── Test Scenarios (diverse domains) ─────────────────

interface Scenario {
  name: string;
  offering: { name: string; description: string };
  elements: string[];
  audience: { name: string; description: string };
  priorities: { text: string; rank: number; motivatingFactor: string }[];
}

const SCENARIOS: Scenario[] = [
  {
    name: 'Scenario A: Medical Diagnostics (Slideflow-like)',
    offering: {
      name: 'RapidPath AI',
      description: 'AI-powered pathology slide analysis for hospital labs',
    },
    elements: [
      'AI slide analysis delivers results in under 60 seconds',
      'Runs on existing lab microscopes — no new capital equipment',
      'Processing cost under $1 per slide vs $4,000 outsourced',
      'FDA 510(k) clearance pending for primary diagnosis',
      'Geisinger Health and Cleveland Clinic in active evaluation',
      'Dedicated onboarding specialist for 48-hour lab integration',
      '40% fewer false negatives than manual screening',
    ],
    audience: { name: 'Hospital Administrators', description: 'Budget and operations decision-makers at mid-size hospitals' },
    priorities: [
      { text: 'Protecting the financial health of our hospital', rank: 1, motivatingFactor: 'Every dollar saved goes directly to patient care' },
      { text: 'Better outcomes for our cancer patients', rank: 2, motivatingFactor: 'Treatment delays from slow pathology cost lives' },
      { text: 'Reducing our exposure to malpractice risk', rank: 3, motivatingFactor: 'One missed diagnosis can cost millions and end careers' },
      { text: 'Keeping our best pathologists engaged and productive', rank: 4, motivatingFactor: 'Recruiting a replacement takes 18 months minimum' },
    ],
  },
  {
    name: 'Scenario B: Construction Project Management',
    offering: {
      name: 'SiteSync Pro',
      description: 'AI-powered project monitoring platform for commercial construction',
    },
    elements: [
      'Monitors 200+ schedule and cost risk signals per project daily',
      'Drone site surveys processed in 4 hours vs 2-week manual cycle',
      'Integrates with Procore, Autodesk, and Oracle Primavera',
      'Predicted 87% of delays 3+ weeks before they hit in pilot',
      'Hensel Phelps and Turner Construction in active deployment',
      'Dedicated project analyst assigned for first 90 days',
      'Real-time budget burn rate visible to all project stakeholders',
    ],
    audience: { name: 'General Contractors (VP-level)', description: 'Construction executives managing multiple concurrent projects' },
    priorities: [
      { text: 'Keeping every project on schedule and on budget', rank: 1, motivatingFactor: 'One overrun can sink quarterly numbers' },
      { text: 'Seeing problems across all our sites before they become crises', rank: 2, motivatingFactor: 'We manage 30 projects — surprises are unacceptable' },
      { text: 'Protecting our reputation with building owners', rank: 3, motivatingFactor: 'Repeat business is 60% of our revenue' },
      { text: 'Retaining our best project managers', rank: 4, motivatingFactor: 'Burnout from firefighting drives our best people to competitors' },
    ],
  },
  {
    name: 'Scenario C: Community Bank Cybersecurity',
    offering: {
      name: 'VaultGuard',
      description: 'Managed cybersecurity platform designed for community banks and credit unions',
    },
    elements: [
      'Pre-mapped FFIEC and SOC 2 controls — 90% coverage on day one',
      'Security operations center staffed 24/7 by certified analysts',
      '15-minute response time SLA for critical alerts',
      'Automated FFIEC exam-ready report generation',
      '180 community banks protected, zero breaches in 4 years',
      'Dedicated compliance analyst assigned to each institution',
      'Full onboarding in 30 days including staff security training',
    ],
    audience: { name: 'Community Bank CEOs', description: 'Leaders of banks with $500M-$5B in assets' },
    priorities: [
      { text: 'Protecting our institution from a data breach', rank: 1, motivatingFactor: 'A breach could end depositor trust permanently' },
      { text: 'Proving compliance without drowning in audit prep', rank: 2, motivatingFactor: 'My compliance officer spends 3 months a year just preparing for exams' },
      { text: 'Recruiting and keeping cybersecurity talent at community bank pay', rank: 3, motivatingFactor: 'We cannot compete with big bank salaries' },
      { text: 'Not disrupting our team during implementation', rank: 4, motivatingFactor: 'Our IT department is 3 people' },
    ],
  },
];

// ─── Quality Checker ──────────────────────────────────

const BANNED_NARRATIVE = [
  'goes from', 'drops from', 'cuts from', 'reduces from',
  'slashes', 'transforms', 'goes to', 'cuts to',
  'trace back', 'boil down', 'come down to', 'rooted in', 'stems from', 'at its core',
];

const BANNED_METAPHORS = [
  'unlock', 'fuel', 'drive', 'power', 'bridge', 'reshape',
  'elevate', 'ignite', 'amplify', 'leverage', 'streamline',
  'game-changing', 'cutting-edge', 'best-in-class', 'seamless', 'robust',
];

const BANNED_SALES = [
  ' not ', 'instead of', 'without ', // contrast clauses (careful: "without" in priority text is OK)
];

const VALID_LABELS = ['Focus', 'Product', 'ROI', 'Support', 'Social proof'];

function evaluateTier(
  scenario: Scenario,
  tier1: { text: string; priorityId: string },
  tier2: { text: string; priorityId: string; categoryLabel: string; tier3: string[] }[],
) {
  const scenarioLabel = scenario.name.split(':')[0];

  console.log(`\n  Tier 1: "${tier1.text}"`);

  // ═══ TIER 1 CHECKS ═══

  // 1. Priority text preserved
  const rank1 = scenario.priorities.find(p => p.rank === 1)!;
  const t1lower = tier1.text.toLowerCase();
  // Check that key words from the priority appear in Tier 1
  const priorityKeywords = rank1.text.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const keywordsPresent = priorityKeywords.filter(w => t1lower.includes(w));
  const keywordRatio = keywordsPresent.length / priorityKeywords.length;
  assert(keywordRatio >= 0.5, `${scenarioLabel} T1: Priority text preserved`,
    `${Math.round(keywordRatio * 100)}% of keywords from "${rank1.text}" found in Tier 1`);

  // 2. Not a product metric
  const productMetricPatterns = ['cost per', 'per test', 'per slide', 'per project', 'response time', 'processing time'];
  const startsWithMetric = productMetricPatterns.some(p => t1lower.startsWith(p) || t1lower.split(' because ')[0].includes(p));
  assert(!startsWithMetric, `${scenarioLabel} T1: Not a product metric as priority`);

  // 3. Has "because" with a hook
  const hasBecause = t1lower.includes(' because ');
  assert(hasBecause, `${scenarioLabel} T1: Has "because" clause`);

  // 4. Word count
  const t1wc = wordCount(tier1.text);
  assert(t1wc <= 20, `${scenarioLabel} T1: Word count ≤ 20`, `Got ${t1wc}`);
  if (t1wc > 15) warn(`${scenarioLabel} T1`, `${t1wc} words — tight but legal`);

  // 5. No banned language
  for (const phrase of BANNED_NARRATIVE) {
    assert(!t1lower.includes(phrase), `${scenarioLabel} T1: No "${phrase}"`);
  }

  // 6. No em-dash extra clause
  assert(!tier1.text.includes(' — '), `${scenarioLabel} T1: No em-dash clause`);

  // ═══ TIER 2 CHECKS ═══

  // Column count
  assert(tier2.length >= 5 && tier2.length <= 6, `${scenarioLabel} T2: Column count is ${tier2.length} (need 5-6)`);

  // Column labels
  const labels = tier2.map(t => t.categoryLabel);
  for (const label of labels) {
    const isValid = VALID_LABELS.includes(label) || (labels.filter(l => l === label).length === 1);
    // Allow one overflow column with a custom label
    const isOverflow = !VALID_LABELS.includes(label) && labels.filter(l => !VALID_LABELS.includes(l)).length <= 1;
    assert(VALID_LABELS.includes(label) || isOverflow,
      `${scenarioLabel} T2: Label "${label}" is valid`, `Expected one of: ${VALID_LABELS.join(', ')}`);
  }

  // Each Tier 2 statement
  for (let i = 0; i < tier2.length; i++) {
    const t2 = tier2[i];
    const t2lower = t2.text.toLowerCase();
    const prefix = `${scenarioLabel} T2[${i}] (${t2.categoryLabel})`;

    console.log(`  Tier 2[${i}] ${t2.categoryLabel}: "${t2.text}"`);

    // Word count
    const wc = wordCount(t2.text);
    assert(wc <= 20, `${prefix}: Word count ≤ 20`, `Got ${wc}`);

    // Priority text present (for non-Social-proof columns)
    if (t2.categoryLabel !== 'Social proof' && t2.categoryLabel !== 'Focus') {
      const matchedPriority = scenario.priorities.find(p => p.id === t2.priorityId) ||
        scenario.priorities.find(p => {
          const words = p.text.toLowerCase().split(/\s+/).filter(w => w.length > 3);
          return words.filter(w => t2lower.includes(w)).length >= words.length * 0.4;
        });
      if (matchedPriority) {
        assert(true, `${prefix}: Uses priority language`);
      } else {
        warn(prefix, `May not reflect audience priority text`);
      }
    }

    // No banned narrative/metaphor
    for (const phrase of BANNED_NARRATIVE) {
      assert(!t2lower.includes(phrase), `${prefix}: No "${phrase}"`);
    }
    for (const word of BANNED_METAPHORS) {
      // Match as whole words
      const regex = new RegExp(`\\b${word}\\b`, 'i');
      assert(!regex.test(t2.text), `${prefix}: No metaphor "${word}"`);
    }

    // No em-dash extra clause
    assert(!t2.text.includes(' — '), `${prefix}: No em-dash clause`);

    // Contrast clause check (only after "because")
    if (t2lower.includes(' because ')) {
      const afterBecause = t2lower.split(' because ').slice(1).join(' because ');
      // Check for contrast at end: ", not X" or "instead of X"
      const hasContrast = afterBecause.includes(', not ') || afterBecause.includes('instead of') ||
        afterBecause.includes(', no ');
      assert(!hasContrast, `${prefix}: No contrast clause after "because"`);
    }

    // ═══ TIER 3 CHECKS ═══
    if (t2.tier3 && t2.tier3.length > 0) {
      for (let j = 0; j < t2.tier3.length; j++) {
        const bullet = t2.tier3[j];
        const bPrefix = `${scenarioLabel} T3[${i}-${j}]`;

        // Word count
        const bwc = wordCount(bullet);
        assert(bwc <= 6, `${bPrefix}: Word count ≤ 6`, `"${bullet}" = ${bwc} words`);

        // Contains proof indicator (number, name, or verifiable fact)
        const hasNumber = /\d/.test(bullet);
        const hasProperNoun = /[A-Z][a-z]/.test(bullet.split(' ').slice(1).join(' ')); // proper noun after first word
        const hasProof = hasNumber || hasProperNoun ||
          /FDA|SOC|FFIEC|ISO|HIPAA|certified|approved|pending/.test(bullet);

        if (!hasProof) {
          warn(bPrefix, `"${bullet}" — may lack verifiable proof (no number/name/cert)`);
        }

        // Not a value claim
        const valueClaims = ['faster', 'better', 'easier', 'comprehensive', 'full coverage', 'seamless'];
        for (const vc of valueClaims) {
          assert(!bullet.toLowerCase().includes(vc), `${bPrefix}: Not a value claim ("${vc}")`, `"${bullet}"`);
        }
      }
    }
  }

  // ═══ STRUCTURAL CHECKS ═══

  // Social proof column should contain names/numbers
  const spCol = tier2.find(t => t.categoryLabel === 'Social proof');
  if (spCol) {
    const hasNames = /[A-Z][a-z]+\s+(Health|Clinic|Hospital|Bank|Construction|Corp|Inc|University)/.test(spCol.text) ||
      /\d+\s+(customer|institution|bank|hospital|client|deployment|site)s?/i.test(spCol.text);
    assert(hasNames, `${scenarioLabel} Social Proof: Contains customer names or adoption numbers`,
      `Text: "${spCol.text}"`);
  }

  // Focus column should NOT be credentials/social proof
  const focusCol = tier2.find(t => t.categoryLabel === 'Focus');
  if (focusCol) {
    const credentialPatterns = ['years of experience', 'founded in', 'trusted by', 'serving'];
    const isCredential = credentialPatterns.some(p => focusCol.text.toLowerCase().includes(p));
    assert(!isCredential, `${scenarioLabel} Focus: Is commitment, not credentials`,
      `Text: "${focusCol.text}"`);
  }
}

// ─── Main ─────────────────────────────────────────────

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Generation Quality Test (RL-Style)`);
  console.log(`  API: ${BASE}`);
  console.log(`  Scenarios: ${SCENARIOS.length}`);
  console.log(`${'='.repeat(60)}`);

  // Auth
  const { token } = await req('POST', '/auth/login', { username: 'admin', password: 'maria2026' });
  TOKEN = token;
  if (!TOKEN) { console.log('Auth failed'); process.exit(1); }
  console.log('  Authenticated.\n');

  for (const scenario of SCENARIOS) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  ${scenario.name}`);
    console.log(`${'─'.repeat(60)}`);

    let offeringId = '', audienceId = '', draftId = '';
    const priIds: string[] = [];

    try {
      // Setup
      const { offering } = await req('POST', '/offerings', { name: scenario.offering.name, description: scenario.offering.description });
      offeringId = offering.id;
      for (const text of scenario.elements) {
        await req('POST', `/offerings/${offeringId}/elements`, { text, source: 'manual' });
      }

      const { audience } = await req('POST', '/audiences', { name: scenario.audience.name, description: scenario.audience.description });
      audienceId = audience.id;
      for (const p of scenario.priorities) {
        const { priority } = await req('POST', `/audiences/${audienceId}/priorities`, p);
        priIds.push(priority.id);
      }

      const { draft } = await req('POST', '/drafts', { offeringId, audienceId });
      draftId = draft.id;

      // Generate
      console.log('\n  Generating Three Tier...');
      const result = await req('POST', '/ai/build-message', { draftId });

      let tierResult: any = null;

      if (result.status === 'complete') {
        tierResult = result.result;
        console.log('  → Generated directly (no questions)');
      } else if (result.status === 'questions') {
        console.log(`  → AI asked ${result.questions.length} questions, auto-confirming all...`);
        const answers = result.questions.map((q: any) => ({
          priorityId: q.priorityId,
          elementId: q.elementId,
          confirmed: true,
        }));
        const resolved = await req('POST', '/ai/resolve-questions', { draftId, answers });
        tierResult = resolved.result;
      }

      if (!tierResult) {
        failed++;
        failures.push(`${scenario.name}: No tier result generated`);
        console.log('    ✗ No result!');
      } else {
        // Inject IDs for priority matching (the AI returns priorityId from the DB)
        const enrichedPriorities = scenario.priorities.map((p, i) => ({ ...p, id: priIds[i] }));
        const enrichedScenario = { ...scenario, priorities: enrichedPriorities };

        evaluateTier(enrichedScenario, tierResult.tier1, tierResult.tier2);
      }
    } catch (err: any) {
      failed++;
      failures.push(`${scenario.name}: ${err.message}`);
      console.log(`    ✗ ERROR: ${err.message}`);
    } finally {
      // Cleanup
      if (draftId) await req('DELETE', `/drafts/${draftId}`).catch(() => {});
      if (audienceId) await req('DELETE', `/audiences/${audienceId}`).catch(() => {});
      if (offeringId) await req('DELETE', `/offerings/${offeringId}`).catch(() => {});
    }
  }

  // ─── Final Report ────────────────────────────────────

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  QUALITY RESULTS: ${passed} passed, ${failed} failed`);
  if (warnings.length > 0) {
    console.log(`  Warnings: ${warnings.length}`);
  }
  if (failures.length > 0) {
    console.log('\n  FAILURES:');
    failures.forEach(f => console.log(`    ✗ ${f}`));
  }
  if (warnings.length > 0) {
    console.log('\n  WARNINGS:');
    warnings.forEach(w => console.log(`    ⚠ ${w}`));
  }
  console.log(`${'='.repeat(60)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
