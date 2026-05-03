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

═══ THE KEY DISTINCTION — READ TWICE ═══

User messages in Express Flow fall into two shapes. You must recognize which one
you're reading before you extract anything.

SHAPE A — PRODUCT DESCRIPTION. The user leads with "we make X" or "our product
does Y" or "my company builds Z". The offering IS the thing they described. The
medium is something downstream they want to write about it.
  Example: "We build compliance software for regional banks. Need a pitch deck."
  → OFFERING: the compliance software. MEDIUM: pitch deck.

SHAPE B — SITUATIONAL REQUEST. The user leads with "I need to announce X" or
"I have to write Y" or "we're launching Z". The thing they need to communicate
is a TASK. The offering behind the task is their UNDERLYING BUSINESS — their
club, their company, their practice, the service they run. It is almost never
the deliverable they asked for. A "chef announcement" is not an offering; the
club is. A "product launch email" is not an offering; the product (or the
company) is.
  Example: "I need to send members an announcement about our new dining policy."
  → OFFERING: the club (its dining experience, its member relationships).
              NOT "Dining Policy Announcement."
     MEDIUM: email or newsletter (the announcement).
  Example: "I have to write a board update on Q3."
  → OFFERING: the company being reported on.
              NOT "Board Update."
     MEDIUM: report (or whatever format fits).

When you cannot identify an obvious underlying business, extract the most
plausible one from context and mark it inferred. Never name the offering after
the deliverable. If the only name you can think of is the task itself, invent
a short placeholder like "My company" or "The club" and mark it inferred — the
user will rename it in the review step.

═══ WHAT TO EXTRACT ═══

1. OFFERING — the underlying business, product, service, or organization the
   user offers. NOT the deliverable. See SHAPE A vs SHAPE B above.
   - name (or a plausible short name if not stated — never name it after the
     task the user asked for)
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

4. SITUATION — the specific thing the user needs THIS deliverable to do.
   Two to four sentences. Captures the occasion, the trigger, and what the
   reader needs to walk away knowing or feeling. This is the single most
   important thing you extract — it is the difference between a generic
   "about the product" draft and a draft that actually does the user's job.

   WRITE IN SECOND PERSON. Address the user directly as "you". Never use
   their name or refer to them in third person ("the user", "Dina", "Rosa").
   This block gets passed into the generation prompts downstream — third
   person framing would leak into the draft.

     Example A (second-person, correct): "You need to announce a new dining
     policy to the full membership — dinner now requires three days advance
     notice instead of walk-in booking. Your board approved it last week.
     The email needs to land softly without starting a revolt, especially
     with your long-tenured founding members."

     Example B (second-person, correct): "You need a pitch deck narrative
     for a regional bank CFO conference on Friday. The room will be full of
     community and regional bank CFOs being squeezed by 2026 FFIEC updates
     on shrinking budgets. The deck has to make your offering the obvious
     answer to that specific pressure, and the deadline is Thursday."

   Include the user's goal, the audience, the constraints, and anything
   specific about the occasion. If the user gave you a deadline, a venue,
   or a specific scenario, include it verbatim. Never generalize this to
   "write a pitch deck about the offering" — that loses the situation.

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
- The deliverable the user asked for is the MEDIUM, not the OFFERING. Re-check
  your output before returning: if offering.name contains words like "Announcement",
  "Update", "Email", "Post", "Newsletter", "Pitch", "Launch", or "Memo", you
  confused the task for the offering. Rename the offering to the underlying
  business and move the task concept into primaryMedium.

═══ THE VERBATIM ASK ═══

Extract verbatimAsk: the user's call-to-action with all signal preserved
and only the noise dropped.

PRESERVE the signal — every word that carries action meaning:
  - The action verb and its object
  - Real deadlines (a date, "by Friday", "before quarter-end")
  - Real scope (the audience-org name, possessives that specify what
    the action is about)
  - Modifiers and articles that come with the action

