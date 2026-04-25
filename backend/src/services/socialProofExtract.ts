// Social Proof Extraction — typed extraction of named specifics from Tier 3.
//
// The April 18 pipeline used a narrow regex to detect named customers in
// Tier 3 bullets so Chapter 4 could only cite those names. The regex matched
// only organization names with specific suffixes (Bank, Hospital, Clinic,
// Health, Medical, Regional, Community, Inc, LLC, Ltd, Co, Corporation,
// University, College, School, Center). It missed:
//   - Certifications (FDA approval, SOC 2, HIPAA, ISO 27001)
//   - Awards (HIMSS Innovation Award, Gartner Magic Quadrant)
//   - Publications / analyst citations (Forbes, WSJ, Gartner, Forrester)
//   - Named individuals (cited experts, research authors)
//   - Regulatory bodies (FDA, FINRA, CFPB without institutional suffix)
//
// This service replaces the regex with an Opus extraction pass. Every named
// specific in Tier 3 is typed so the Ch4 guardrail can use ALL of them, not
// just customer names, when deciding what social proof is available.
//
// Methodology note: Ken's Tier 3 standard is "proof only — verifiable facts."
// Named specifics of any kind are valid proof. The Ch4 social proof chapter
// should be anchored in WHATEVER named proof exists, not only customers.

import { callAIWithJSON } from './ai.js';

// ─── Types ─────────────────────────────────────────────────────

export type SocialProofType =
  | 'customer'       // named organizations using the product
  | 'certification'  // FDA approval, SOC 2, ISO 27001, HIPAA
  | 'award'          // HIMSS Innovation Award, Gartner Magic Quadrant Leader
  | 'publication'    // article in Forbes/WSJ, analyst report citation
  | 'individual'     // named expert, researcher, designer of the methodology
  | 'regulator'      // FDA, FINRA, CFPB, SEC (as an entity that has reviewed/cleared/uses)
  | 'adoption_number'; // specific adoption counts ("300 hospitals", "over 50 banks")

export interface SocialProofItem {
  type: SocialProofType;
  // The exact short text that names the specific (e.g. "Baptist Health",
  // "FDA approval pending", "Gartner Magic Quadrant 2024 Leader"). Preserve
  // the original wording where possible so Chapter 4 can quote faithfully.
  name: string;
}

export interface SocialProofExtraction {
  items: SocialProofItem[];
}

// ─── Prompt ────────────────────────────────────────────────────

const EXTRACTOR_SYSTEM = `You extract NAMED SPECIFICS from Tier 3 proof bullets of
a Three Tier message. Your only job is to return a typed list of the concrete,
verifiable facts that are already present in the bullets so a downstream
Chapter 4 writer knows exactly what social proof it is allowed to cite.

A NAMED SPECIFIC is a fact a skeptic could independently verify. It falls into
one of these types:

- "customer" — a named organization that uses, evaluates, or has adopted the
  offering. Examples: "Baptist Health", "Mount Sinai", "Geisinger Clinic",
  "Humana", "Apple", "Mayo Clinic".

- "certification" — a named certification, regulatory approval, or compliance
  standard. Examples: "FDA approval pending", "SOC 2 Type II certified",
  "HIPAA compliant", "ISO 27001", "CE marking".

- "award" — a named award, recognition, or industry ranking. Examples:
  "HIMSS Innovation Award 2024", "Forrester Wave Leader 2024",
  "Gartner Magic Quadrant Leader".

- "publication" — a named publication, article, or analyst citation.
  Examples: "featured in Forbes", "Wall Street Journal coverage",
  "Gartner research note", "MIT Technology Review profile".

- "individual" — a named person tied to the product's credibility.
  Examples: "methodology designed by Dr. Jane Smith", "Stanford researcher
  Prof. John Doe authored the approach".

- "regulator" — a named regulatory agency that has engaged with or uses the
  product in a way that confers credibility. Examples: "used by the FDA for
  companion diagnostic validation", "CFPB-aligned control framework".

- "adoption_number" — a specific count of adoption that is itself the proof.
  Examples: "300+ hospitals in production", "over 50 community banks live",
  "14 enterprise customers".

═══ RULES ═══

1. Extract ONLY what is literally stated in the provided bullets. Never
   infer, paraphrase into a new specific, or generate fresh claims.

2. One named specific per item. If a single bullet contains two, return two
   items. "FDA approval pending; Baptist Health evaluation" → two items.

3. Preserve the original wording. "FDA approval pending" stays "FDA approval
   pending" — do not rewrite as "FDA-approved product".

4. If a bullet has NO named specific — e.g. "faster turnaround", "better
   accuracy", "cost under $1 per test" — skip it. A number alone without
   an entity is not social proof; it's a metric proof bullet, and goes in
   other chapters.

5. Numbers ARE named specifics only when they describe ADOPTION. "$4,000
   reduced to under $1" is a metric, not adoption — skip it. "300+ hospitals
   in production" is adoption — extract as "adoption_number".

6. Generic gestures are NOT named specifics. Skip "trusted by industry
   leaders", "multiple community banks", "several enterprise customers",
   "customers like yours". If there's no specific entity or count, skip.

═══ INPUT ═══

A list of Tier 3 bullet texts, one per line.

═══ OUTPUT ═══

Return ONLY valid JSON, no markdown fences:

{
  "items": [
    { "type": "customer", "name": "Baptist Health" },
    { "type": "certification", "name": "FDA approval pending" },
    { "type": "adoption_number", "name": "300+ hospitals in production" }
  ]
}

If no named specifics are found, return: { "items": [] }`;

// ─── Function ──────────────────────────────────────────────────

export async function extractSocialProof(
  tier3Bullets: string[],
): Promise<SocialProofExtraction> {
  const cleaned = tier3Bullets
    .map(b => (b || '').trim())
    .filter(b => b.length > 0);

  if (cleaned.length === 0) {
    return { items: [] };
  }

  const userMessage = `TIER 3 BULLETS:\n${cleaned.map((b, i) => `${i + 1}. ${b}`).join('\n')}`;

  try {
    const result = await callAIWithJSON<SocialProofExtraction>(
      EXTRACTOR_SYSTEM,
      userMessage,
      'fast', // Sonnet floor — structured extraction, no judgment needed
    );
    return {
      items: Array.isArray(result.items) ? result.items : [],
    };
  } catch (err) {
    console.error('[socialProofExtract] error (fail-open with empty):', err);
    return { items: [] };
  }
}

// ─── Helpers ───────────────────────────────────────────────────

export function groupByType(items: SocialProofItem[]): Record<SocialProofType, string[]> {
  const out: Record<SocialProofType, string[]> = {
    customer: [],
    certification: [],
    award: [],
    publication: [],
    individual: [],
    regulator: [],
    adoption_number: [],
  };
  for (const item of items) {
    if (!out[item.type]) continue;
    out[item.type].push(item.name);
  }
  return out;
}
