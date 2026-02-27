// ─── Auth ────────────────────────────────────────────

export interface User {
  userId: string;
  username: string;
  isAdmin: boolean;
}

export interface AuthResponse {
  token: string;
  user: User;
}

// ─── Offerings ───────────────────────────────────────

export interface OfferingElement {
  id: string;
  offeringId: string;
  text: string;
  source: string;
  sortOrder: number;
}

export interface Offering {
  id: string;
  userId: string;
  name: string;
  smeRole: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  elements: OfferingElement[];
}

// ─── Audiences ───────────────────────────────────────

export interface Priority {
  id: string;
  audienceId: string;
  text: string;
  rank: number;
  isSpoken: boolean;
  motivatingFactor: string;
  whatAudienceThinks: string;
  sortOrder: number;
}

export interface Audience {
  id: string;
  userId: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  priorities: Priority[];
}

// ─── Three Tier Draft ────────────────────────────────

export interface Mapping {
  id: string;
  draftId: string;
  priorityId: string;
  elementId: string;
  confidence: number;
  status: 'suggested' | 'confirmed' | 'rejected';
  priority: { id: string; text: string; rank: number };
  element: { id: string; text: string };
}

export interface Tier3Bullet {
  id: string;
  tier2Id: string;
  text: string;
  sortOrder: number;
}

export interface Tier2Statement {
  id: string;
  draftId: string;
  text: string;
  sortOrder: number;
  priorityId: string | null;
  tier3Bullets: Tier3Bullet[];
}

export interface Tier1Statement {
  id: string;
  draftId: string;
  text: string;
}

export interface ThreeTierDraft {
  id: string;
  offeringId: string;
  audienceId: string;
  currentStep: number;
  status: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  offering: Offering;
  audience: Audience;
  mappings: Mapping[];
  tier1Statement: Tier1Statement | null;
  tier2Statements: Tier2Statement[];
  tableVersions: TableVersion[];
}

export interface DraftSummary {
  id: string;
  offeringId: string;
  audienceId: string;
  currentStep: number;
  status: string;
  offering: { id: string; name: string };
  audience: { id: string; name: string };
}

// ─── Five Chapter Story ──────────────────────────────

export interface ChapterContent {
  id: string;
  storyId: string;
  chapterNum: number;
  title: string;
  content: string;
}

export interface FiveChapterStory {
  id: string;
  draftId: string;
  medium: '15s' | '1m' | '5m';
  cta: string;
  emphasis: string;
  blendedText: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  chapters: ChapterContent[];
}

// ─── Versions ────────────────────────────────────────

export interface CellVersion {
  id: string;
  text: string;
  versionNum: number;
  changeSource: string;
  createdAt: string;
}

export interface TableVersion {
  id: string;
  draftId: string;
  snapshot: any;
  label: string;
  versionNum: number;
  createdAt: string;
}

// ─── AI Responses ────────────────────────────────────

export interface MappingSuggestion {
  priorityId: string;
  elementId: string;
  confidence: number;
  reasoning: string;
}

export interface MappingSuggestionsResponse {
  mappings: MappingSuggestion[];
  orphanElements: string[];
  priorityGaps: string[];
  clarifyingQuestions: string[];
}

export interface ConvertLinesResponse {
  tier1: { text: string; priorityId: string };
  tier2: { text: string; priorityId: string; tier3: string[] }[];
}

export interface AuditResponse {
  overallScore: number;
  issues: { severity: string; cell: string; issue: string; suggestion: string }[];
  strengths: string[];
  summary: string;
}

export interface MagicHourResponse {
  suggestions: { cell: string; current: string; suggested: string; reason: string }[];
  overallNote: string;
}

// ─── Chapter Info ────────────────────────────────────

export const CHAPTER_NAMES = [
  'You Need This Category',
  'You Need Our Version',
  "We'll Hold Your Hand",
  "You're Not Alone",
  "Let's Get Started",
] as const;

export const CHAPTER_CRITERIA = [
  {
    num: 1,
    name: 'You Need This Category',
    goal: 'Compel action',
    outcome: 'Make the status quo unattractive',
    audienceThinks: "Damn. I didn't really need something new on my top three list but you're totally right and I need to do something.",
  },
  {
    num: 2,
    name: 'You Need Our Version',
    goal: 'Give advice',
    outcome: 'Make the choice obvious',
    audienceThinks: "All right, you make a good case your approach might be the right approach. The solution sounds good.",
  },
  {
    num: 3,
    name: "We'll Hold Your Hand",
    goal: 'Give assurance',
    outcome: 'Eliminate risk',
    audienceThinks: "At least we both have skin in the game. I like the way you work with customers.",
  },
  {
    num: 4,
    name: "You're Not Alone",
    goal: 'Give proof',
    outcome: 'Give confidence',
    audienceThinks: "If your stuff works that well at places like ours, it'll probably work for us.",
  },
  {
    num: 5,
    name: "Let's Get Started",
    goal: 'Give direction',
    outcome: 'Clarify first actions',
    audienceThinks: "Ok, that seems like a risk-free, easy first step. Let's just do it.",
  },
];
