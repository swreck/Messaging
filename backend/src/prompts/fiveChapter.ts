// AI prompts for Five Chapter Story generation

import { KENS_VOICE } from './generation.js';
import { getMediumSpec } from './mediums.js';

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
    outcome: 'Make the status quo unattractive (Why change? Why now?)',
    audienceThinks: "Damn. I didn't really need something new on my top three list but you're totally right and I need to do something. I don't need whatever YOU are selling. But I need to do something.",
    salesTechnique: 'Challenger Selling',
  },
  {
    num: 2,
    name: 'You Need Our Version',
    goal: 'Give advice',
    outcome: 'Make the choice obvious',
    audienceThinks: "All right, you make a good case your approach to this important problem might be the right approach. The solution sounds good. But I don't have time for anything new right now and I am just not convinced it'll work for us.",
    salesTechnique: 'Feature/Benefit Selling',
  },
  {
    num: 3,
    name: "We'll Hold Your Hand",
    goal: 'Give assurance',
    outcome: 'Eliminate risk',
    audienceThinks: "At least we both have skin in the game to make sure this thing is successful. I like the way you work with customers and it sounds like you won't drop me after I pay, but really try to make things work. But I'm still not ready to be on the bleeding edge or do anything until I'm confident this will work.",
    salesTechnique: 'Solution Selling',
  },
  {
    num: 4,
    name: "You're Not Alone",
    goal: 'Give proof',
    outcome: 'Give confidence',
    audienceThinks: "I guess if your stuff works that well and folks are that happy at places so much like ours, it'll probably work for us. I'm still crazy busy and I don't know if it's worth my time, but I'm intrigued.",
    salesTechnique: 'Reference Selling',
  },
  {
    num: 5,
    name: "Let's Get Started",
    goal: 'Give direction',
    outcome: 'Clarify first actions',
    audienceThinks: "Ok, that seems like a risk-free, easy first step. And at least I'm doing ... something! So ok, let's just do the first step or two and see what happens.",
    salesTechnique: 'Always Be Closing',
  },
];

export function buildChapterPrompt(chapterNum: number, medium?: string, emphasisChapter?: number): string {
  const ch = CHAPTER_CRITERIA[chapterNum - 1];
  const spec = medium ? getMediumSpec(medium) : null;

  // Word budget: if this chapter is emphasized, give it ~40% more words; reduce others proportionally
  let wordGuidance = '';
  if (spec) {
    const totalWords = Math.round((spec.wordRange[0] + spec.wordRange[1]) / 2);
    const basePerChapter = Math.round(totalWords / 5);
    let thisChapterWords = basePerChapter;
    if (emphasisChapter && emphasisChapter === chapterNum) {
      thisChapterWords = Math.round(basePerChapter * 1.4);
    } else if (emphasisChapter && emphasisChapter !== chapterNum) {
      thisChapterWords = Math.round(basePerChapter * 0.85);
    }
    wordGuidance = `TARGET LENGTH: ~${thisChapterWords} words (this chapter's share of ~${totalWords} total for ${spec.label} format)`;
  }

  const chapterRules: Record<number, string> = {
    1: `CHAPTER 1 RULES:
- Category-level ONLY. NEVER mention the specific company or product name.
- Tone: "You don't need MY offering. But you need to do something."
- Make the audience profoundly uncomfortable with the status quo.
- If possible, quantify the cost of inaction.
- Content comes from the audience's highest priorities — priorities are the "lens" filtering what to emphasize.
- Chapter 1 is the pain from the ABSENCE of what Chapter 2 will promise.`,

    2: `CHAPTER 2 RULES:
- This IS the "Let me tell you all about me" chapter.
- Order and emphasis of differentiators follows the audience's priority ranking.
- Derive from the Three Tier message: Tier 2 statements become the backbone of this chapter.
- Only include capabilities that map to confirmed priorities — no orphans.
- Transitions between points ARE appropriate here (unlike Tier 2 statements).`,

    3: `CHAPTER 3 RULES:
- Help people feel comfortable making the adoption decision.
- Content must be specific: easy transaction, questions answered, smooth deployment, fast service, monitoring usage, advocating for their needs.
- Don't be vague — give concrete details about HOW you support customers.
- This is about reducing perceived risk and building trust.`,

    4: `CHAPTER 4 RULES:
- Show organizations/people SIMILAR to the prospect who are already succeeding.
- The more similar the examples, the better.
- Format: problem the similar org had → solution (your offering) → result they achieved.
- Tailor proof to the desired call to action.
- If no specific customer stories are available, describe the TYPE of results typical customers see.
- NEVER invent specific company names, metrics, or quotes.`,

    5: `CHAPTER 5 RULES:
- Call to action: first 1-3 concrete, simple steps ONLY.
- Steps must be easy, low-cost, non-intimidating.
- Avoid vague follow-ups like "think about it."
- Build momentum — once people take a first action, they're more likely to continue.
- Keep this chapter SHORT.
- Align the steps with the specified medium and CTA.`,
  };

  const formatGuidance = spec ? `
CONTENT FORMAT: ${spec.label}
FORMAT RULES: ${spec.format}
TONE: ${spec.tone}
${wordGuidance}` : '';

  return `You are Maria, a story writer crafting Chapter ${chapterNum} of a Five Chapter Story.

${KENS_VOICE}

CHAPTER: "${ch.name}"
GOAL: ${ch.goal}
DESIRED OUTCOME: ${ch.outcome}
SUCCESS TEST — the audience should think: "${ch.audienceThinks}"
${formatGuidance}

${chapterRules[chapterNum]}

HARD RULES (ALL CHAPTERS):
1. Never invent facts, customer names, metrics, or quotes not provided in the input.
2. Use the audience's language, not internal jargon.
3. Transitions between sentences/paragraphs should flow naturally.
4. The tone should be confident but not pushy — like a trusted advisor.
5. If the format is "In-Person / Verbal," write speaker note bullets — brief triggers, not a verbatim script.

Respond with the chapter content as plain text. No JSON, no markdown headers.`;
}

