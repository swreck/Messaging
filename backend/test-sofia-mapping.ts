// Fast iteration harness: runs MAPPING_SYSTEM against Sofia's priority/differentiator
// data directly. Prints what mapping emits so I can tighten the prompt until
// the Rank 1 priority's weak-tenure match becomes a gapDescription.
//
// Run: npx tsx test-sofia-mapping.ts

import 'dotenv/config';
import { MAPPING_SYSTEM } from './src/prompts/mapping.js';
import { callAIWithJSON } from './src/services/ai.js';

// Sofia's actual extracted data from her Apr 23 guided flow walk.
// Priorities ranked by importance, drivers as Maria extracted them.
const SOFIA_PRIORITIES = [
  {
    id: 'p1',
    rank: 1,
    text: 'Financial sustainability after the donor loss and layoffs — can this organization survive another shock?',
    driver: 'After the biggest donor pulled out and layoffs followed, board members personally own the diversification risk they approved. They are asking whether the organization can function without that donor.',
  },
  {
    id: 'p2',
    rank: 2,
    text: "Confidence that the model actually works — proof that their time and money is producing real outcomes, not just activity",
    driver: 'A board that approved funding wants to see the model delivers — outcomes they can cite to their own networks to justify continued investment.',
  },
  {
    id: 'p3',
    rank: 3,
    text: 'Organizational resilience — does the leadership have a plan, or are we reactive?',
    driver: 'Board members have seen nonprofits fold after major shocks. They need to believe leadership has a forward plan, not just grit.',
  },
  {
    id: 'p4',
    rank: 4,
    text: 'Differentiated impact — are we doing something measurably distinct, or is this fungible?',
    driver: "Board members who donate $10K+ themselves want to know their gift is going somewhere they uniquely matter, not a generic service anyone could fund.",
  },
];

const SOFIA_DIFFERENTIATORS = [
  {
    id: 'd1',
    text: 'Integrated three-stage model: emergency shelter → transitional living → workforce placement, all under one organization',
    mf: 'Most youth-serving nonprofits operate at one stage and hand off — losing kids in the gaps between providers. An integrated continuum means accountability does not break when a young person moves from crisis to stability.',
  },
  {
    id: 'd2',
    text: '83% of workforce program graduates are still stably housed and employed two years later — more than double the national average for this population',
    mf: 'Outcomes data for this population is notoriously weak; most programs cannot show what happened to clients six months out, let alone two years. A verified two-year rate at 2x the national average is a rare, concrete proof of program impact.',
  },
  {
    id: 'd3',
    text: 'Paid apprenticeship placements with named corporate partners, including Salesforce and Blue Cross',
    mf: 'Named corporate placements give the program credibility that small nonprofits typically lack — companies like Salesforce only associate with proven partners. For donors, named partnerships are a trust signal.',
  },
  {
    id: 'd4',
    text: '22 years of continuous operation in Chicago serving runaway and throwaway youth',
    mf: 'An organization that has operated for 22 years has weathered multiple economic cycles, funder changes, and market shocks. Tenure at that length signals institutional resilience and credibility.',
  },
  {
    id: 'd5',
    text: "Serves 'throwaway' youth — teens rejected or pushed out by families — not just runaways, addressing a population many shelters decline",
    mf: 'Throwaway youth are harder to serve than runaways and many programs exclude them. Serving this population means the organization takes on the cases others will not — a moral differentiator for mission-driven donors.',
  },
  {
    id: 'd6',
    text: "Model builds a 'real next step,' not just emergency relief",
    mf: "Most youth shelter programs end at 'safe for the night.' A program that continues to transitional housing and workforce placement actually changes the trajectory — not just a pause, a path.",
  },
];

const mappingMessage = `PRIORITIES (ranked by importance):
${SOFIA_PRIORITIES.map(
  p => `- [ID: ${p.id}] [Rank ${p.rank}] "${p.text}" (Driver: ${p.driver})`,
).join('\n')}

CAPABILITIES/DIFFERENTIATORS:
${SOFIA_DIFFERENTIATORS.map(
  d => `- [ID: ${d.id}] "${d.text}" (MF: ${d.mf})`,
).join('\n')}`;

async function main() {
  console.log('Running MAPPING_SYSTEM against Sofia data…\n');
  const result = await callAIWithJSON<{
    mappings: Array<{ priorityId: string; elementId: string; confidence: number; mfRationale?: string }>;
    orphanElements?: string[];
    priorityGaps?: string[];
    gapDescriptions?: Array<{ priorityId: string; missingCapability: string }>;
    clarifyingQuestions?: string[];
  }>(MAPPING_SYSTEM, mappingMessage, 'fast');

  console.log('=== MAPPINGS ===');
  for (const m of result.mappings || []) {
    const p = SOFIA_PRIORITIES.find(x => x.id === m.priorityId);
    const d = SOFIA_DIFFERENTIATORS.find(x => x.id === m.elementId);
    console.log(`  [${m.confidence.toFixed(2)}] Priority "${p?.text.substring(0, 50)}..." <- "${d?.text.substring(0, 60)}..."`);
    if (m.mfRationale) console.log(`        rationale: ${m.mfRationale}`);
  }

  console.log('\n=== GAP DESCRIPTIONS ===');
  if (!result.gapDescriptions || result.gapDescriptions.length === 0) {
    console.log('  (none — Sofia case failed to produce any gap)');
  } else {
    for (const g of result.gapDescriptions) {
      const p = SOFIA_PRIORITIES.find(x => x.id === g.priorityId);
      console.log(`  Priority: "${p?.text.substring(0, 60)}..."`);
      console.log(`  Missing: ${g.missingCapability}`);
    }
  }

  console.log('\n=== PRIORITY GAPS (IDs) ===');
  console.log(result.priorityGaps || '(none)');

  console.log('\n=== CLARIFYING QUESTIONS ===');
  console.log(result.clarifyingQuestions || '(none)');

  console.log('\n=== VERDICT FOR SOFIA RANK-1 PRIORITY ===');
  const rank1 = SOFIA_PRIORITIES[0];
  const rank1Mappings = (result.mappings || []).filter(m => m.priorityId === rank1.id);
  const rank1InGaps = (result.gapDescriptions || []).some(g => g.priorityId === rank1.id);
  if (rank1InGaps) {
    const maxConf = rank1Mappings.length > 0 ? Math.max(...rank1Mappings.map(m => m.confidence)) : 0;
    console.log(`  PASS — Rank 1 is flagged as a gap.${rank1Mappings.length > 0 ? ` (Also emitted a weaker match at ${maxConf.toFixed(2)} — that's fine; user gets Tier 1 candidate plus the gap interview in parallel.)` : ''}`);
  } else {
    const maxConf = rank1Mappings.length > 0 ? Math.max(...rank1Mappings.map(m => m.confidence)) : 0;
    console.log(`  FAIL — Rank 1 has a ${maxConf.toFixed(2)} match but is NOT flagged as a gap. The canonical Sofia case should produce a gap. Tighten the mapping prompt further.`);
  }
}

main().catch(err => {
  console.error('ERROR:', err);
  process.exit(1);
});
