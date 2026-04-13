// MF Check — quality gate for Motivating Factors on differentiators
//
// The doctrinal standard for an MF: it must be AUDIENCE-PORTABLE.
// A great MF states the *general* benefit principle, then names 2-4
// concrete audience types or use cases that crave that benefit. The bar
// is: would *any* of these audiences read it and feel seen?
//
// Pattern: "Fast I/O accelerates info to servers of any sort, directly
//           speeding operations, e.g., compute servers running simulations,
//           transaction systems, archival catch-up jobs, etc."
//
// This evaluator is used in the draft_mfs flow: Maria drafts MFs, the
// evaluator scores them, and if they fail the standard the drafting is
// retried once with violation feedback. Same shape as voiceCheck.ts.

import { callAIWithJSON } from './ai.js';

const MF_EVALUATOR_SYSTEM = `You are a strict quality evaluator for Motivating Factors (MFs) on offering differentiators. You are NOT the writer — you are the independent reviewer.

═══════════════════════════════════════════════════════════
WHAT IS AN MF?
═══════════════════════════════════════════════════════════

An MF answers: "Why would someone crave this differentiator?"
It is a property of the differentiator itself, NOT of any specific audience.
It is the bridge that makes the differentiator legible to mapping: when an
MF aligns with what an audience cares about, that's the connection.

Example differentiator: "5x I/O throughput improvement on small data units"
Example MF (GOOD): "I/O is what feeds servers of any sort with the data they need
to operate, so faster I/O directly speeds operations — for compute servers running
simulations, for transaction systems serving customers, for archival catch-up jobs."

═══════════════════════════════════════════════════════════
QUALITY STANDARD — three checks
═══════════════════════════════════════════════════════════

Each MF must pass all three:

CHECK 1 — STATES A GENERAL PRINCIPLE.
The MF must articulate the underlying benefit principle, not jump straight to
one narrow application. "I/O feeds servers, so faster I/O speeds operations"
is the principle. "Faster simulations for pharma researchers" is NOT a
principle — it's one specific application.

PASS: "Faster sample analysis means faster decisions, regardless of who is making
the decision or what they're deciding about."
FAIL: "Faster sample analysis helps oncologists treat patients faster." (jumps
straight to one audience without naming the principle)

CHECK 2 — NAMES MULTIPLE AUDIENCE TYPES OR USE CASES.
The MF must include 2-4 concrete examples spanning DIFFERENT audience types or
use cases. The audiences should be different enough that someone in any of them
would read the MF and recognize their own job-to-be-done in it.

PASS: "...speeds operations, e.g., compute servers running simulations,
transaction systems serving customers, archival catch-up jobs."
(Three different use cases — HPC, OLTP, batch — each its own world.)

FAIL: "...helps oncologists, hematologists, and other doctors." (Three flavors
of the same audience type — not a real spread.)

FAIL: "...helps researchers." (Single audience type, no examples.)

CHECK 3 — AUDIENCE-PORTABLE.
Reading the MF, would multiple distinct audiences plausibly say "yes, that
applies to me"? If the MF only resonates with one specific persona, it is not
yet audience-portable.

The test: would a stranger in one of the named audiences feel "seen" by this MF?
Would a stranger in an UNNAMED but similar audience also see themselves in the
underlying principle?

═══════════════════════════════════════════════════════════
NEGATIVE GUARDRAILS — things that must NOT appear
═══════════════════════════════════════════════════════════

A. NO MARKETING BUZZWORDS. leverage, seamless, cutting-edge, robust, end-to-end,
   game-changing, comprehensive, holistic, enterprise-level, transformative.

B. NO METAPHORICAL VERBS. unlocks, fuels, drives, powers, transforms, bridges,
   reshapes, elevates. Use literal language.

C. NOT JUST RESTATING THE DIFFERENTIATOR. "5x I/O throughput is fast" is not an
   MF — it's a tautology. The MF must explain WHY someone would want the thing.

D. NOT A LIST OF FEATURES. The MF is the benefit, not a feature inventory.

═══════════════════════════════════════════════════════════

RESPOND WITH JSON ONLY:
{
  "mfs": [
    { "index": 0, "differentiator": "the differentiator text", "mf": "the mf text", "pass": true },
    { "index": 1, "differentiator": "...", "mf": "...", "pass": false, "violations": ["check 2: only one audience type named", "guardrail A: 'leverage'"] }
  ],
  "overallPass": false
}`;

// ─── Types ──────────────────────────────────────────────────

export interface MfInput {
  differentiator: string;
  mf: string;
}

export interface MfViolation {
  index: number;
  differentiator: string;
  mf: string;
  rules: string[];
}

export interface MfCheckResult {
  passed: boolean;
  violations: MfViolation[];
}

// ─── Evaluator ──────────────────────────────────────────────

export async function checkMfs(mfs: MfInput[]): Promise<MfCheckResult> {
  if (mfs.length === 0) {
    return { passed: true, violations: [] };
  }

  const input = mfs.map((m, i) =>
    `[${i}] Differentiator: "${m.differentiator}"\n    MF: "${m.mf}"`
  ).join('\n\n');

  try {
    const result = await callAIWithJSON<{
      mfs: { index: number; differentiator: string; mf: string; pass: boolean; violations?: string[] }[];
      overallPass: boolean;
    }>(MF_EVALUATOR_SYSTEM, `MFs TO EVALUATE:\n\n${input}`, 'elite');

    const violations = result.mfs
      .filter(m => !m.pass)
      .map(m => ({
        index: m.index,
        differentiator: m.differentiator,
        mf: m.mf,
        rules: m.violations || [],
      }));

    return { passed: result.overallPass, violations };
  } catch {
    // Fail-open: if the evaluator errors, accept the MFs
    return { passed: true, violations: [] };
  }
}

// ─── Feedback builder ───────────────────────────────────────

export function buildMfViolationFeedback(violations: MfViolation[]): string {
  if (violations.length === 0) return '';
  const lines = violations.map(v =>
    `[${v.index}] Differentiator "${v.differentiator}"\n    Your MF: "${v.mf}"\n    Failed: ${v.rules.join('; ')}`
  );
  return `\n\nMF QUALITY VIOLATIONS — your previous draft did not meet the audience-portable standard. Fix these in your regeneration:\n\n${lines.join('\n\n')}\n\nRemember: a great MF states the general benefit principle and names 2-4 different audience types/use cases that crave it. Not one audience — multiple, different ones.`;
}
