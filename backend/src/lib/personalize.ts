import { prisma } from './prisma.js';

// ─── Types ──────────────────────────────────────────────────

export interface StyleObservation {
  text: string;              // "terse and direct", "uses Beatles metaphors"
  source: 'interview' | 'document' | 'chat';
  confidence: number;        // 0-1, boosted when reinforced across sources
  createdAt: string;
}

export interface StyleRestriction {
  text: string;              // "never uses sentence fragments"
  source: 'interview' | 'document' | 'chat';
  createdAt: string;
}

export interface DocumentAnalysis {
  snippet: string;           // first 200 chars for reference
  observationsFound: number;
  analyzedAt: string;
}

export interface PersonalizeProfile {
  observations: StyleObservation[];
  restrictions: StyleRestriction[];
  interviewStep: number;          // 0=not started, 1-6=in progress, 7=complete
  interviewAnswers: { question: number; answer: string }[];
  documents: DocumentAnalysis[];  // cap at 20
  profileVersion: number;
  lastUpdatedAt: string;
  enabled: boolean;
  offered: boolean;               // has Maria offered personalization via glow?
}

const DEFAULT_PROFILE: PersonalizeProfile = {
  observations: [],
  restrictions: [],
  interviewStep: 0,
  interviewAnswers: [],
  documents: [],
  profileVersion: 0,
  lastUpdatedAt: '',
  enabled: true,
  offered: false,
};

// ─── CRUD ───────────────────────────────────────────────────

export async function getPersonalize(userId: string): Promise<PersonalizeProfile> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { settings: true },
  });
  const settings = (user?.settings as Record<string, any>) || {};
  return { ...DEFAULT_PROFILE, ...(settings.personalize || {}) };
}

export async function updatePersonalize(userId: string, updates: Partial<PersonalizeProfile>): Promise<void> {
  const current = await getPersonalize(userId);
  const merged = { ...current, ...updates };

  // Cap documents at 20
  if (merged.documents.length > 20) {
    merged.documents = merged.documents.slice(-20);
  }

  // Bump version and timestamp
  merged.profileVersion = (current.profileVersion || 0) + 1;
  merged.lastUpdatedAt = new Date().toISOString();

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { settings: true },
  });
  const settings = (user?.settings as Record<string, any>) || {};

  await prisma.user.update({
    where: { id: userId },
    data: { settings: { ...settings, personalize: JSON.parse(JSON.stringify(merged)) } },
  });
}

export async function resetPersonalize(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { settings: true },
  });
  const settings = (user?.settings as Record<string, any>) || {};
  delete settings.personalize;

  await prisma.user.update({
    where: { id: userId },
    data: { settings },
  });
}

// ─── Prompt Blocks ──────────────────────────────────────────

export function buildStylePromptBlock(profile: PersonalizeProfile): string {
  if (profile.observations.length === 0 && profile.restrictions.length === 0) return '';

  const lines: string[] = [];

  if (profile.observations.length > 0) {
    lines.push('STYLE OBSERVATIONS — write WITH these qualities:');
    profile.observations
      .sort((a, b) => b.confidence - a.confidence)
      .forEach((obs, i) => lines.push(`${i + 1}. ${obs.text}`));
  }

  if (profile.restrictions.length > 0) {
    lines.push('');
    lines.push('STYLE RESTRICTIONS — these are hard rules:');
    profile.restrictions.forEach((r, i) => lines.push(`${i + 1}. ${r.text}`));
  }

  return `\nPERSONAL STYLE PROFILE:\n${lines.join('\n')}\n`;
}

