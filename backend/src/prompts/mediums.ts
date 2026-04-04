// Medium specifications for Five Chapter Story content formats

export interface MediumSpec {
  id: string;
  label: string;
  description: string;
  wordRange: [number, number];
  chapterBudgets: [number, number, number, number, number];
  format: string;
  formatRules: string;
  tone: string;
}

export const MEDIUM_SPECS: Record<string, MediumSpec> = {
  email: {
    id: 'email',
    label: 'Email',
    description: 'Professional outreach email',
    wordRange: [150, 250],
    chapterBudgets: [30, 60, 25, 25, 20],
    format: 'Subject line, opening hook, 2-3 body paragraphs, clear CTA. No headers beyond subject.',
    formatRules: 'This is a single-scroll business email. Chapter 1 is 1-2 sentences max. The entire email must feel like something a person actually sent, not a marketing piece. No section headers. No bullet lists longer than 3 items.',
    tone: 'Direct and personal. Written to one person, not a list.',
  },
  blog: {
    id: 'blog',
    label: 'Blog Post',
    description: 'Long-form educational content',
    wordRange: [600, 1200],
    chapterBudgets: [150, 300, 150, 200, 50],
    format: 'Title, introduction, 3-5 sections with subheads, conclusion with CTA.',
    formatRules: 'Long-form content with room to develop ideas. Use subheads to break up sections. Each chapter naturally becomes a section.',
    tone: 'Informative and authoritative but approachable. Teach, don\'t sell.',
  },
  social: {
    id: 'social',
    label: 'Social Post',
    description: 'LinkedIn or social media post',
    wordRange: [40, 100],
    chapterBudgets: [15, 30, 15, 15, 15],
    format: 'Hook line, 2-4 short paragraphs or bullets, CTA. No headers.',
    formatRules: 'Extremely tight. Every word counts. Chapters are woven together — no visible structure.',
    tone: 'Punchy and conversational. Stop the scroll.',
  },
  landing_page: {
    id: 'landing_page',
    label: 'Landing Page',
    description: 'Web page with a single conversion goal',
    wordRange: [200, 500],
    chapterBudgets: [40, 120, 60, 80, 30],
    format: 'Hero headline + subhead, 3-4 value sections with short headers, social proof snippet, CTA button text.',
    formatRules: 'Scannable. Short paragraphs, subheads, and bullet points. The reader skims — make every line standalone.',
    tone: 'Confident and clear. Every word earns its place.',
  },
  in_person: {
    id: 'in_person',
    label: 'In-Person / Verbal',
    description: 'Speaking notes for a conversation or presentation',
    wordRange: [100, 400],
    chapterBudgets: [40, 100, 60, 80, 30],
    format: 'Speaker note bullets per chapter. Brief triggers, not a script. Natural conversation flow.',
    formatRules: 'These are talking points, not prose. Short phrases a speaker can glance at. No full paragraphs.',
    tone: 'Casual and confident. How you\'d actually talk to someone.',
  },
  press_release: {
    id: 'press_release',
    label: 'Press Release',
    description: 'Formal announcement for media',
    wordRange: [400, 800],
    chapterBudgets: [80, 180, 80, 100, 40],
    format: 'Standard press release structure. Chapter 1 MUST start with: "FOR IMMEDIATE RELEASE" on its own line, then a bold **Headline** (factual, not marketing), then a one-sentence *Subhead*, then a dateline "[City, State] — [Date] —" followed by the lead paragraph. Chapter 5 MUST end with: an "About [Company]" boilerplate paragraph (2-3 sentences about the company), then "Media Contact:" with placeholder name, email, and phone on separate lines.',
    formatRules: 'Inverted pyramid — most important information first. Lead paragraph should stand alone as a complete news summary. Use attributed quotes for any opinion or value claims ("said [Name], [Title]"). No marketing language in body text. The structural elements (FOR IMMEDIATE RELEASE, headline, subhead, dateline, About section, Media Contact) are mandatory — without them this is not a press release.',
    tone: 'Professional and newsworthy. Facts first, opinion in quotes only. Write as if a journalist will read this and decide whether to cover the story.',
  },
  newsletter: {
    id: 'newsletter',
    label: 'Newsletter',
    description: 'Regular audience update or feature',
    wordRange: [200, 500],
    chapterBudgets: [50, 120, 60, 80, 30],
    format: 'Teaser/hook, main content section, quick takeaway or key point, CTA.',
    formatRules: 'Written for someone who already knows you. Skip the throat-clearing. Get to the point fast.',
    tone: 'Friendly and familiar. Like writing to someone who already knows you.',
  },
  report: {
    id: 'report',
    label: 'Report / White Paper',
    description: 'Detailed analytical content',
    wordRange: [800, 2000],
    chapterBudgets: [200, 500, 300, 350, 100],
    format: 'Executive summary, problem statement, analysis sections, recommendations, conclusion.',
    formatRules: 'Detailed and structured. Data-driven. Use evidence to support every claim. Formal section headers.',
    tone: 'Analytical and evidence-based. Show your work.',
  },
};

export const MEDIUM_IDS = Object.keys(MEDIUM_SPECS) as (keyof typeof MEDIUM_SPECS)[];

export function getMediumSpec(medium: string): MediumSpec {
  // Direct match
  if (MEDIUM_SPECS[medium]) return MEDIUM_SPECS[medium];

  // Fuzzy match: check if any known medium key appears in the custom name
  const lower = medium.toLowerCase();
  for (const [key, spec] of Object.entries(MEDIUM_SPECS)) {
    if (lower.includes(key) || lower.includes(spec.label.toLowerCase())) {
      return spec;
    }
  }

  // Default to blog (general-purpose) rather than email (format-specific)
  return MEDIUM_SPECS.blog;
}
