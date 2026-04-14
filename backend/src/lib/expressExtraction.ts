// Express Flow — silent extraction helper.
//
// Takes a free-form user description and returns a structured interpretation
// the user can review and edit. Validated against 5 real offering descriptions
// during the spike phase — Sonnet 4.6 handles this reliably in one shot with
// ~10 second latency.
//
// No DB writes. Pure function that turns a message into JSON. The route that
// calls this does not commit anything — commit happens in a separate step
// after the user confirms the interpretation.

import { callAIWithJSON } from '../services/ai.js';

// ─── The prompt ─────────────────────────────────────────────

const EXPRESS_EXTRACTION_SYSTEM = `You are the silent extractor for Maria's Express Flow.

A user has written a free-form message describing their offering and what they
want to communicate. Your job is to extract structured facts so the downstream
pipeline (Three Tier builder, Five Chapter Story generator) can run without
asking any follow-up questions.

═══ WHAT TO EXTRACT ═══

1. OFFERING
   - name (or a plausible short name if not stated)
   - one-paragraph description written in the user's own terms
   - 4-10 differentiators/capabilities — things the offering actually does or is

2. AUDIENCES (usually 1, sometimes 2 if the user clearly describes more than one)
   - name (e.g. "CISO at mid-size bank", "Oncologist at academic hospital")
   - short description of who they are and what they do
   - 4-6 priorities (what they care about, in their language — THEIR concerns, not
     product features reflected back)

3. PRIMARY MEDIUM — what the user most likely needs right now, picked from:
   email | pitch deck | landing page | blog post | press release |
   talking points (in-person meeting) | newsletter | one-pager | report

═══ RULES ═══

- Use the user's own words when you can. Do not polish or marketing-ify.
- Tag every item as "stated" (user said it directly) or "inferred" (you're guessing
  from context). Be honest about which is which. Downstream the user may want to
  edit the inferred ones.
- Never invent claims the user did not make.
- Priorities are the AUDIENCE'S strategic concerns (things they stay up at night
  about, things they'd say to a peer). Not features. Not what the product does.
- If the user was explicit about their audience ("I'm writing to CFOs of community
  banks"), use that. If they were vague ("our customers"), infer a plausible primary
  audience and mark it inferred.
- If the user said what medium they need, use it (stated). If they didn't, infer
  from context and mark it inferred.

═══ OUTPUT FORMAT ═══

Return ONLY valid JSON in this exact shape (no markdown, no code fences):

{
  "offering": {
    "name": "...",
    "nameSource": "stated" | "inferred",
    "description": "...",
    "differentiators": [
      { "text": "...", "source": "stated" | "inferred" }
    ]
  },
  "audiences": [
    {
      "name": "...",
      "description": "...",
      "source": "stated" | "inferred",
      "priorities": [
        { "text": "...", "source": "stated" | "inferred" }
      ]
    }
  ],
  "primaryMedium": {
    "value": "email",
    "source": "stated" | "inferred",
    "reasoning": "one short sentence on why this medium"
  },
  "confidenceNotes": "one sentence on overall confidence — were you mostly reading stated facts, or mostly inferring? Flag any place where you felt the description was too thin to extract reliably."
}`;

// ─── Types ──────────────────────────────────────────────────

export type FactSource = 'stated' | 'inferred';

export type ExpressMedium =
  | 'email'
  | 'pitch deck'
  | 'landing page'
  | 'blog post'
  | 'press release'
  | 'talking points'
  | 'newsletter'
  | 'one-pager'
  | 'report';

export interface ExpressInterpretation {
  offering: {
    name: string;
    nameSource: FactSource;
    description: string;
    differentiators: { text: string; source: FactSource }[];
  };
  audiences: {
    name: string;
    description: string;
    source: FactSource;
    priorities: { text: string; source: FactSource }[];
  }[];
  primaryMedium: {
    value: ExpressMedium;
    source: FactSource;
    reasoning: string;
  };
  confidenceNotes: string;
}

// ─── Extraction function ────────────────────────────────────

export async function extractExpressInterpretation(
  userMessage: string,
): Promise<ExpressInterpretation> {
  return callAIWithJSON<ExpressInterpretation>(
    EXPRESS_EXTRACTION_SYSTEM,
    userMessage,
    'deep', // Sonnet 4.6 — validated by spike
  );
}
