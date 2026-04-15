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

import { callAIWithJSON, callAI } from './ai.js';

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
  quarterly check-ins, dedicated trainers, customer success managers) not
  stated in the source
- It describes processes the user never mentioned (comment periods, published
  rationales, forums, town halls, review boards, formal votes)
- It describes pricing, billing, subscription models
- It invents product features not listed in Tier 2 or Tier 3
- It characterizes relationships the source does not establish ("the board knows
  you by name", "your dedicated contact", "we review every case personally")
- It invents specific historical facts ("since 1987 we have always...", "our
  founder said...", "this has always been our policy")

ROLE SUBSTITUTION IS ALWAYS FABRICATION. This is critical. If the source
names a specific kind of person or team ("two of our founders came out of
bank compliance", "the owner is on the floor every day", "my CTO wrote the
whitepaper"), the chapter may name THAT exact role — not a different one.
Swapping one role for another is inventing a team that does not exist.

Examples of role substitution — each one is fabrication:
- Source says "founders came from bank compliance backgrounds."
  Chapter says "your onboarding team comes from bank compliance backgrounds."
  → FABRICATION. The onboarding team is not mentioned anywhere. The founders
    are the people in the story.
- Source says "the owner is on the floor every day."
  Chapter says "your dedicated account manager is in the facility daily."
  → FABRICATION. There is no account manager in the source.
- Source says "our CTO wrote the whitepaper."
  Chapter says "our research team authored the whitepaper."
  → FABRICATION. A research team is not mentioned.

The general rule: any role, department, team, or person category that does
not appear in the source verbatim (or as an obvious synonym like
"founder/co-founder") is a fabricated role.

INVENTED ACTOR BEHAVIORS. If the source does not describe what a specific
third party does — examiners, regulators, auditors, board members, customers,
staff, vendors — the chapter cannot put actions in their mouths or describe
what they see, feel, or do. Examples:
- "That's the same view your examiner sees." → FABRICATION unless the
  source explicitly says examiners see the same view.
- "Your board will feel the relief immediately." → FABRICATION unless stated.
- "Your compliance officer logs in on Monday morning and sees..." →
  FABRICATION unless the source describes this scene.

INVENTED PRODUCT BEHAVIORS. A claim about how the product behaves at a
specific moment, on a specific day, or in a specific state is fabrication
unless the source actually says so. Examples:
- "The framework is already there when they log in for the first time."
  → FABRICATION unless the source explicitly says "pre-mapped at first login"
    or similar.
- "Your dashboard turns red when a control drifts out of compliance."
  → FABRICATION unless stated.

INVENTED PRODUCT FEATURES. Opus will frequently extrapolate one stated
capability into a cluster of related capabilities. Each extrapolation is
fabrication. Examples:
- Source: "Single dashboard that covers all controls."
  Chapter: "Board reporting is built in. You get a live view across all
  your controls, with drill-down analytics and exportable audit trails."
  → FABRICATION. "Board reporting is built in" is a specific feature not
    in the source. "Drill-down", "exportable audit trails" are invented.
- Source: "The product handles the re-mapping automatically."
  Chapter: "When the regulatory change comes in, the product flags the
  affected workflows, generates a remediation checklist, and notifies
  your compliance officer by email."
  → FABRICATION. "Remediation checklist" and "email notifications" are
    invented features.

Rule: a feature exists in the draft only if the Three Tier literally says
the product does that thing. Paraphrasing "automatic mapping" is fine.
Adding "and notifies you" when notifications weren't stated is not fine.

THE CATEGORICAL TEST FOR INVENTED FEATURES. A sentence makes a specific
product-capability claim any time it names what the product CAN DO, STORES,
TRACKS, LOGS, REPORTS, EXPORTS, or PRESENTS. Apply this test every time
you see those verbs:

  1. Does the source text literally say the product does this specific
     thing? If yes, allow.
  2. Does the source name the specific artifact (report, log, dashboard,
     export, summary, audit trail, document, history, timeline, alert,
     notification, reminder, checklist, worksheet, template, appendix)?
     If no and the draft names it, FLAG it.

Examples of claims that are OFTEN extrapolated from "single dashboard" and
MUST be flagged as fabrication unless the source literally names them:

- "Every action is logged with a timestamp" — flag. The source did not
  name an action log or timestamping capability.
- "Examiner-ready reports available on demand" — flag. The source did not
  name an examiner-report feature.
- "Audit-ready reporting" — flag. This is synonymous with "examiner-ready
  reports". Any "[X]-ready reporting" phrase where X is auditors,
  examiners, regulators, boards, management, or stakeholders is a
  FABRICATED FEATURE NAME unless the source literally coined it.
- "Full audit trail" / "exportable audit trail" — flag. The source did
  not name an audit trail.
- "Board-ready reporting is built in" — flag. The source did not name
  board reports.
- "A full history attached to every control" — flag. The source did not
  name history tracking.
- "Real-time status across all controls" — flag IF the source did not
  explicitly say real-time. "Single dashboard" is not the same as
  "real-time status."
- "Pre-linked controls" / "pre-mapped controls" / "pre-mapped obligations"
  — flag. Any "pre-[verb]ed" claim adds a technical capability the
  source did not name. "Auto-flows" in source ≠ "pre-mapped" in draft.
- "Automated notifications when a control drifts" — flag.
- "Version history" / "change logs" / "approval workflow" — flag any of
  these unless the source names them.
- "Pull a report directly from your live workflows" — flag. Both "pull
  a report" and "live workflows" are invented product verbs/nouns.
- "Every obligation is visible" / "all obligations at a glance" / "full
  visibility across obligations" — flag as fabricated capability unless
  the source uses that framing.
- "Fits inside your current budget cycle" — flag. This is an invented
  commercial/pricing claim not in source.
- Any sentence that uses "reporting" as a named product feature ("the
  reporting", "reporting is ready for X", "reporting gives you Y") is
  suspect — unless the source explicitly says the product does reporting,
  flag it. A product with a "dashboard" does not automatically have
  "reporting" as a named feature.

CATEGORICAL RULE FOR SYNTHESIS/SUFFIX CAPABILITIES. Any phrase matching
"[X]-ready" (audit-ready, examiner-ready, board-ready, investor-ready,
compliance-ready, regulator-ready) that names a product output is
fabrication unless the source coined it. Same for "[X]-grade" (audit-
grade, enterprise-grade). Same for "comes pre-[verb]ed" constructions
(pre-mapped, pre-linked, pre-configured, pre-populated, pre-built).
These sentence patterns sound professional but they are where the
writer's instinct to polish slips into inventing. Flag them on sight.

The pattern to watch for: the draft is describing a compliance or
regulatory product and the writer's instinct is to list "and of course
it also has X and Y and Z" — each X, Y, Z the writer invents is a
fabrication, even though every single one of them is plausible for a
product in that category. Plausibility is not supporting evidence.

If the draft sentence contains a NOUN PHRASE describing a capability and
that exact capability is not in the source, flag the whole sentence. Do
not rationalize it. Do not give it a "probably meant this" benefit of
the doubt. The writer will thank you later for catching it.

INVENTED SUPPORTING DOCUMENTS. Board updates, reports, and formal
communications tempt Opus to reference documents that don't exist:
- "See the accompanying financial appendix for details."
  → FABRICATION unless the user said there is a financial appendix.
- "The full modeling assumptions are in Appendix B."
  → FABRICATION.
- "Please review the supporting memo attached to this update."
  → FABRICATION unless stated.

If the draft references any "attached", "accompanying", "enclosed",
"appendix", "supporting memo", or "companion document" that the user
did not describe, that reference is fabrication. Cut or rewrite.

INVENTED TIMELINES AND SCHEDULING. Claims about when something is
scheduled, funded, or due are fabrication unless the source said so:
- Source: "EHR rollout on schedule for Q4 go-live."
  Chapter: "The full migration team is staffed and funded through the
  go-live date. The team will ramp down in January."
  → FABRICATION. Staffing and funding details, ramp-down plan, are
    invented.
- Source: "3 of 5 consent order milestones complete."
  Chapter: "The remaining two milestones are scheduled for completion
  during Q4. Milestone 4 lands in October and milestone 5 in November."
  → FABRICATION. The schedule and specific months were not stated.

Rule: if the source gives a single date/status and the draft adds more
schedule detail ("in October", "by Thanksgiving", "during the first
week", "after the board meeting"), that extra detail is fabrication
unless the source literally says so.

INVENTED ORGANIZATIONAL STRUCTURES. Drafts frequently invent internal
teams, processes, governance bodies, or routines:
- "Our implementation team will walk you through the migration."
  → FABRICATION unless the source says there is an implementation team.
- "Management will present the margin variance detail at Tuesday's
  meeting."
  → FABRICATION unless the source said this agenda item was planned.
- "Every communication from the company goes through a weekly review."
  → FABRICATION unless the source described such a review.
- "I review every policy change personally."
  → FABRICATION unless the source stated this personal review practice.

Any time the draft describes how the ORGANIZATION behaves internally —
routines, reviews, sign-offs, meetings, team responsibilities — the
specifics must trace to the source. Vague "we care about quality" is
fine; specific "our QA team reviews every message" is not.

Reasonable tonal framing ("your membership is valued", "we know this is a
change") is NOT fabrication. Specific claims about people, numbers, processes,
programs, roles, actor behaviors, or product behaviors ARE fabrication.

WHEN IN DOUBT, FLAG IT. You are the last line of defense. A false positive
(flagging something that was actually supported) is a minor annoyance; a
false negative (letting a fabrication ship) is a product failure. Err toward
flagging. The writer can always restore a claim if they can point to the
exact source phrase that supports it.

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

// ─── Surgical redaction pass ───────────────────────────
// When the 2-retry fabrication loop has not cleared all violations, asking
// the chapter prompt to regenerate tends to introduce NEW fabrications
// (Opus has infinite surface area to invent from and the chapter system
// prompt still pressures it toward a topic that isn't in the source). The
// surgical pass avoids this by switching modes: instead of asking the LLM
// to GENERATE with the chapter system prompt, we ask it to EDIT — remove
// or soften exactly the flagged sentences from the last draft, preserving
// everything else. Shorter output is fine. Zero new claims is the goal.

const REDACTION_SYSTEM = `You are a surgical editor. A drafted chapter has
specific sentences flagged as unsupported by the source material. Your
ONLY job is to remove or soften those specific flagged sentences while
preserving everything else in the draft verbatim.

Rules, in order of priority:
1. Never add new content. Not a single clause. If a sentence needs to go,
   cut it. Do not replace it with a new claim.
2. Every flagged claim must disappear from the output. The flagged text
   may be the whole sentence or a phrase inside a sentence. In either
   case, the output must not contain the flagged claim, paraphrased or
   otherwise.
3. Sentences that were NOT flagged must remain verbatim. Do not rephrase
   them. Do not polish them. Do not restructure the chapter.
4. If removing a flagged sentence leaves a paragraph awkwardly short or
   stranded, that is acceptable. A short honest paragraph is better than
   a smooth fabricated one.
5. If a sentence is PARTIALLY flagged — one claim is invented but the rest
   is supported — you may remove only the invented clause and keep the
   supported portion, as long as the remaining text still reads cleanly.
6. The output is the rewritten chapter only. No commentary, no markdown,
   no explanation.
7. If the entire chapter consisted of flagged content and you have nothing
   left to emit, return a single short honest sentence grounded in the
   source material — something like "This is the first draft of the
   [chapter topic]." Do not invent to fill space.

Return ONLY the rewritten chapter text. No JSON, no headers, no fences.`;

export interface RedactionInput {
  chapterContent: string;
  violations: string[];
}

export async function redactChapterViolations(
  input: RedactionInput,
): Promise<string> {
  if (input.violations.length === 0) return input.chapterContent;

  const userMessage = `DRAFTED CHAPTER:
${input.chapterContent}

FLAGGED CLAIMS (each one is unsupported and must be removed or softened;
do not add replacement content):

${input.violations.map((v, i) => `${i + 1}. ${v}`).join('\n')}

Now return the rewritten chapter with every flagged claim removed. Keep
all other sentences verbatim. Shorter is fine. Do not introduce anything
new.`;

  const redacted = await callAI(REDACTION_SYSTEM, userMessage, 'elite');

  // Strip any accidental markdown fencing or preamble the LLM may add.
  return redacted
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}
