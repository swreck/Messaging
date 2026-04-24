// Multi-scenario harness for iterating on MAPPING_SYSTEM.
// Each scenario names a real audience question, offering differentiators that
// are TOPIC-ADJACENT but don't specifically resolve the question, and a single
// expected gap priority. Test passes when mapping flags that priority's id in
// gapDescriptions.
//
// Use this harness to iterate the mapping prompt fast (each scenario ~10s).
// Run: npx tsx test-mapping-scenarios.ts

import 'dotenv/config';
import { MAPPING_SYSTEM } from './src/prompts/mapping.js';
import { callAIWithJSON } from './src/services/ai.js';

interface Scenario {
  name: string;
  priorities: Array<{ id: string; rank: number; text: string; driver: string }>;
  differentiators: Array<{ id: string; text: string; mf: string }>;
  // The priority ID that MUST show up in gapDescriptions for pass.
  expectedGapPriorityId: string;
  // Why this case is a gap — human-readable, used only for failure diagnostics.
  whyGap: string;
}

const SCENARIOS: Scenario[] = [
  {
    name: "Sofia — nonprofit donor-loss (canonical case)",
    priorities: [
      {
        id: 'p1',
        rank: 1,
        text: 'Financial sustainability after the donor loss and layoffs — can this organization survive another shock?',
        driver: 'Board members personally own the diversification risk they approved. They are asking whether the organization can function without that donor.',
      },
      {
        id: 'p2',
        rank: 2,
        text: 'Confidence the model actually works — proof that their time and money is producing real outcomes',
        driver: 'A board that approved funding wants outcomes they can cite to their networks to justify continued investment.',
      },
    ],
    differentiators: [
      {
        id: 'd1',
        text: '22 years of continuous operation in Chicago',
        mf: 'An organization that has operated 22 years has weathered multiple economic cycles and market shocks. Tenure signals institutional resilience.',
      },
      {
        id: 'd2',
        text: '83% of graduates still housed and employed at the two-year mark',
        mf: 'Verified two-year outcome rate at 2x the national average is a rare, concrete proof of program impact.',
      },
      {
        id: 'd3',
        text: 'Integrated three-stage program (shelter → transitional → workforce)',
        mf: 'Most youth nonprofits operate at one stage and lose kids in the handoff gaps. An integrated continuum means accountability does not break across transitions.',
      },
    ],
    expectedGapPriorityId: 'p1',
    whyGap: 'Tenure and program integrity are pattern-from-history; neither answers "can we function without THIS donor" which needs donor-replacement, reserves, or cost-cut mechanism.',
  },

  {
    name: "Engineer migration weekend",
    priorities: [
      {
        id: 'p1',
        rank: 1,
        text: "Not blowing up the 8 engineering teams' weekends during the Redshift-to-Snowflake migration",
        driver: "Engineering leads have been burned by prior data migrations where they spent 3 weekends debugging broken pipelines and lost trust from their teams. They're asking whether THIS migration will require the same kind of firefighting.",
      },
      {
        id: 'p2',
        rank: 2,
        text: 'Cost savings that hold up to CFO scrutiny',
        driver: "CFO will ask for a 12-month ROI calculation with explicit line items. Engineering needs numbers they can defend.",
      },
    ],
    differentiators: [
      {
        id: 'd1',
        text: 'Platform handles any workload at any scale',
        mf: 'Scale-agnostic design means customers do not have to reshape their work to fit the platform — it adapts, from small exploratory queries to nightly batch jobs.',
      },
      {
        id: 'd2',
        text: '50% cost reduction vs. Redshift for equivalent workloads',
        mf: 'Measured savings on real customer workloads, verified against prior-quarter billing. Finance teams can reproduce the calculation on their own numbers.',
      },
      {
        id: 'd3',
        text: 'SQL-compatible with minor dialect differences',
        mf: "Teams can keep most of their existing queries; the learning curve is narrow rather than a full rewrite.",
      },
    ],
    expectedGapPriorityId: 'p1',
    whyGap: 'Engineers want to know about weekend disruption specifically. Scale-agnostic design and SQL compatibility are general capabilities; neither promises a specific migration safety mechanism (automated cutover, staged rollout, parallel-run testing, rollback guarantee).',
  },

  {
    name: "Medical staff defensibility for new device",
    priorities: [
      {
        id: 'p1',
        rank: 1,
        text: 'Something I can defend to my cardiology team when they ask why we should use this device',
        driver: 'CMO has seen devices championed by administration then rejected by medical staff. They are asking what specifically will hold up under skeptical cardiologist peer review.',
      },
      {
        id: 'p2',
        rank: 2,
        text: 'Patient safety signal I can point to in my M&M conference',
        driver: 'If an adverse event happens, CMO needs to have already surfaced the risk profile in morbidity-and-mortality review. They are asking what the device failure modes are.',
      },
    ],
    differentiators: [
      {
        id: 'd1',
        text: 'FDA 510(k) cleared',
        mf: '510(k) clearance removes the regulatory adoption blocker and signals the company has done the hard compliance work. CMOs can entertain the device without immediate legal exposure.',
      },
      {
        id: 'd2',
        text: 'Non-invasive cardiac monitoring modality',
        mf: 'Non-invasive monitoring removes procedural risk, patient discomfort, and clinical overhead associated with invasive alternatives.',
      },
      {
        id: 'd3',
        text: 'CSO was elected to the National Academy of Medicine',
        mf: 'NAM membership is peer-elected and represents the highest scientific recognition in US medicine. Academic medical centers treat NAM affiliation as institutional credibility.',
      },
    ],
    expectedGapPriorityId: 'p1',
    whyGap: 'CMO wants evidence cardiologists specifically will accept — typically prospective clinical trial data, NEJM publication on this device, or head-to-head against standard of care. 510(k) is regulatory, NAM is company-level credibility, non-invasive is modality — none answers "what clinical evidence will my cardiology team accept for THIS device."',
  },
];