export function buildPersonalizeChatBlock(profile: PersonalizeProfile): string {
  const lines: string[] = [];

  lines.push('\n\n═══ PERSONALIZATION CONTEXT ═══');

  // Interview in progress
  if (profile.interviewStep > 0 && profile.interviewStep < 7) {
    const step = profile.interviewStep;
    lines.push(`\nPERSONALIZATION INTERVIEW IN PROGRESS — question ${step} of 6.`);
    if (profile.interviewAnswers.length > 0) {
      lines.push('Previous answers summary:');
      profile.interviewAnswers.forEach(a => {
        lines.push(`  Q${a.question}: ${a.answer.substring(0, 150)}${a.answer.length > 150 ? '...' : ''}`);
      });
    }

    // Give Maria the EXACT question to ask. Do NOT let her improvise questions.
    const QUESTIONS = [
      "How would you describe your communication style to someone who's never heard you speak?",
      "If your team got an email from you with no name on it, what would tip them off it was you?",
      "Think of something you wrote recently that you were happy with. What did you like about it — or just paste it in and I'll tell you what I notice.",
      "Are there any words, phrases, or habits in your writing that are just... you? Things people might tease you about or immediately associate with you?",
      "What's something about how you communicate that breaks conventional writing advice but works for you?",
    ];

    if (step <= 5) {
      lines.push(`\n═══ MANDATORY RESPONSE FORMAT FOR THIS MESSAGE ═══`);
      lines.push(`Your ENTIRE response must follow this EXACT structure:`);
      lines.push(`1. ONE sentence acknowledging their previous answer (if any).`);
      lines.push(`2. Then this EXACT question, copied VERBATIM — do NOT rephrase, reword, or replace it with a different question:`);
      lines.push(`\n"${QUESTIONS[step - 1]}"\n`);
      lines.push(`DO NOT ask any other question. DO NOT add your own questions. DO NOT ask about their editing process, influences, or anything else. The question above is the ONLY question you ask.`);
      lines.push(`═══ END MANDATORY FORMAT ═══`);
    } else if (step === 6) {
      const comp = (profile as any).comparativeQ6;
      lines.push(`\n═══ MANDATORY RESPONSE FORMAT FOR THIS MESSAGE ═══`);
      lines.push(`Question 6 is a COMPARATIVE choice. Present these two versions and ask EXACTLY: "Here are two versions of the same paragraph. Which one sounds more like something you'd say?"`);
      if (comp) {
        lines.push(`\nVersion A:\n${comp.versionA}\n\nVersion B:\n${comp.versionB}`);
      }
      lines.push(`\nDO NOT ask any other question. DO NOT ask what would tip them off or what sounds AI-generated.`);
      lines.push(`Present Version A and Version B clearly labeled, then ask the question.`);
      lines.push(`═══ END MANDATORY FORMAT ═══`);
    }

    lines.push('\nAfter the user answers, dispatch personalize_interview_answer with their response text. After question 6 is answered, the profile will be synthesized automatically.');
  }

  // Profile exists — tell Maria about it (concisely)
  if (profile.interviewStep === 7 && profile.observations.length > 0) {
    lines.push(`\nThis user has a personalization profile (${profile.observations.length} observations, ${profile.restrictions.length} restrictions). The Personalize button uses this profile automatically.`);
    lines.push('Top observations: ' + profile.observations.slice(0, 3).map(o => o.text).join(', '));
    lines.push('\nIf the user just completed the interview (their last message was an answer to a style question), respond with a SHORT confirmation: "I\'ve got it. From now on when you hit Personalize, I\'ll adjust the story to sound more like you." Do NOT recite the profile unless asked.');
  }

  // Handle "adjust my personal style" / "change my style" intents
  if (profile.observations.length > 0) {
    lines.push('\nSTYLE ADJUSTMENT: If the user says they want to adjust, change, update, or redo their personal style, offer two paths: (1) redo the interview from scratch (dispatch start_personalize_interview), or (2) tell you what to change and you\'ll update the profile directly.');
  }

  // Document recognition
  lines.push('\nDOCUMENT RECOGNITION: If the user pastes a block of text and indicates it represents their writing style (e.g., "this is for my personalization," "analyze my style from this," "here\'s how I write"), dispatch analyze_personalization_doc with the pasted text. Afterwards, confirm briefly what you picked up. If the user asks about uploading documents for style, say: "Just paste any report, blog post, or even email you think represents your style right here and I\'ll figure it out. You can do that now or come back anytime."');

  // Interview start recognition
  if (profile.interviewStep === 0) {
    lines.push('\nIf the user wants to set up their personal writing style or asks about personalization, dispatch start_personalize_interview AND include this EXACT question in your response:');
    lines.push('"How would you describe your communication style to someone who\'s never heard you speak?"');
    lines.push('Do NOT rephrase this question. Use these exact words. Brief intro is fine, but the question must be verbatim.');
  }

  lines.push('═══ END PERSONALIZATION CONTEXT ═══');

  return lines.join('\n');
}
