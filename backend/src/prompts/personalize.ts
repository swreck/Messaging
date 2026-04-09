// Personalize — prompts for style discovery, generation, and evaluation
//
// This file is NEW (not locked). It implements the Personalize feature:
// personal voice layering on top of Table for Two for Five Chapter Stories.

import { KENS_VOICE } from './generation.js';

// ─── Interview Questions ────────────────────────────────────

export const INTERVIEW_QUESTIONS: string[] = [
  "How would you describe your communication style to someone who's never heard you speak?",
  "If your team got an email from you with no name on it, what would tip them off it was you?",
  "Think of something you wrote recently that you were happy with. What did you like about it — or just paste it in and I'll tell you what I notice.",
  "Are there any words, phrases, or habits in your writing that are just... you? Things people might tease you about or immediately associate with you?",
  "What's something about how you communicate that breaks conventional writing advice but works for you?",
  "COMPARATIVE", // placeholder — Q6 is generated dynamically from earlier answers
];

// ─── Interview Synthesis ────────────────────────────────────

export function buildInterviewSynthesisPrompt(
  answers: { question: number; answer: string }[]
): string {
  const answersText = answers.map(a =>
    `Question ${a.question}: ${INTERVIEW_QUESTIONS[a.question - 1] === 'COMPARATIVE' ? '(Comparative style choice)' : INTERVIEW_QUESTIONS[a.question - 1]}\nAnswer: ${a.answer}`
  ).join('\n\n');

  return `You are analyzing a person's interview answers to build their personal writing style profile.

Your job is to extract two things:

1. DECLARATIVE OBSERVATIONS — things that SHOULD BE PRESENT in writing personalized for this person. These describe positive qualities of their voice. Lean heavily here. Examples: "terse and direct," "uses profanity for emphasis," "filters through a millennial lens," "warm folksy tone wrapped around business jargon."

2. RESTRICTIONS — things that must be ABSENT or ALWAYS PRESENT. Use these sparingly — only for hard lines the person explicitly drew. Examples: "never uses sentence fragments," "always uses they/them pronouns."

The balance should lean heavily toward observations (5-15) over restrictions (0-3). Style is defined more by what IS there than what ISN'T.

Be specific and actionable. "Good writer" is useless. "Uses short declarative sentences with occasional dry humor" is useful. Each observation should be something an AI could check for in generated text.

INTERVIEW ANSWERS:
${answersText}

RESPOND WITH JSON ONLY:
{
  "observations": [
    { "text": "description of the style quality", "confidence": 0.0-1.0 }
  ],
  "restrictions": [
    { "text": "description of the hard rule" }
  ],
  "summary": "A 2-3 sentence plain-language summary of this person's style that Maria can share with them for confirmation."
}`;
}

// ─── Comparative Question Generation ────────────────────────

export function buildComparativeQuestionPrompt(
  previousAnswers: { question: number; answer: string }[]
): string {
  const answersText = previousAnswers.map(a =>
    `Q${a.question}: ${a.answer.substring(0, 200)}`
  ).join('\n');

  return `Based on these interview answers about a person's writing style, generate two versions of the same short paragraph (3-4 sentences about a product launch). The two versions should differ on the style dimensions that emerged from their answers — one version should lean toward one end of their described style, the other toward the opposite.

The goal: the person picks which version sounds more like them, and their choice reveals style preferences that are hard to articulate directly.

PREVIOUS ANSWERS:
${answersText}

RESPOND WITH JSON ONLY:
{
  "versionA": "First version of the paragraph",
  "versionB": "Second version of the paragraph",
  "dimensionTested": "What style dimension these versions differ on (e.g., 'formality level', 'use of humor', 'sentence length')"
}`;
}

// ─── Document Analysis ──────────────────────────────────────

