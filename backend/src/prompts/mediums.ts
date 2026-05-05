// Medium specifications for Five Chapter Story content formats

export interface MediumSpec {
  id: string;
  label: string;
  description: string;
  wordRange: [number, number];
  chapterBudgets: [number, number, number, number, number];
  /**
   * Artifact-level format spec. Read by the BLEND layer when composing
   * the envelope around the joined chapters. Should describe the
   * artifact's overall shape — salutation/sign-off for email, hero
   * H1 for landing page, FOR IMMEDIATE RELEASE for press release —
   * NOT what each chapter individually should produce.
   *
   * Bundle 1B Commit D — refactored from per-chapter prompt injection
   * to blend-layer-only consumption. The per-chapter prompts read
   * `perChapterFormat[chapterNum]` instead of this string.
   */
  format: string;
  formatRules: string;
  tone: string;
  /**
   * Per-chapter format directives. Each chapter's prompt reads
   * `perChapterFormat[chapterNum]` to know which envelope pieces (if
   * any) it should produce. The artifact-level envelope (subject,
   * salutation, sign-off, hero H1, FOR IMMEDIATE RELEASE, etc.) is
   * composed at the blend layer using `format` above.
   *
   * Optional: when `perChapterFormat` is undefined for a medium, the
   * old behavior applies (the artifact-level `format` string is
   * injected into every chapter's prompt). Email is the first medium
   * with per-chapter format strings authored.
   */
  perChapterFormat?: Record<1 | 2 | 3 | 4 | 5, string>;
}

export const MEDIUM_SPECS: Record<string, MediumSpec> = {
  email: {
    id: 'email',
    label: 'Email',
    description: 'Professional outreach email',
    wordRange: [150, 250],
    chapterBudgets: [30, 60, 25, 25, 20],
    // Bundle 1B Commit D — `format` describes the BLEND-layer envelope shape,
    // not the per-chapter prompt shape. Verbatim from
    // cc-prompts/cowork-item-5-site-4-not-fixed-2026-05-05.md.
    format: 'Email format. The envelope (salutation at the open, signoff at the close) is composed by the blend layer around the joined chapters.',
    formatRules: 'This is a single-scroll business email. Chapter 1 is 1-2 sentences max. The entire email must feel like something a person actually sent, not a marketing piece. No section headers. No bullet lists longer than 3 items. STRUCTURAL ELEMENTS — composed at the BLEND layer (not by individual chapters): (1) salutation on its own line at the top — when the audience is a single named person, use the audience\'s first name (e.g., "Hi Liam,"); when the audience is not a single named person, use a role-shaped greeting (e.g., "Hi there,"). NEVER emit a literal placeholder like "[name]" or "[Name]" or "[audience first name]" — those reach the user-visible deliverable as broken text. (2) signoff on its own line at the bottom — Bundle 1A rev7 Rule 1: when a user-side display name is provided in the build context, use "Best,\\n[the user\'s actual name]". When no user display name is available (the user has no name on file or dismissed the gap-notice question), the sign-off is "Best regards" alone — no name, no placeholder. The literal string "[Name]" and any other bracketed placeholder must NEVER appear in the email body. Honor explicit opt-out: if the user said "this is a thread reply" or "no salutation" or "skip the signoff", omit those elements without protest. Round 3.2 Item 10 — these defaults exist because Cowork observed the bug shape "deliverable lacks salutation and signoff" repeating in autonomous flows.',
    tone: 'Direct and personal. Written to one person, not a list.',
    // Bundle 1B Commit D — per-chapter format strings (LOCKED, Cowork-authored
    // verbatim from cc-prompts/cowork-item-5-site-4-not-fixed-2026-05-05.md).
    // Each chapter reads ONLY its own directive; the envelope is the blend's
    // job. DO NOT EDIT without Cowork sign-off.
    perChapterFormat: {
      1: 'Body prose only. The opening hook of the email lives here. Do NOT emit Subject, salutation, or signoff.',
      2: 'Body prose only. Continuing the email body. Do NOT emit salutation or signoff.',
      3: 'Body prose only. Continuing the email body. Do NOT emit salutation or signoff.',
      4: 'Body prose only. Continuing the email body. Do NOT emit salutation or signoff.',
      5: 'The CTA paragraph. Do NOT emit the literal "Best regards" or any signoff — the blend composes that. The signoffDirective handles the user display name.',
    },
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
    format: 'Hero H1 headline, sub-headline, hero copy, 3-4 value sections with short headers, social proof snippet, primary CTA button text.',
    formatRules: 'Scannable. Short paragraphs, subheads, and bullet points. The reader skims — make every line standalone. STRUCTURAL ELEMENTS — default included unless the user explicitly opts out: (1) H1 hero headline at the top; (2) sub-headline directly below; (3) primary CTA button text at the bottom (or wherever the user-stated CTA lands). Without all three, this is not a complete landing page.',
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
  pitch_deck: {
    id: 'pitch_deck',
    label: 'Pitch Deck Narrative',
    description: 'Slide-by-slide narrative for a presentation deck',
    wordRange: [300, 600],
    chapterBudgets: [60, 150, 90, 120, 30],
    format: 'Slide-by-slide narrative. Title slide first, executive-summary slide that captures the ask in one line, then slides for the five-chapter arc — pain, solution, de-risking, proof, next step — and a closing ask-slide. Each slide gets a short headline plus one or two lines of what the presenter says out loud.',
    formatRules: 'Short and scannable. Written to be spoken out loud to a room of executives, not read quietly on a page. Each slide should stand on its own. No heavy paragraphs. No markdown formatting. Do not number slides — just label them with a short headline. STRUCTURAL ELEMENTS — default included unless the user explicitly opts out: (1) title slide at the start with the offering name and audience; (2) executive-summary slide that names the ask in one line; (3) closing ask-slide as the final slide. The five-chapter arc fills the middle slides.',
    tone: 'Conversational and confident. The presenter knows the audience and their world. Do not sound like a TED talk or a brochure.',
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
    format: 'Cover or title section, executive summary, problem statement, analysis sections, recommendations, conclusion or close.',
    formatRules: 'Detailed and structured. Data-driven. Use evidence to support every claim. Formal section headers. STRUCTURAL ELEMENTS — default included unless the user explicitly opts out: (1) cover/title section at the top; (2) executive summary; (3) body sections (problem, approach, scope or analysis); (4) recommendations; (5) conclusion or close. Without these, the document is not a complete report or proposal.',
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
