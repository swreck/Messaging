// Round D — Phase-3 provenance classifier.
//
// Given a generated chapter and the source materials available (the user's
// situation/interview answers, attached documents, named-peer evidence,
// etc.), return a per-sentence origin classification. Builds on the
// existing fabricationCheck infrastructure conceptually but emits a
// per-claim origin label instead of a binary fabrication flag.
//
// Origin labels:
//   USER_WORDS  — verbatim or close paraphrase of something the user said.
//   USER_DOC    — drawn from an attached document (URL or page reference).
//   RESEARCH    — verified external source (URL). Set later via the
//                 four-action "Add source" flow; the classifier rarely
//                 emits this directly unless the chapter prompt was
//                 already given a verified citation.
//   INFERENCE   — Maria-drafted from general knowledge or pattern-match.
//                 The unsourced category — what surfaces as amber in the
//                 deliverable banner.
//
// Quality-floor principle: this is judgment-heavy classification work, so
// the classifier runs on Opus.

import { callAIWithJSON } from './ai.js';

export type ClaimOrigin = 'USER_WORDS' | 'USER_DOC' | 'RESEARCH' | 'INFERENCE';

export interface ClassifiedClaim {
  sentence: string;     // exact sentence text as it appeared in the chapter
  charOffset: number;   // character offset within the chapter content
  origin: ClaimOrigin;
  sourceRef: string;    // URL or doc id+page for USER_DOC/RESEARCH; empty otherwise
}

export interface ProvenanceClassifyInput {
  chapterContent: string;
  sourceMaterials: {
    userInput?: string;      // situation, interview answers, free-text the user typed
    userDocs?: { id: string; summary: string }[];  // attachments the user shared
    peerInfo?: string;       // named-peer evidence captured pre-Chapter-4
    threeTier?: string;      // the Three Tier text (counts as USER_WORDS for classification)
  };
}

const CLASSIFY_SYSTEM = `You classify the origin of every substantive claim in a generated chapter so the deliverable can show the user where each line came from. You are NOT writing or rewriting — you are labeling.

INPUT SHAPE:
- The chapter content (one or more sentences).
- The source materials available: things the user said, documents the user shared, named-peer evidence, the Three Tier message.

OUTPUT: per-sentence origin classification. One label per substantive sentence.

LABELS:
- USER_WORDS — the sentence repeats, paraphrases, or directly draws on something the user said in their own words (situation, interview answer, Three Tier statement, anything in the userInput / threeTier sections).
- USER_DOC — the sentence draws on content from a user-shared document. Provide the doc id in sourceRef.
- RESEARCH — the sentence cites a verified external source. Use only if the source materials already contain a verified URL the chapter draws from. (You generally won't emit this; the four-action Add-source flow promotes claims to RESEARCH after the user provides a URL.)
- INFERENCE — the sentence is plausible but not directly supported by anything in the source materials. This is Maria-drafted from general knowledge, pattern-match, or extrapolation. Be honest about this category — the user needs to know what to vouch for.

CALIBRATION:
- A sentence that re-uses the user's own phrasing, even slightly rearranged, is USER_WORDS.
- A sentence that asserts a market truth, an industry pattern, or a category condition the user did not state is INFERENCE — even if it sounds reasonable.
- A sentence that names a peer company / person / metric must trace to userInput, peerInfo, or a userDoc; otherwise INFERENCE.
- Tonal framing ("we know change is hard") is too low-content to classify — skip it; only classify substantive claims.
- A sentence that PARAPHRASES a Three Tier statement counts as USER_WORDS (the Three Tier was authored by the user).
- WHEN IN DOUBT, label INFERENCE. False positives (over-labeling INFERENCE) are minor; false negatives (a sourced label on a fabricated claim) destroy user trust.

Return per-sentence labels in CHAPTER ORDER. Include a charOffset for each — the approximate character index in the chapter content where the sentence starts.

OUTPUT — return ONLY valid JSON, no markdown fences:
{
  "claims": [
    { "sentence": "...", "charOffset": 0, "origin": "USER_WORDS", "sourceRef": "" },
    { "sentence": "...", "charOffset": 124, "origin": "INFERENCE", "sourceRef": "" }
  ]
}`;

export async function classifyClaims(input: ProvenanceClassifyInput): Promise<ClassifiedClaim[]> {
  const docsBlock = (input.sourceMaterials.userDocs || [])
    .map(d => `[doc ${d.id}] ${d.summary}`).join('\n') || '(none)';
  const userMessage = `SOURCE MATERIALS — anything the chapter could honestly draw from.

USER INPUT (the user's own words — situation, interview, Three Tier statements):
${input.sourceMaterials.userInput || '(none)'}

USER DOCUMENTS (attachments the user shared):
${docsBlock}

NAMED-PEER EVIDENCE (Round B4 peer prompt — counts as USER_WORDS when present):
${input.sourceMaterials.peerInfo || '(none)'}

THREE TIER MESSAGE (counts as USER_WORDS):
${input.sourceMaterials.threeTier || '(none)'}

CHAPTER CONTENT TO CLASSIFY:
${input.chapterContent}

Return per-sentence origin classifications in chapter order.`;

  const result = await callAIWithJSON<{ claims: ClassifiedClaim[] }>(
    CLASSIFY_SYSTEM,
    userMessage,
    'elite',
  );
  return Array.isArray(result.claims) ? result.claims : [];
}

// Round D — Add-source validation. When the user provides a URL or citation
// for an INFERENCE-origin claim, this service fetches/parses the source and
// asks Opus whether the source supports the specific claim. Used by the
// four-action resolution tooltip's "Add source" path.

const VALIDATE_SOURCE_SYSTEM = `You are a strict citation validator. The user has provided a URL or citation as a source for a specific claim in their deliverable. Your job: determine whether the source TEXT actually supports the specific claim.

Be rigorous. A source supports a claim if a careful reader would say "yes, that text directly substantiates the claim." Vague tangential mentions, broader topical relevance, or unrelated assertions in the same document do NOT count as support.

OUTPUT — return ONLY valid JSON:
{
  "supported": true | false,
  "reason": "one short sentence — what the source says (or doesn't) about this claim"
}

If supported is true, the reason states what specifically in the source backs the claim. If false, the reason states what the source actually says — so the user can decide whether to look again or rewrite.`;

export interface ValidateSourceInput {
  claim: string;
  sourceUrl: string;
  sourceText: string;  // already-fetched content (or pasted citation text)
}
export interface ValidateSourceResult {
  supported: boolean;
  reason: string;
}

export async function validateSourceForClaim(input: ValidateSourceInput): Promise<ValidateSourceResult> {
  const userMessage = `CLAIM TO VALIDATE:
"${input.claim}"

SOURCE URL: ${input.sourceUrl || '(no URL — pasted citation text)'}

SOURCE TEXT:
${input.sourceText}

Does this source directly support the claim? Be rigorous.`;
  const result = await callAIWithJSON<ValidateSourceResult>(VALIDATE_SOURCE_SYSTEM, userMessage, 'elite');
  return {
    supported: result.supported === true,
    reason: typeof result.reason === 'string' ? result.reason : '',
  };
}
