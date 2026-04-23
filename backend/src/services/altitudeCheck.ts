// Altitude Check — strategic-altitude evaluator for Chapter 1 of a Five Chapter Story.
//
// Chapter 1 is the failure point that drove the April 15-17 pivot. The generator
// is prone to writing at tactical altitude ("your reps go quiet") instead of
// strategic altitude ("unmanaged device lifecycle management means lost revenue").
// The pre-generated thesis helps but is an anchor, not a guarantee — Opus can
// adapt the thesis into a tactical paragraph.
//
// This service is a POST-generation gate. It runs after voice check and
// fabrication check. It asks a strict Opus evaluator whether Chapter 1 is
// pitched at the altitude a senior reader would respect, or whether it
// crossed into telling the reader about their own organization or
// competitive landscape. The retry loop and surgical edit mirror the
// fabrication check pattern.

import { callAI, callAIWithJSON } from './ai.js';

// ─── Evaluator prompt ──────────────────────────────────────────

const ALTITUDE_EVALUATOR_SYSTEM = `You are a strict altitude evaluator for Chapter 1
of a persuasive Five Chapter Story. Chapter 1's job is to make the reader feel they
need to do SOMETHING — not something the writer is selling, just something about
their situation. To do that job, Chapter 1 must live at MARKET altitude: it
describes a condition or pattern in the industry that a senior reader would
independently recognize as true, and connects it to a strategic consequence
for their role.

Your job is to flag when Chapter 1 has drifted into the WRONG altitude. There
are three common failure modes. All three are failures. Call each one out.

═══ FAILURE MODE 1: CLAIMS ABOUT THE READER'S OWN ORGANIZATION ═══

The writer has NO STANDING to tell the reader what their team, reps, sales org,
engineering group, compliance officer, or department does or does not do. The
reader already knows. Any sentence that presumes knowledge of the reader's org
is a failure.

FAIL: "Your reps have no structured way to engage their largest accounts."
FAIL: "Your sales team is missing key signals in the lifecycle."
FAIL: "Your compliance officer is drowning in manual reconciliation."
FAIL: "Your leadership lacks a unified view of cross-divisional spending."

These read as accusations or diagnoses. A senior executive responds with
"who are you to tell me about my team?" and stops reading.

═══ FAILURE MODE 2: TEACHING THE READER THEIR OWN COMPETITIVE LANDSCAPE ═══

Do not tell the reader who their competitors are, what those competitors are
doing, or how the market is moving against them. The reader lives this every
day and will find it patronizing.

FAIL: "Dell and HP are aggressively expanding into your market."
FAIL: "Epic and Cerner are dominating the clinical workflow space."
FAIL: "Competitors are filling the gap your lifecycle management leaves behind."

═══ FAILURE MODE 3: TACTICAL/OPERATIONAL DESCRIPTION, NOT STRATEGIC THESIS ═══

Chapter 1 should describe a MARKET CONDITION at the altitude of a business
thesis, not a tactical symptom the reader experiences day-to-day.

FAIL (tactical): "Your reps go quiet between account reviews."
PASS (strategic): "Unmanaged device lifecycle management means lost revenue."

FAIL (tactical): "Your patient scheduling system misfires at peak intake hours."
PASS (strategic): "Clinical workflow fragmentation means delayed care decisions."

FAIL (tactical): "Slide throughput drops during quarterly review weeks."
PASS (strategic): "Slow pathology analysis means later treatment decisions."

The test: is this sentence an INSIGHT the reader would quote in a board
meeting? Or is it an observation from a sales meeting? The former is
Chapter 1 material. The latter is not.

═══ WHAT PASSES ═══

- A MARKET TRUTH stated as a category/industry condition
- A STRATEGIC CONSEQUENCE that follows from that condition, in the reader's
  domain (revenue, risk, competitive position, regulatory exposure, talent)
- The consequence is attached to the GENERAL SITUATION, not to the reader's
  specific team
- The reader reads it and thinks "that's true about our category — does it
  apply to us?" — they apply it to themselves, the writer doesn't point
- References to "the reader's role" or "the reader's function" at a general
  level (e.g., "a head of compliance today must...") are fine; specific
  claims about "your compliance officer" are not

═══ INPUT ═══

You will receive:
- AUDIENCE: the role the draft addresses (e.g. "SVP of Enterprise Sales at Apple")
- TOP PRIORITY: the audience's #1 strategic concern
- DRIVER: why that priority is important to this specific persona (may be absent)
- CHAPTER 1 CONTENT: the draft to evaluate

═══ OUTPUT ═══

Return ONLY valid JSON, no markdown fences:

{
  "pass": true | false,
  "violations": [
    "Quote the exact failing sentence. One line on which failure mode it is and why."
  ]
}

If pass is true, violations must be empty. If pass is false, list every failing
sentence separately so the writer can edit each one. Err toward flagging —
a senior reader stops reading the moment they feel accused or patronized.`;