interface MappingResult {
  mappings: Array<{ priorityId: string; elementId: string; confidence: number; mfRationale?: string }>;
  gapDescriptions?: Array<{ priorityId: string; missingCapability: string }>;
  priorityGaps?: string[];
  clarifyingQuestions?: string[];
}

async function runScenario(s: Scenario): Promise<{ pass: boolean; notes: string }> {
  const mappingMessage = `PRIORITIES (ranked by importance):
${s.priorities.map(p => `- [ID: ${p.id}] [Rank ${p.rank}] "${p.text}" (Driver: ${p.driver})`).join('\n')}

CAPABILITIES/DIFFERENTIATORS:
${s.differentiators.map(d => `- [ID: ${d.id}] "${d.text}" (MF: ${d.mf})`).join('\n')}`;

  const result = await callAIWithJSON<MappingResult>(MAPPING_SYSTEM, mappingMessage, 'fast');

  const gapFlagged = (result.gapDescriptions || []).some(g => g.priorityId === s.expectedGapPriorityId);
  const matches = (result.mappings || []).filter(m => m.priorityId === s.expectedGapPriorityId);
  const maxMatchConf = matches.length > 0 ? Math.max(...matches.map(m => m.confidence)) : 0;

  let notes = '';
  const gapDesc = (result.gapDescriptions || []).find(g => g.priorityId === s.expectedGapPriorityId);
  if (gapDesc) {
    notes += `\n    gap missingCapability: "${gapDesc.missingCapability.substring(0, 150)}..."`;
  }
  if (matches.length > 0) {
    const match = matches.find(m => m.confidence === maxMatchConf);
    const diff = s.differentiators.find(d => d.id === match?.elementId);
    notes += `\n    mapping(${maxMatchConf.toFixed(2)}) → "${diff?.text.substring(0, 60)}..."`;
  }

  return { pass: gapFlagged, notes };
}

async function main() {
  console.log(`Running ${SCENARIOS.length} mapping scenarios…\n`);
  let passed = 0;
  let failed = 0;

  for (const s of SCENARIOS) {
    process.stdout.write(`  [${s.name}] … `);
    try {
      const r = await runScenario(s);
      if (r.pass) {
        console.log(`PASS${r.notes}`);
        passed++;
      } else {
        console.log(`FAIL (expected gap on ${s.expectedGapPriorityId} — not emitted)${r.notes}`);
        console.log(`    whyGap: ${s.whyGap}`);
        failed++;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`ERROR: ${msg}`);
      failed++;
    }
  }

  console.log(`\n${passed}/${SCENARIOS.length} passed.`);
  if (failed > 0) {
    console.log('Prompt needs further tightening. Iterate mapping.ts and rerun.');
    process.exit(1);
  } else {
    console.log('All scenarios flag their expected gaps. Mapping prompt holds up on the adversarial cases checked.');
  }
}

main().catch(err => {
  console.error('HARNESS ERROR:', err);
  process.exit(1);
});
