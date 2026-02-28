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
  categoryLabel: string;
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

export type StoryMedium = 'email' | 'blog' | 'social' | 'landing_page' | 'in_person' | 'press_release' | 'newsletter' | 'report';
export type StoryStage = 'chapters' | 'joined' | 'blended';

export const MEDIUM_OPTIONS: { id: StoryMedium; label: string; description: string }[] = [
  { id: 'email', label: 'Email', description: 'Professional outreach email' },
  { id: 'blog', label: 'Blog Post', description: 'Long-form educational content' },
  { id: 'social', label: 'Social Post', description: 'LinkedIn or social media post' },
  { id: 'landing_page', label: 'Landing Page', description: 'Web page with a single conversion goal' },
  { id: 'in_person', label: 'In-Person / Verbal', description: 'Speaking notes for a conversation or presentation' },
  { id: 'press_release', label: 'Press Release', description: 'Formal announcement for media' },
  { id: 'newsletter', label: 'Newsletter', description: 'Regular audience update or feature' },
  { id: 'report', label: 'Report / White Paper', description: 'Detailed analytical content' },
];

export interface FiveChapterStory {
  id: string;
  draftId: string;
  medium: StoryMedium;
  cta: string;
  emphasis: string;
  stage: StoryStage;
  joinedText: string;
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

export interface ChapterVersion {
  id: string;
  chapterContentId: string;
  title: string;
  content: string;
  versionNum: number;
  changeSource: string;
  createdAt: string;
}

export interface StoryVersion {
  id: string;
  storyId: string;
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
  tier2: { text: string; priorityId: string; categoryLabel: string; tier3: string[] }[];
}

export interface InlineSuggestion {
  cell: string;
  suggested: string;
}

export interface ReviewResponse {
  suggestions: InlineSuggestion[];
}

export interface DirectionResponse {
  suggestions: InlineSuggestion[];
}

export interface TableSnapshot {
  tier1: string;
  tier2: { text: string; tier3: string[] }[];
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