// ─── Elevation instruction (for retry feedback and Maria responses) ──

const ELEVATION_GUIDANCE = `STRATEGIC ALTITUDE FIX — Chapter 1 must describe a MARKET
TRUTH the reader recognizes, not a claim about their own team or competitors.

Rewrite at the altitude of "[category condition] means [business consequence]."
Describe what is true about the industry or the reader's category, then name the
strategic consequence that follows. Do not say anything about the reader's
specific organization, their reps, their team, their compliance officer, or
what their competitors are doing — the reader knows all of that and will stop
reading if you tell them.

Test: would a senior executive quote this sentence in a board meeting? If yes,
it is strategic. If it sounds like an observation from a ride-along or a
status report, it is tactical — rewrite.`;

// ─── Types ──────────────────────────────────────────────────────

export interface AltitudeCheckInput {
  audienceName: string;
  topPriority: string;
  driver?: string;
  chapterContent: string;
}

export interface AltitudeCheckResult {
  passed: boolean;
  violations: string[];
}

// ─── Evaluator function ─────────────────────────────────────────

export async function checkChapterOneAltitude(
  input: AltitudeCheckInput,
): Promise<AltitudeCheckResult> {
  const userMessage = `AUDIENCE: ${input.audienceName}
TOP PRIORITY: "${input.topPriority}"
${input.driver ? `DRIVER: "${input.driver}"` : '(no driver provided)'}

CHAPTER 1 CONTENT:
${input.chapterContent}`;

  const result = await callAIWithJSON<{
    pass: boolean;
    violations: string[];
  }>(ALTITUDE_EVALUATOR_SYSTEM, userMessage, 'elite');

  return {
    passed: result.pass === true,
    violations: Array.isArray(result.violations) ? result.violations : [],
  };
}

// ─── Retry feedback builder ─────────────────────────────────────

export function buildAltitudeFeedback(violations: string[]): string {
  if (violations.length === 0) return '';
  return `\n\nALTITUDE VIOLATIONS — Chapter 1 is at the wrong altitude. These specific
sentences read as claims about the reader's own organization, as lectures about
their competitive landscape, or as tactical observations instead of strategic
truths:

${violations.map((v, i) => `${i + 1}. ${v}`).join('\n')}

${ELEVATION_GUIDANCE}

Rewrite Chapter 1. Remove or replace every flagged sentence with a strategic
market truth the reader would independently recognize.`;
}

// ─── Surgical elevation pass ─────────────────────────────────────
//
// When the retry loop doesn't clear violations, switch to EDIT mode: keep the
// unflagged sentences verbatim and rewrite only the flagged ones into market
// truths. No new content beyond what's needed to replace the flagged sentence.

const ALTITUDE_EDIT_SYSTEM = `You are a surgical editor for Chapter 1 of a Five
Chapter Story. A draft has specific sentences flagged as being at the wrong
altitude — they make claims about the reader's own organization, teach the
reader their competitive landscape, or state tactical observations instead of
strategic market truths.

Your ONLY job is to rewrite the flagged sentences into strategic market truths
while preserving every other sentence verbatim.

${ELEVATION_GUIDANCE}

Rules, in order of priority:
1. Unflagged sentences must remain verbatim. Do not polish them. Do not restructure.
2. Each flagged sentence must be replaced with a strategic market truth at the
   same approximate length. "[Category condition] means [business consequence]"
   is the canonical form.
3. The replacement must NOT make claims about the reader's specific org, team,
   reps, or named competitors. Describe the category / the industry / the role
   in general, not this specific reader.
4. If a flagged sentence cannot honestly be rewritten at strategic altitude
   given the source material, CUT it entirely rather than invent. Shorter is
   fine.
5. Return ONLY the rewritten chapter text. No commentary, no markdown, no fences.`;

export interface AltitudeEditInput {
  chapterContent: string;
  violations: string[];
  audienceName: string;
  topPriority: string;
}

export async function elevateChapterOne(
  input: AltitudeEditInput,
): Promise<string> {
  if (input.violations.length === 0) return input.chapterContent;

  const userMessage = `AUDIENCE: ${input.audienceName}
TOP PRIORITY: "${input.topPriority}"

DRAFTED CHAPTER 1:
${input.chapterContent}

FLAGGED SENTENCES — each is at the wrong altitude. Rewrite each one into a
strategic market truth, or cut it. Keep all other sentences verbatim.

${input.violations.map((v, i) => `${i + 1}. ${v}`).join('\n')}

Return the rewritten Chapter 1 text only.`;

  const elevated = await callAI(ALTITUDE_EDIT_SYSTEM, userMessage, 'elite');
  return elevated
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}