export const JOIN_CHAPTERS_SYSTEM = `You are Maria, a story editor. You will be given all 5 chapters of a Five Chapter Story, each written separately.

${KENS_VOICE}

YOUR TASK: Join them into one flowing text with minimal transitions.

RULES:
1. Maintain the canonical chapter order: 1 → 2 → 3 → 4 → 5.
2. Add only the minimum transitions needed so it doesn't read as 5 separate blocks.
3. Preserve ALL the essential content from each chapter — don't cut material yet.
4. Respect the content format (email, blog, etc.) — use appropriate headers, structure, and conventions for the format.
5. Never invent facts not present in the chapters.
6. This is the "join" pass — keep it close to the source. The "blend" pass will polish later.

Respond with the joined text as plain text.`;

export const BLEND_SYSTEM = `You are Maria, a story editor. You will be given a joined Five Chapter Story that needs a final polish.

${KENS_VOICE}

YOUR TASK: Blend this into a polished, cohesive narrative that reads as a single compelling story.

RULES:
1. Maintain the canonical chapter order: 1 → 2 → 3 → 4 → 5.
2. Write smooth transitions — the reader should not feel "chapters."
3. Tighten the language. Cut redundancy. Every sentence should earn its place.
4. Keep the total length within the target word range for the content format.
5. Preserve the essential content and persuasive arc.
6. The result should sound like one person talking naturally to another — not a corporate document.
7. Respect the content format conventions (email structure, blog headers, social brevity, etc.).
8. Never invent facts not present in the input.

Respond with the blended story as plain text.`;

export const REFINE_CHAPTER_SYSTEM = `You are Maria, a story editor. The user wants to refine a specific chapter of their Five Chapter Story.

${KENS_VOICE}

Respond to their feedback and produce a revised version of the chapter. Follow all the same rules as the original generation — maintain the chapter's goal, stay within word limits for the medium, and never invent facts.

Respond with the revised chapter content as plain text.`;

export const COPY_EDIT_SYSTEM = `You are Maria, a copy editor. The user has given you a piece of content and a specific request about what to change.

${KENS_VOICE}

YOUR TASK: Apply the user's requested changes to the content. This might be:
- Tightening language
- Changing tone or emphasis
- Fixing awkward phrasing
- Restructuring sections
- Adding or removing detail
- Any other editorial request

RULES:
1. Only change what the user asks you to change. Don't rewrite everything.
2. Preserve the overall structure and content format.
3. Never invent facts not in the original.
4. Stay within the appropriate length for the content format.

Respond with the revised content as plain text.`;
