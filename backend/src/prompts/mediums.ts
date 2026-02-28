// Medium specifications for Five Chapter Story content formats

export interface MediumSpec {
  id: string;
  label: string;
  description: string;
  wordRange: [number, number];
  format: string;
  tone: string;
}

export const MEDIUM_SPECS: Record<string, MediumSpec> = {
  email: {
    id: 'email',
    label: 'Email',
    description: 'Professional outreach email',
    wordRange: [150, 300],
    format: 'Subject line, opening hook, 2-3 body paragraphs, clear CTA. No headers beyond subject.',
    tone: 'Direct and personal. Written to one person, not a list.',
  },
  blog: {
    id: 'blog',
    label: 'Blog Post',
    description: 'Long-form educational content',
    wordRange: [600, 1200],
    format: 'Title, introduction, 3-5 sections with subheads, conclusion with CTA.',
    tone: 'Informative and authoritative but approachable. Teach, don\'t sell.',
  },
  social: {
    id: 'social',
    label: 'Social Post',
    description: 'LinkedIn or social media post',
    wordRange: [40, 150],
    format: 'Hook line, 2-4 short paragraphs or bullets, CTA. No headers.',
    tone: 'Punchy and conversational. Stop the scroll.',
  },
  landing_page: {
    id: 'landing_page',
    label: 'Landing Page',
    description: 'Web page with a single conversion goal',
    wordRange: [200, 500],
    format: 'Hero headline + subhead, 3-4 value sections with short headers, social proof snippet, CTA button text.',
    tone: 'Confident and clear. Every word earns its place.',
  },
  in_person: {
    id: 'in_person',
    label: 'In-Person / Verbal',
    description: 'Speaking notes for a conversation or presentation',
    wordRange: [100, 400],
    format: 'Speaker note bullets per chapter. Brief triggers, not a script. Natural conversation flow.',
    tone: 'Casual and confident. How you\'d actually talk to someone.',
  },
  press_release: {
    id: 'press_release',
    label: 'Press Release',
    description: 'Formal announcement for media',
    wordRange: [300, 600],
    format: 'Headline, dateline + lead paragraph, body with quotes, boilerplate. Inverted pyramid.',
    tone: 'Professional and newsworthy. Facts first, opinion in quotes only.',
  },
  newsletter: {
    id: 'newsletter',
    label: 'Newsletter',
    description: 'Regular audience update or feature',
    wordRange: [200, 500],
    format: 'Teaser/hook, main content section, quick takeaway or key point, CTA.',
    tone: 'Friendly and familiar. Like writing to someone who already knows you.',
  },
  report: {
    id: 'report',
    label: 'Report / White Paper',
    description: 'Detailed analytical content',
    wordRange: [800, 2000],
    format: 'Executive summary, problem statement, analysis sections, recommendations, conclusion.',
    tone: 'Analytical and evidence-based. Show your work.',
  },
};

export const MEDIUM_IDS = Object.keys(MEDIUM_SPECS) as (keyof typeof MEDIUM_SPECS)[];

export function getMediumSpec(medium: string): MediumSpec {
  return MEDIUM_SPECS[medium] || MEDIUM_SPECS.email;
}
