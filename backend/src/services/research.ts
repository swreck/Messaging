// Round E1 — Maria as researcher.
//
// Five capabilities backed by Opus calls (quality-floor principle —
// research is judgment-heavy work):
//   1. researchWebsite(url)          — read a live URL, return structured
//                                      offering / audience / differentiator
//                                      candidates the user can confirm.
//   2. researchAudience(audienceName) — return sub-segment cleavages and
//                                      what each cares about, with citations.
//   3. researchSource(claim)          — find a citable backing for a category-
//                                      level claim; integrated into the Round D
//                                      Add-source flow as the "find one for me"
//                                      sub-action.
//   4. testDifferentiation(competitorList, claimedDifferentiators)
//                                    — read each competitor's site, classify
//                                      each claimed differentiator as unique
//                                      vs table stake.
//
// All findings carry citations. When a claim is resolved through these
// services, the existing Round D Claim record gets origin = RESEARCH and
// sourceRef = the URL.
//
// ⚠️ LOCKED — these prompts encode the methodology guardrails the spec
// requires (refuse to invent customer-specific numbers, distinguish category
// claims from product claims, etc). Do not modify without Ken's approval.

import { callAIWithJSON } from './ai.js';

// ─── (1) Read a website to draft offering / audience / differentiators ──

const WEBSITE_SYSTEM = `You read a company's public website and extract three things: a description of what they offer, the audiences they appear to serve, and the differentiators they claim. You are NOT writing marketing copy. You are reading what's there and reporting it accurately so the user can confirm or correct.

Be FACTUAL: only report what the page actually says. If the page is light on detail, return short candidates and flag uncertainty rather than inventing.

Methodology guardrails:
- DIFFERENTIATORS are things the company can do that distinguish them — not table stakes (things every competitor does). If the page only describes table-stake features ("we offer customer support"), say so honestly.
- AUDIENCES are who the company is selling to — the buyer persona, not the end user. If the page mentions multiple, list each.
- OFFERING is what the company sells — the product, the service, the package. Distinguish from the parent company's broader portfolio if applicable.

OUTPUT — return ONLY valid JSON:
{
  "offering": { "name": "...", "description": "2-3 sentences" },
  "audiences": [{ "name": "...", "description": "1-2 sentences" }],
  "differentiators": [{ "text": "...", "evidence": "exact phrase from the page that backs it", "confidence": "high | medium | low" }],
  "uncertainty": "one short sentence — what's unclear or missing from the page that the user should fill in"
}`;

export interface WebsiteResearchInput { url: string; pageText: string }
export interface WebsiteResearchResult {
  offering: { name: string; description: string };
  audiences: { name: string; description: string }[];
  differentiators: { text: string; evidence: string; confidence: string }[];
  uncertainty: string;
}

export async function researchWebsite(input: WebsiteResearchInput): Promise<WebsiteResearchResult> {
  const userMessage = `URL: ${input.url}

PAGE TEXT (extracted from the live page):
${input.pageText.slice(0, 12000)}`;
  const result = await callAIWithJSON<WebsiteResearchResult>(WEBSITE_SYSTEM, userMessage, 'elite');
  return {
    offering: result.offering || { name: '', description: '' },
    audiences: Array.isArray(result.audiences) ? result.audiences : [],
    differentiators: Array.isArray(result.differentiators) ? result.differentiators : [],
    uncertainty: typeof result.uncertainty === 'string' ? result.uncertainty : '',
  };
}

// ─── (2) Sub-segment cleavages on an audience ─────────────────────

const AUDIENCE_SYSTEM = `You are a senior strategist describing the meaningful sub-segments of a named audience. The user typed an audience description; your job is to surface the cleavages — the sharp internal distinctions the user might miss — and what each sub-segment specifically cares about right now.

Return 2-4 sub-segments, each with:
- a label that contrasts it from the others (e.g., "regional bank CFO at independent institution" vs "regional bank CFO post-acquisition"; "growth-mode CFO" vs "financial-stress CFO")
- 2-3 priorities that segment cares about MORE than the others
- short rationale grounded in current industry conditions

Cite sources in inline (Source: X) form. Use named outlets the user could verify (Gartner, Forrester, IDC, FDIC, NHTSA, FMCSA, HDI, FT, WSJ, industry associations, academic journals). If you don't have a confident citation for a sub-segment's priorities, say so — don't fabricate.

OUTPUT — return ONLY valid JSON:
{
  "subsegments": [
    {
      "label": "...",
      "contrast": "what makes this segment distinct from the others",
      "priorities": ["...", "...", "..."],
      "citations": ["Source: ...", "Source: ..."]
    }
  ],
  "uncertainty": "what the user should pick from / clarify"
}`;

export interface AudienceResearchResult {
  subsegments: { label: string; contrast: string; priorities: string[]; citations: string[] }[];
  uncertainty: string;
}

