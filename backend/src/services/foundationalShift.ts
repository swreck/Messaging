// Round E4 — Foundational-shift detection.
//
// When the user edits chapter content, ask Opus whether the edit is
// foundationally semantic — meaning the user rewrote a passage in a way
// that effectively changes the underlying Tier 1 framing or a Tier 2
// differentiator. If so, propose the EXACT new Tier wording so Maria
// can show it to the user for confirmation before persisting.
//
// Quality-floor principle: this is judgment-heavy classification work
// (must distinguish "user tightened a sentence" from "user reframed
// what the offering does"). Runs on Opus.

import { callAIWithJSON } from './ai.js';

const SYSTEM = `You compare a user's chapter edit against the deliverable's underlying Three Tier message and judge whether the edit is foundationally semantic — meaning the user has effectively changed the Tier 1 framing or a Tier 2 differentiator, not just polished a sentence.

A foundationally-semantic edit reframes WHAT THE USER GETS or HOW IT WORKS in a way that differs from the current Three Tier wording. A non-foundational edit tightens, rewords, or reorders without changing the underlying claim.

If the edit IS foundational:
- Identify which Tier cell shifts (tier1, tier2-N, or no-shift if the edit is genuinely cross-cutting).
- Propose the EXACT new wording for that Tier cell — must be ≤20 words for Tier 1/2, must use the audience's own framing where possible, no marketing language.
- Surface the contrast: what the OLD Tier said vs what the NEW Tier should say.

If the edit is NOT foundational, say so honestly. shouldUpdate=false.

Be CONSERVATIVE — false positives (Maria proposing a Tier update for a typo fix) destroy trust faster than false negatives. If the edit could be either, lean toward not proposing.

OUTPUT — return ONLY valid JSON:
{
  "shouldUpdate": true | false,
  "targetCell": "tier1" | "tier2-0" | "tier2-1" | ... | "none",
  "oldText": "the current Tier wording — copy from input",
  "newText": "the proposed new Tier wording you derived from the edit",
  "reason": "one short sentence — what specifically shifted"
}

If shouldUpdate is false, oldText/newText/targetCell can be empty.`;

export interface ShiftDetectInput {
  beforeChapterContent: string;
  afterChapterContent: string;
  chapterNum: number;
  threeTier: {
    tier1: string;
    tier2: { categoryLabel: string; text: string }[];
  };
  audienceName: string;
}
export interface ShiftDetectResult {
  shouldUpdate: boolean;
  targetCell: string;
  oldText: string;
  newText: string;
  reason: string;
}

export async function detectFoundationalShift(input: ShiftDetectInput): Promise<ShiftDetectResult> {
  const tierBlock = `Tier 1: "${input.threeTier.tier1}"\n${input.threeTier.tier2
    .map((t, i) => `Tier 2 [${i}] (${t.categoryLabel || ''}): "${t.text}"`)
    .join('\n')}`;
  const userMessage = `AUDIENCE: ${input.audienceName}

CURRENT THREE TIER:
${tierBlock}

CHAPTER ${input.chapterNum} — BEFORE (Maria's draft):
${input.beforeChapterContent}

CHAPTER ${input.chapterNum} — AFTER (user's edit):
${input.afterChapterContent}

Did the user's edit foundationally shift any Tier? Be conservative.`;
  try {
    const result = await callAIWithJSON<ShiftDetectResult>(SYSTEM, userMessage, 'elite');
    return {
      shouldUpdate: result.shouldUpdate === true,
      targetCell: typeof result.targetCell === 'string' ? result.targetCell : 'none',
      oldText: typeof result.oldText === 'string' ? result.oldText : '',
      newText: typeof result.newText === 'string' ? result.newText : '',
      reason: typeof result.reason === 'string' ? result.reason : '',
    };
  } catch (err) {
    console.error('[foundationalShift] detect failed:', err);
    return { shouldUpdate: false, targetCell: 'none', oldText: '', newText: '', reason: '' };
  }
}