DROP the noise — only these:
  - Imperative-marker prefixes: "I want them to", "we want him to",
    "I'm asking them to", "tell them to", "have them", "the ask is",
    "the cta is", and close variants.
  - Filler words: "like", "kind of", "sort of", "you know"
  - Hedges: "or whenever works", "if possible", "when they get a chance"

Do NOT touch anything outside that list. Possessives stay. Articles
stay. Modifiers stay.

WORKED EXAMPLES:

User typed: "We want him to confirm Veracore's participation in our
joint Q3 webinar by May 15."
verbatimAsk: "confirm Veracore's participation in our joint Q3 webinar
by May 15."
(Possessive "Veracore's" preserved. Imperative-marker "We want him to"
dropped.)

User typed: "we want him to like sign up for the demo by friday or
whenever works."
verbatimAsk: "sign up for the demo by Friday."
(Filler "like" dropped, hedge "or whenever works" dropped, real deadline
"Friday" preserved.)

User typed: "Tell them to confirm participation by May 15."
verbatimAsk: "confirm participation by May 15."
(Imperative-marker "Tell them to" dropped.)

User typed: "I want them to schedule the partner's onboarding kickoff
by Friday."
verbatimAsk: "schedule the partner's onboarding kickoff by Friday."
(Possessive "the partner's" preserved.)

TONE NOTES ARE NOT ASKS. If the user said "the tone should be partner-to-
partner, not sales pitch" — that's tone, not an ask. Skip it.

If the user did not state an ask, return empty string. Empty is better
than fabricated.

═══ ENRICHMENT — MOTIVATING FACTORS AND DRIVERS ═══

For EACH differentiator, draft a Motivating Factor (MF): WHY would someone
crave this? State the general benefit principle, then name 2-3 concrete
audience types that would care about it. The MF bridges the differentiator
to any audience's priorities. Keep it literal — no buzzwords, no
metaphorical verbs. Two to three sentences.

For EACH priority, draft a Driver: WHY is this priority so personal to THIS
specific audience? What happens to THEM if this goes wrong? What's the
specific situation that makes this priority urgent? Reference the persona's
role, constraints, fears. Two to three sentences. Write as if you know
this person — make it specific enough that the user will either nod and
say "exactly" or correct you with better detail.

═══ MARIA'S RESPONSE ═══

