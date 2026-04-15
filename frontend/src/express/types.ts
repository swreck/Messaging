// Express Flow — shared types
//
// Mirrors backend/src/lib/expressExtraction.ts. Kept in sync by convention.

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
  // The specific thing the user needs this deliverable to do. Captures the
  // situation / occasion / announcement so the generation pipeline produces
  // a draft ABOUT that thing, not a generic value story about the offering.
  // Without this, Rosa's "announce the dining policy change" becomes a
  // generic "about the club" email, and Dina's "pitch deck for the Friday
  // CFO conference" becomes a generic "about Claris" deck.
  situation: string;
  confidenceNotes: string;
}
