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
  confidenceNotes: string;
}