Also generate three short Maria voice responses:
1. mariaAcknowledgment — one sentence summarizing what you understood (e.g.
   "Clear picture — healthcare workflow against Epic and Cerner, pitched
   to a CFO who controls the budget."). Direct, specific, no fluff.
2. mariaContextNote — one sentence directing the user's attention to the
   enrichment (e.g. "Take a look — especially the 'why' notes under each
   item. If I got the reason wrong, the whole message will aim wrong.").
3. mariaQuestion — one good question that would make the user think for 3
   seconds and then say "actually, good question." The question should
   surface a differentiator or priority they haven't mentioned. Examples:
   "Is there something you offer that [competitor] honestly can't claim?"
   "What would get [audience role] fired? That's usually near the top."

═══ OUTPUT FORMAT ═══

Return ONLY valid JSON in this exact shape (no markdown, no code fences):

{
  "offering": {
    "name": "...",
    "nameSource": "stated" | "inferred",
    "description": "...",
    "differentiators": [
      { "text": "...", "source": "stated" | "inferred", "motivatingFactor": "..." }
    ]
  },
  "audiences": [
    {
      "name": "...",
      "description": "...",
      "source": "stated" | "inferred",
      "priorities": [
        { "text": "...", "source": "stated" | "inferred", "driver": "..." }
      ]
    }
  ],
  "primaryMedium": {
    "value": "email",
    "source": "stated" | "inferred",
    "reasoning": "one short sentence on why this medium"
  },
  "situation": "two to four sentences capturing the specific thing this deliverable needs to do — the occasion, the trigger, the audience reaction you're aiming for, any constraint or deadline. See Example A and Example B above.",
  "verbatimAsk": "the user's literal call-to-action sentence — see THE VERBATIM ASK section above. Empty string when the user did not state an ask.",
  "confidenceNotes": "one sentence on overall confidence — were you mostly reading stated facts, or mostly inferring? Flag any place where you felt the description was too thin to extract reliably.",
  "mariaAcknowledgment": "...",
  "mariaContextNote": "...",
  "mariaQuestion": "..."
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

// Bundle 1A rev6 Phase 1 — canonical interpretation interface.
// `mode` and `verbatimAsk` were previously ad-hoc fields applied at
// various construction sites (rev2 added `autonomousMode: boolean`,
// rev5 added `verbatim_ask: string`, runDraftPipeline wrote `cta`).
// All ad-hoc additions removed; this interface is the single source
// of truth. mariaAcknowledgment/Maria*-fields are Express-extraction-
// specific and now optional (commitExistingForPipeline and
// runDraftPipeline have no meaningful values).
export interface ExpressInterpretation {
  mode: 'autonomous' | 'guided';
  offering: {
    name: string;
    nameSource: FactSource;
    description: string;
    differentiators: { text: string; source: FactSource; motivatingFactor: string }[];
  };
  audiences: {
    name: string;
    description: string;
    source: FactSource;
    priorities: { text: string; source: FactSource; driver: string }[];
  }[];
  primaryMedium: {
    value: ExpressMedium;
    source: FactSource;
    reasoning: string;
  };
  situation: string;
  verbatimAsk: string;
  confidenceNotes: string;
  mariaAcknowledgment?: string;
  mariaContextNote?: string;
  mariaQuestion?: string;
}

// ─── Extraction function ────────────────────────────────────

export async function extractExpressInterpretation(
  userMessage: string,
): Promise<ExpressInterpretation> {
  const result = await callAIWithJSON<ExpressInterpretation>(
    EXPRESS_EXTRACTION_SYSTEM,
    userMessage,
    'deep', // Sonnet 4.6 — validated by spike
  );
  // Bundle 1A rev6 — coerce to canonical shape. Express extraction is
  // unconditionally autonomous (the only entry point that calls this
  // function is the Express-flow autonomous build). verbatimAsk is
  // trimmed; downstream readers expect a non-undefined string.
  result.mode = 'autonomous';
  result.verbatimAsk = (result.verbatimAsk ?? '').trim();
  return result;
}

// ─── Schema migration helpers (Bundle 1A rev6 Phase 1.F) ──────────────
// Legacy ExpressJob rows in the database were written with various
// ad-hoc field shapes during rev2-5. These helpers coalesce: prefer
// the canonical shape; fall back to legacy shapes; default if nothing
// matches. TODO(rev7): remove legacy coalescing once legacy ExpressJob
// rows have aged out (>30 days post-rev6 deploy is a reasonable cutoff).

export function getInterpretationMode(interp: any): 'autonomous' | 'guided' {
  if (!interp || typeof interp !== 'object') return 'guided';
  // Canonical (rev6+): explicit mode field.
  if (interp.mode === 'autonomous' || interp.mode === 'guided') {
    return interp.mode;
  }
  // Legacy (rev2-5): autonomousMode boolean.
  // TODO(rev7): remove legacy coalescing once legacy ExpressJob rows have aged out.
  if (interp.autonomousMode === true) return 'autonomous';
  if (interp.guided === true) return 'guided';
  // Default: guided. Safer fallback than autonomous because guided
  // skips the AUTONOMOUS_BUILD_COMPLETE write and post-delivery offer
  // — i.e., a misclassification falls quiet rather than firing the
  // wrong locked Cowork copy.
  return 'guided';
}

/**
 * Bundle 1A rev6 Phase 3 — deterministic verbatim CTA placement in Ch5.
 *
 * After chapter 5 generation completes, ensure the chapter content
 * carries the user's verbatim ask. The soft ctaVerbatimDirective in the
 * chapter prompt lets Opus integrate the verbatim into prose flow
 * naturally on most attempts; this post-process is the safety net
 * when Opus paraphrases despite the directive.
 *
 * Behavior:
 * - If verbatimAsk is empty: return content unchanged (skip).
 * - If verbatimAsk already appears in content (case-insensitive,
 *   whitespace-normalized substring match): return content unchanged
 *   (Opus honored the directive).
 * - Otherwise: replace the LAST sentence of content with the verbatimAsk.
 *   Last-sentence detection: split on /[.!?]+\s+/, drop empty trailing
 *   splits, take the final segment. Replacement: capitalize first char
 *   of verbatimAsk if currently lowercase; append '.' if verbatimAsk
 *   does not end with terminal punctuation.
 *
 * Ensures Ch5 always closes with the user's verbatim ask — consistent
 * with Ch5's methodology role as the call-to-action chapter.
 */
export function ensureCh5VerbatimAsk(content: string, verbatimAsk: string): string {
  if (!verbatimAsk || verbatimAsk.trim().length === 0) return content;
  if (!content || content.trim().length === 0) return content;

  const askTrimmed = verbatimAsk.trim();
  // Whitespace-normalized case-insensitive substring check.
  const contentNorm = content.toLowerCase().replace(/\s+/g, ' ');
  const askNorm = askTrimmed.toLowerCase().replace(/\s+/g, ' ');
  if (contentNorm.includes(askNorm)) {
    return content; // Opus already integrated the verbatim.
  }

  // Capitalize the first letter of verbatimAsk if currently lowercase.
  const first = askTrimmed.charAt(0);
  const isLowerLetter = first >= 'a' && first <= 'z';
  const capitalized = isLowerLetter ? first.toUpperCase() + askTrimmed.slice(1) : askTrimmed;
  // Append terminal punctuation if missing.
  const lastChar = capitalized.charAt(capitalized.length - 1);
  const hasTerminalPunct = lastChar === '.' || lastChar === '!' || lastChar === '?';
  const finalAsk = hasTerminalPunct ? capitalized : `${capitalized}.`;

  // Replace the LAST sentence. Sentence boundary regex: [.!?]+ followed
  // by whitespace OR end-of-string. We split, drop trailing empties, then
  // rejoin everything but the last segment, appending the verbatim ask.
  const trailingWs = content.match(/\s*$/)?.[0] ?? '';
  const trimmedContent = content.replace(/\s+$/, '');
  // Find the start position of the last sentence by scanning back from
  // the end for the most recent terminal-punct-followed-by-whitespace.
  // Pattern matches the boundary BEFORE the final sentence.
  const boundaryMatch = trimmedContent.match(/^(.*[.!?]+\s+)([^.!?]+(?:[.!?]+)?)$/s);
  if (!boundaryMatch) {
    // Single-sentence content — replace the whole thing.
    return `${finalAsk}${trailingWs}`;
  }
  const prefix = boundaryMatch[1];
  return `${prefix}${finalAsk}${trailingWs}`;
}

export function getInterpretationVerbatimAsk(interp: any): string {
  if (!interp || typeof interp !== 'object') return '';
  // Canonical (rev6+): explicit verbatimAsk field.
  if (typeof interp.verbatimAsk === 'string' && interp.verbatimAsk.trim().length > 0) {
    return interp.verbatimAsk.trim();
  }
  // Legacy rev5 shape: snake_case verbatim_ask.
  // TODO(rev7): remove legacy coalescing once legacy ExpressJob rows have aged out.
  if (typeof interp.verbatim_ask === 'string' && interp.verbatim_ask.trim().length > 0) {
    return interp.verbatim_ask.trim();
  }
  // Legacy guided-old shape: cta field on the interpretation object
  // (runDraftPipeline:3408 wrote `interpretation: { guided: true, medium, cta, situation }`).
  // No active reader downstream; defensive against persisted ExpressJob
  // rows that may have been written by an older code path per Cowork.
  if (typeof interp.cta === 'string' && interp.cta.trim().length > 0) {
    return interp.cta.trim();
  }
  return '';
}