export async function researchAudience(audienceName: string, situation?: string): Promise<AudienceResearchResult> {
  const userMessage = `AUDIENCE: ${audienceName}
${situation ? `\nSITUATION (user-provided context): ${situation}` : ''}

Surface the meaningful sub-segments, what each cares about right now, and citations.`;
  const result = await callAIWithJSON<AudienceResearchResult>(AUDIENCE_SYSTEM, userMessage, 'elite');
  return {
    subsegments: Array.isArray(result.subsegments) ? result.subsegments : [],
    uncertainty: typeof result.uncertainty === 'string' ? result.uncertainty : '',
  };
}

// ─── (3) Find a citable source for a category-level claim ──────────

const SOURCE_SYSTEM = `You find a citable source for a category-level claim in a deliverable. The user wants to back the claim with verifiable evidence; your job is to propose a single best source — a named, verifiable outlet the user could click and confirm — with the URL, the exact passage from the source that backs the claim, and why it backs it.

Methodology guardrails:
- ONLY propose category-level sources (industry research, regulator publications, academic studies, named-outlet journalism). NEVER fabricate a source.
- If you can't find a confident category-level source, return supported = false with a clear reason. The user will see the friendly "I couldn't find a reliable source — want to add one yourself?" message.
- NEVER invent a customer-specific number ("our customers cut crashes 42%"). That's the user's data, not a research finding. If the claim is customer-specific, return supported = false and tell the user this is a placeholder they need to fill from their own measurement.

OUTPUT — return ONLY valid JSON:
{
  "supported": true | false,
  "url": "https://...",
  "outlet": "Gartner | Forrester | IDC | FDIC | NHTSA | FMCSA | HDI | FT | WSJ | ...",
  "passage": "the exact passage from the source that backs the claim",
  "reason": "one short sentence — why this source backs the claim, OR why no source could be found"
}`;

export interface SourceResearchInput { claim: string; context?: string }
export interface SourceResearchResult {
  supported: boolean;
  url: string;
  outlet: string;
  passage: string;
  reason: string;
}

export async function researchSource(input: SourceResearchInput): Promise<SourceResearchResult> {
  const userMessage = `CLAIM TO BACK:
"${input.claim}"

${input.context ? `CONTEXT: ${input.context}` : ''}

Find a citable category-level source, OR refuse honestly if no reliable source exists.`;
  const result = await callAIWithJSON<SourceResearchResult>(SOURCE_SYSTEM, userMessage, 'elite');
  return {
    supported: result.supported === true,
    url: typeof result.url === 'string' ? result.url : '',
    outlet: typeof result.outlet === 'string' ? result.outlet : '',
    passage: typeof result.passage === 'string' ? result.passage : '',
    reason: typeof result.reason === 'string' ? result.reason : '',
  };
}

// ─── (4) Test claimed differentiators against competitors ──────────

const DIFFERENTIATION_SYSTEM = `You read each competitor's site and classify whether each of the user's claimed differentiators is actually unique versus a table stake.

Categories:
- UNIQUE: only the user has this. Tier 1 differentiator material.
- COMMON: most or all of the listed competitors also offer this. Table stake — Tier 3 at most.
- AMBIGUOUS: hard to tell from the public sites; needs deeper research.

For each claimed differentiator, return: classification, the competitors who also have it (if any), and one-line rationale.

OUTPUT — return ONLY valid JSON:
{
  "results": [
    {
      "claim": "<the user's claimed differentiator>",
      "classification": "UNIQUE | COMMON | AMBIGUOUS",
      "competitorsWithIt": ["Competitor A (URL)", ...],
      "rationale": "one-line"
    }
  ],
  "summary": "one short paragraph — overall: how many were genuinely unique, how many were table stakes"
}`;

export interface DifferentiationInput {
  claimedDifferentiators: string[];
  competitors: { name: string; url: string; pageText: string }[];
}
export interface DifferentiationResult {
  results: { claim: string; classification: string; competitorsWithIt: string[]; rationale: string }[];
  summary: string;
}

export async function testDifferentiation(input: DifferentiationInput): Promise<DifferentiationResult> {
  const competitorBlock = input.competitors
    .map((c) => `### ${c.name} — ${c.url}\n${c.pageText.slice(0, 4000)}`)
    .join('\n\n');
  const userMessage = `USER'S CLAIMED DIFFERENTIATORS:
${input.claimedDifferentiators.map((d, i) => `${i + 1}. ${d}`).join('\n')}

COMPETITORS:
${competitorBlock}

Classify each claim as UNIQUE / COMMON / AMBIGUOUS based on what the competitor sites show.`;
  const result = await callAIWithJSON<DifferentiationResult>(DIFFERENTIATION_SYSTEM, userMessage, 'elite');
  return {
    results: Array.isArray(result.results) ? result.results : [],
    summary: typeof result.summary === 'string' ? result.summary : '',
  };
}
