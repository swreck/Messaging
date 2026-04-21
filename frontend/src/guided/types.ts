export type FactSource = 'stated' | 'inferred';

export type GuidedMedium =
  | 'email'
  | 'pitch deck'
  | 'landing page'
  | 'blog post'
  | 'press release'
  | 'talking points'
  | 'newsletter'
  | 'one-pager'
  | 'report';

export interface EnrichedInterpretation {
  offering: {
    name: string;
    nameSource: FactSource;
    description: string;
    differentiators: {
      text: string;
      source: FactSource;
      motivatingFactor: string;
    }[];
  };
  audiences: {
    name: string;
    description: string;
    source: FactSource;
    priorities: {
      text: string;
      source: FactSource;
      driver: string;
    }[];
  }[];
  primaryMedium: {
    value: GuidedMedium;
    source: FactSource;
    reasoning: string;
  };
  situation: string;
  confidenceNotes: string;
  mariaAcknowledgment: string;
  mariaContextNote: string;
  mariaQuestion: string;
}

export interface FoundationTier3 {
  id: string;
  text: string;
}

export interface FoundationTier2 {
  id: string;
  text: string;
  categoryLabel: string;
  priorityId: string | null;
  tier3: FoundationTier3[];
}

export interface FoundationData {
  draftId: string;
  offeringId: string;
  audienceId: string;
  tier1: { id: string; text: string } | null;
  tier2: FoundationTier2[];
  audienceName: string;
}

export type GuidedPhase =
  | 'greeting'
  | 'extracting'
  | 'confirming_inputs'
  | 'generating_foundation'
  | 'reviewing_foundation'
  | 'choosing_format'
  | 'generating_draft'
  | 'reviewing_draft'
  | 'complete';

export type GuidedStage = 'inputs' | 'foundation' | 'deliverable';

export interface ChatMessage {
  id: string;
  type: 'maria' | 'user' | 'input-card' | 'foundation-card' | 'draft-view' | 'thinking' | 'progress' | 'format-prompt';
  text?: string;
  interpretation?: EnrichedInterpretation;
  foundation?: FoundationData;
  draft?: { blendedText: string; medium: string; chapters?: { chapterNum: number; title: string; content: string }[] };
  stage?: string;
  progress?: number;
}
