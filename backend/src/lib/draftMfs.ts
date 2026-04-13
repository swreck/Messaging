// Shared helper: draft motivating factors for an offering's differentiators.
//
// Used both by POST /api/ai/draft-mfs (the route called from the Step 2 button
// and the Step 4 offer panel) and by the partner-chat draft_mfs action so Maria
// can take this action from chat. Encapsulates the audience-portable drafting
// prompt and the mfCheck retry loop in one place — single source of truth for
// the doctrinal standard.

import { callAIWithJSON } from '../services/ai.js';
import { checkMfs, buildMfViolationFeedback } from '../services/mfCheck.js';

const DRAFT_MFS_SYSTEM = `You are a messaging strategist drafting Motivating Factors for an offering's differentiators.

A Motivating Factor (MF) answers: "Why would someone crave this differentiator?"
It is a property of the differentiator, NOT of any one audience. The MF is the
bridge that makes the differentiator legible to mapping: when the MF principle
aligns with what an audience cares about, that's the connection.

═══ THE AUDIENCE-PORTABLE STANDARD ═══

A great MF does THREE things:

1. STATES THE GENERAL BENEFIT PRINCIPLE.
   The underlying reason the differentiator matters — what it actually does for
   anyone who would benefit from it. Not one application; the principle.

2. NAMES 2-4 CONCRETE AUDIENCE TYPES OR USE CASES THAT CRAVE IT.
   The examples must span DIFFERENT worlds — different industries, different roles,
   different jobs-to-be-done. The bar is: would someone in any of these examples,
   AND someone in a similar but unnamed audience, read it and feel seen?

3. STAYS LITERAL.
   No marketing buzzwords (leverage, seamless, cutting-edge, robust, end-to-end,
   game-changing, holistic). No metaphorical verbs (unlocks, fuels, drives,
   powers, transforms). State plainly what the differentiator does for the people
   who want it.

═══ EXAMPLES ═══

Differentiator: "5x I/O throughput improvement on small data units"
GOOD MF: "I/O is what feeds servers of any sort with the data they need to operate, so faster I/O directly speeds operations — for compute servers running scientific simulations, for transaction systems serving high-volume customer requests, for archival systems catching up on overnight batches."
BAD MF: "Faster simulations for pharma researchers." (Single audience, jumps past the principle.)
BAD MF: "Unlocks blazing-fast performance with seamless integration." (Buzzwords, metaphorical, no principle, no audiences.)

Differentiator: "60-second whole-slide pathology analysis"
GOOD MF: "Faster slide analysis means faster decisions about what to do next, regardless of who is making the decision — for an oncologist deciding on a treatment plan, for a hospital lab director sequencing a high-volume queue, for a research team running batch screens overnight."
BAD MF: "Helps oncologists treat cancer faster." (Single audience, narrow.)

Differentiator: "Hardware sale with full setup, configuration, and integration support"
GOOD MF: "Buying complex hardware without an integration team usually means months of setup risk; bundling that work removes the hidden cost and the timeline uncertainty — important for any organization that cannot afford a long ramp, whether a research lab on a grant clock, a regional bank under audit, or a logistics firm staging a peak season."

═══

You will be given a list of differentiators. For each one, write an MF that meets
the audience-portable standard above. Stay grounded in what the differentiator
ACTUALLY does. If you genuinely cannot think of multiple audiences that would
crave this differentiator, return a single-audience MF and flag it — that's a
signal the differentiator may be too narrow.

Return JSON only:
{
  "mfs": [
    { "index": 0, "differentiator": "...", "mf": "..." },
    { "index": 1, "differentiator": "...", "mf": "..." }
  ]
}`;

interface OfferingShape {
  name: string;
  description?: string;
}

interface ElementShape {
  id: string;
  text: string;
}

export interface DraftedMf {
  elementId: string;
  mf: string;
}

export async function draftMfsForOffering(offering: OfferingShape, targets: ElementShape[]): Promise<DraftedMf[]> {
  if (targets.length === 0) return [];

  const offeringContext = `OFFERING: ${offering.name}
${offering.description ? `DESCRIPTION: ${offering.description}` : ''}

DIFFERENTIATORS TO DRAFT MFs FOR:
${targets.map((e, i) => `[${i}] "${e.text}"`).join('\n')}`;

  // First pass
  let result = await callAIWithJSON<{ mfs: { index: number; differentiator: string; mf: string }[] }>(
    DRAFT_MFS_SYSTEM,
    offeringContext,
    'elite',
  );
  let drafted = result.mfs || [];

  // mfCheck quality gate, one retry on violations
  const check = await checkMfs(drafted.map(d => ({ differentiator: d.differentiator, mf: d.mf })));
  if (!check.passed && check.violations.length > 0) {
    const feedback = buildMfViolationFeedback(check.violations);
    result = await callAIWithJSON<{ mfs: { index: number; differentiator: string; mf: string }[] }>(
      DRAFT_MFS_SYSTEM,
      offeringContext + feedback,
      'elite',
    );
    drafted = result.mfs || [];
  }

  // Map back to elementIds
  const out: DraftedMf[] = [];
  for (const d of drafted) {
    const target = targets[d.index];
    if (!target) continue;
    out.push({ elementId: target.id, mf: d.mf.trim() });
  }
  return out;
}
