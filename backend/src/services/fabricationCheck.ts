// Fabrication check — guards Express Flow chapter content against claims
// that aren't supported by the Three Tier or the Situation block.
//
// The voice check evaluates whether text SOUNDS right. The methodology check
// evaluates whether the Three Tier STRUCTURE is correct. Neither of them
// evaluates whether the chapter content is FACTUALLY supported by the
// underlying data. That was the gap that let Rosa's draft invent "published
// reasoning" and "comment period", and let Dina's draft invent "compliance
// teams using Claris... same size as yours".
//
// This checker runs after voice check and before the chapter is cached. It
// asks a strict Opus evaluator whether every substantive claim in the
// chapter is supported by the provided Three Tier, Priorities, and
// Situation. If not, it returns the specific violating claims so the
// chapter can be regenerated with targeted feedback.

import { callAIWithJSON } from './ai.js';

const FABRICATION_EVALUATOR_SYSTEM = `You are a factual gatekeeper for generated
marketing chapters.

Your ONLY job is to flag claims in the chapter that are NOT supported by the
SOURCE OF TRUTH below. You do not evaluate voice, tone, structure, or style.
Those are handled by other checkers. You are the fabrication alarm.

SOURCE OF TRUTH has three sections:
1. SITUATION — what the user is trying to communicate
2. THREE TIER — the approved value framework (Tier 1 + Tier 2 columns + Tier 3 proofs)
3. PRIORITIES — what the audience cares about

A claim is SUPPORTED if any of these three is true:
- It paraphrases a fact explicitly stated in the SOURCE
- It is a reasonable interpretation of the SITUATION
- It is the Three Tier message told in readable prose

A claim is NOT SUPPORTED (and is therefore fabrication) if:
- It names customers, reference accounts, or existing users not in Tier 3
- It cites metrics, percentages, dollar amounts, or timelines not in Tier 3
- It describes professional services (onboarding leads, implementation teams,
  quarterly check-ins, dedicated trainers) not stated in the source
- It describes processes the user never mentioned (comment periods, published
  rationales, forums, town halls, review boards, formal votes)
- It describes pricing, billing, subscription models
- It invents product features not listed in Tier 2 or Tier 3
- It characterizes relationships the source does not establish ("the board knows
  you by name", "your dedicated contact", "we review every case personally")
- It invents specific historical facts ("since 1987 we have always...", "our
  founder said...", "this has always been our policy")

Reasonable tonal framing ("your membership is valued", "we know this is a
change") is NOT fabrication. Specific claims about people, numbers, processes,
programs, or history ARE fabrication.

INPUT shape:

SITUATION:
<situation text>

THREE TIER MESSAGE:
Tier 1: <tier 1 text>
Tier 2 [column N]: <tier 2 text>
  Proof: <tier 3 bullets>
...

PRIORITIES:
[Rank 1] <priority>
[Rank 2] <priority>
...

CHAPTER TO EVALUATE:
<chapter content>

OUTPUT — return ONLY valid JSON, no markdown fences:
{
  "pass": true | false,
  "violations": [
    "Quote the exact fabricated phrase or sentence, then one-line reason why it is unsupported."
  ]
}

If pass is true, violations must be an empty array. If pass is false, violations
must list every unsupported claim you can find, one per entry. Do not flag
anything that IS supported — keep the list tight and specific so the writer
can fix exactly those claims.`;

export interface FabricationCheckResult {
  passed: boolean;
  violations: string[];
}

export interface FabricationCheckInput {
  situation: string;
  tierText: string;
  prioritiesText: string;
  chapterContent: string;
}

export async function checkChapterFabrication(
  input: FabricationCheckInput,
): Promise<FabricationCheckResult> {
  const userMessage = `SITUATION:
${input.situation || '(none provided)'}

THREE TIER MESSAGE:
${input.tierText}

PRIORITIES:
${input.prioritiesText}

CHAPTER TO EVALUATE:
${input.chapterContent}`;

  const result = await callAIWithJSON<{
    pass: boolean;
    violations: string[];
  }>(FABRICATION_EVALUATOR_SYSTEM, userMessage, 'elite');

  return {
    passed: result.pass === true,
    violations: Array.isArray(result.violations) ? result.violations : [],
  };
}

export function buildFabricationFeedback(violations: string[]): string {
  if (violations.length === 0) return '';
  return `\n\nFABRICATION DETECTED — these specific claims in your draft are not
supported by the Three Tier or Situation. You MUST cut each one and rewrite
the affected passage. A shorter honest chapter is required:

${violations.map((v, i) => `${i + 1}. ${v}`).join('\n')}

When you regenerate, ensure no claim resembles the flagged items above. If
you cannot replace a flagged claim with a supported one, simply remove the
sentence. Length is not a target — accuracy is.`;
}