export function buildDocumentAnalysisPrompt(
  existingProfileBlock: string,
  documentText: string
): string {
  return `You are analyzing a writing sample to extract personal style patterns. This sample represents how the person writes (or wants to write).

${existingProfileBlock ? `EXISTING STYLE PROFILE:\n${existingProfileBlock}\n\nLook for patterns that REINFORCE existing observations (boost confidence) or ADD NEW ones not yet captured. Also check for DIVERGENCE — patterns in this document that contradict the existing profile.` : 'No existing profile yet. Extract all style patterns you can identify.'}

WRITING SAMPLE:
${documentText}

Extract:
1. OBSERVATIONS — declarative style qualities present in this writing. Be specific. "Uses short sentences" is better than "concise." If an observation matches an existing one, note it as reinforcement.
2. RESTRICTIONS — hard rules evident in the writing (e.g., never uses contractions, always spells out numbers). Only include if clearly consistent across the sample.
3. DIVERGENCE — if any patterns in this document contradict existing profile observations, flag them with a clarifying question.

RESPOND WITH JSON ONLY:
{
  "observations": [
    { "text": "description", "confidence": 0.0-1.0, "reinforces": "text of existing observation it reinforces, or null" }
  ],
  "restrictions": [
    { "text": "description" }
  ],
  "diverges": false,
  "clarifyingQuestion": null,
  "snippetSummary": "One sentence describing the overall style of this sample"
}`;
}

// ─── Personalize Generate ───────────────────────────────────

export function buildPersonalizeGeneratePrompt(
  chapterText: string,
  styleBlock: string,
  medium: string,
  chapterNum: number,
  feedback?: string
): string {
  return `You are rewriting a Five Chapter Story chapter to match a specific person's writing style.

THE BASELINE VOICE (Table for Two) remains in effect. Here are the rules:
${KENS_VOICE}

You are ADDING personal style characteristics ON TOP of that baseline. Think of Table for Two as the foundation — plain language, one thought per sentence, no sales language. Personal style is the paint color, the furniture, the personal touches that make it feel like THIS person's home.

The style profile below may include observations that deliberately break specific Table for Two rules. That is intentional — this person's authentic voice departs from those rules in ways that work for them. Apply those departures confidently. But do NOT break Table for Two rules that the style profile doesn't address.

${styleBlock}

CHAPTER CONTEXT:
- Chapter ${chapterNum} of 5
- Medium: ${medium}
- This chapter text has already passed Table for Two voice check (polished).

INSTRUCTIONS:
1. Read the original chapter carefully.
2. Apply each style observation naturally — don't force them all into every sentence. Let them emerge where they fit.
3. Respect every restriction absolutely.
4. Do NOT change the factual content, the chapter's structural purpose, or the Three Tier messaging underneath.
5. The result should sound like the same story told by THIS person.
6. Maintain approximately the same length.
7. If the style profile says "terse and direct," the chapter can get shorter. If it says "uses elaborate analogies," it can get longer. Let the style guide the length naturally.
${feedback ? `\nEVALUATOR FEEDBACK FROM PREVIOUS ATTEMPT — fix these issues while maintaining the personal style:\n${feedback}` : ''}

ORIGINAL CHAPTER:
${chapterText}

Rewrite the chapter with the personal style applied. Return ONLY the rewritten text, no explanation.`;
}

// ─── Personalize Evaluate ───────────────────────────────────

export function buildPersonalizeEvaluatePrompt(
  originalText: string,
  personalizedText: string,
  styleBlock: string
): string {
  return `You are evaluating whether a personalized rewrite of a Five Chapter Story chapter faithfully applies a personal writing style profile.

Your job is to CHECK, not to rewrite. You have two concerns:

1. STYLE APPLICATION — Does the personalized version reflect the user's style profile? You don't need every observation in every paragraph, but the overall voice should feel distinctly different from the generic baseline. At least half the observations should be evident.

2. METHODOLOGY INTEGRITY — Has personalization preserved the chapter's factual content, structural purpose, and Three Tier messaging? Did it avoid introducing marketing language, buzzwords, or Table for Two violations BEYOND what the style profile explicitly calls for?

${styleBlock}

ORIGINAL (pre-personalization, Table for Two baseline):
${originalText}

PERSONALIZED VERSION:
${personalizedText}

Check each observation: is it reflected in the personalized text?
Check each restriction: is it honored?
Check for unwanted Table for Two violations (ones not justified by the style profile).
Check that factual content and chapter structure are preserved.

RESPOND WITH JSON ONLY:
{
  "pass": true/false,
  "observationsReflected": 0,
  "observationsTotal": 0,
  "restrictionsViolated": [],
  "voiceViolations": [],
  "structureIssues": [],
  "suggestions": []
}`;
}
