// Personalize Service — AI orchestration for style discovery and application
//
// Two "agents" that work together:
// - Personalize generate (Opus): rewrites polished text with personal style
// - Personalize evaluate (Opus): checks whether style was applied faithfully
// Max 2 retries (3 total attempts) if evaluate rejects.

import { callAI, callAIWithJSON } from './ai.js';
import { checkProse, buildProseViolationFeedback } from './voiceCheck.js';
import {
  buildInterviewSynthesisPrompt,
  buildDocumentAnalysisPrompt,
  buildPersonalizeGeneratePrompt,
  buildPersonalizeEvaluatePrompt,
  buildComparativeQuestionPrompt,
} from '../prompts/personalize.js';
import {
  getPersonalize,
  updatePersonalize,
  buildStylePromptBlock,
  type StyleObservation,
  type StyleRestriction,
  type PersonalizeProfile,
} from '../lib/personalize.js';

// ─── Interview Synthesis ────────────────────────────────────

export async function synthesizeInterviewProfile(
  answers: { question: number; answer: string }[]
): Promise<{
  observations: StyleObservation[];
  restrictions: StyleRestriction[];
  summary: string;
}> {
  const systemPrompt = buildInterviewSynthesisPrompt(answers);
  const result = await callAIWithJSON<{
    observations: { text: string; confidence: number }[];
    restrictions: { text: string }[];
    summary: string;
  }>(systemPrompt, 'Analyze the interview answers above and extract the style profile.', 'elite');

  const now = new Date().toISOString();
  return {
    observations: result.observations.map(o => ({
      text: o.text,
      source: 'interview' as const,
      confidence: o.confidence,
      createdAt: now,
    })),
    restrictions: result.restrictions.map(r => ({
      text: r.text,
      source: 'interview' as const,
      createdAt: now,
    })),
    summary: result.summary,
  };
}

// ─── Comparative Question Generation ────────────────────────

export async function generateComparativeQuestion(
  previousAnswers: { question: number; answer: string }[]
): Promise<{
  versionA: string;
  versionB: string;
  dimensionTested: string;
}> {
  const systemPrompt = buildComparativeQuestionPrompt(previousAnswers);
  return callAIWithJSON<{
    versionA: string;
    versionB: string;
    dimensionTested: string;
  }>(systemPrompt, 'Generate the two comparative versions.', 'elite');
}

// ─── Document Analysis ──────────────────────────────────────

export async function analyzeDocument(
  userId: string,
  documentText: string
): Promise<{
  observations: StyleObservation[];
  restrictions: StyleRestriction[];
  diverges: boolean;
  clarifyingQuestion: string | null;
  snippetSummary: string;
}> {
  const profile = await getPersonalize(userId);
  const existingBlock = buildStylePromptBlock(profile);

  const systemPrompt = buildDocumentAnalysisPrompt(existingBlock, documentText);
  const result = await callAIWithJSON<{
    observations: { text: string; confidence: number; reinforces: string | null }[];
    restrictions: { text: string }[];
    diverges: boolean;
    clarifyingQuestion: string | null;
    snippetSummary: string;
  }>(systemPrompt, 'Analyze the writing sample above.', 'elite');

  const now = new Date().toISOString();
  return {
    observations: result.observations.map(o => ({
      text: o.text,
      source: 'document' as const,
      confidence: o.confidence,
      createdAt: now,
    })),
    restrictions: result.restrictions.map(r => ({
      text: r.text,
      source: 'document' as const,
      createdAt: now,
    })),
    diverges: result.diverges,
    clarifyingQuestion: result.clarifyingQuestion || null,
    snippetSummary: result.snippetSummary,
  };
}

// ─── Signal Merging ─────────────────────────────────────────

export function mergeStyleSignals(
  existing: PersonalizeProfile,
  newObservations: StyleObservation[],
  newRestrictions: StyleRestriction[]
): { observations: StyleObservation[]; restrictions: StyleRestriction[] } {
  const mergedObs = [...existing.observations];

  for (const newObs of newObservations) {
    const existingIdx = mergedObs.findIndex(o =>
      o.text.toLowerCase().includes(newObs.text.toLowerCase().substring(0, 20)) ||
      newObs.text.toLowerCase().includes(o.text.toLowerCase().substring(0, 20))
    );

    if (existingIdx >= 0) {
      // Reinforce: boost confidence, keep the more detailed text
      mergedObs[existingIdx] = {
        ...mergedObs[existingIdx],
        confidence: Math.min(1, mergedObs[existingIdx].confidence + 0.15),
        text: newObs.text.length > mergedObs[existingIdx].text.length
          ? newObs.text
          : mergedObs[existingIdx].text,
      };
    } else {
      mergedObs.push(newObs);
    }
  }

  // Cap at 50 observations, keep highest confidence
  const cappedObs = mergedObs
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 50);

  // Merge restrictions — deduplicate by substring match
  const mergedRestr = [...existing.restrictions];
  for (const newR of newRestrictions) {
    const exists = mergedRestr.some(r =>
      r.text.toLowerCase().includes(newR.text.toLowerCase().substring(0, 20)) ||
      newR.text.toLowerCase().includes(r.text.toLowerCase().substring(0, 20))
    );
    if (!exists) {
      mergedRestr.push(newR);
    }
  }

  // Cap at 20 restrictions
  const cappedRestr = mergedRestr.slice(0, 20);

  return { observations: cappedObs, restrictions: cappedRestr };
}

// ─── Core Pipeline: Personalize a Chapter ───────────────────

export async function personalizeChapter(
  chapterText: string,
  profile: PersonalizeProfile,
  context: { medium: string; chapterNum: number }
): Promise<{ text: string; passed: boolean; attempts: number }> {
  const styleBlock = buildStylePromptBlock(profile);

  // Step 1: Ensure Table for Two baseline via prose check
  const proseCheck = await checkProse(
    chapterText,
    `Five Chapter Story, Chapter ${context.chapterNum}, medium: ${context.medium}`
  );

  let polishedText = chapterText;
  if (!proseCheck.passed && proseCheck.violations.length > 0) {
    // Re-generate with violation feedback to get a clean baseline
    const violationFeedback = buildProseViolationFeedback(proseCheck.violations);
    polishedText = await callAI(
      `You are rewriting a Five Chapter Story chapter to fix voice violations. Keep the same content, structure, and length. Only fix the specific violations listed below.${violationFeedback}`,
      `CHAPTER TO FIX:\n${chapterText}\n\nReturn ONLY the fixed chapter text.`,
      'elite'
    );
  }

  // Step 2-4: Generate-evaluate loop
  let personalizedText = '';
  let passed = false;
  let attempts = 0;
  let feedback: string | undefined;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    attempts++;

    // Personalize generate
    const generatePrompt = buildPersonalizeGeneratePrompt(
      polishedText,
      styleBlock,
      context.medium,
      context.chapterNum,
      feedback
    );
    personalizedText = await callAI(generatePrompt, 'Rewrite the chapter now.', 'elite');

    // Personalize evaluate
    const evaluatePrompt = buildPersonalizeEvaluatePrompt(polishedText, personalizedText, styleBlock);
    const evaluation = await callAIWithJSON<{
      pass: boolean;
      observationsReflected: number;
      observationsTotal: number;
      restrictionsViolated: string[];
      voiceViolations: string[];
      structureIssues: string[];
      suggestions: string[];
    }>(evaluatePrompt, 'Evaluate the personalized version.', 'elite');

    if (evaluation.pass) {
      passed = true;
      break;
    }

    // Build feedback for retry
    const feedbackParts: string[] = [];
    if (evaluation.restrictionsViolated.length > 0) {
      feedbackParts.push(`Restrictions violated: ${evaluation.restrictionsViolated.join('; ')}`);
    }
    if (evaluation.voiceViolations.length > 0) {
      feedbackParts.push(`Table for Two violations: ${evaluation.voiceViolations.join('; ')}`);
    }
    if (evaluation.structureIssues.length > 0) {
      feedbackParts.push(`Structure issues: ${evaluation.structureIssues.join('; ')}`);
    }
    if (evaluation.suggestions.length > 0) {
      feedbackParts.push(`Suggestions: ${evaluation.suggestions.join('; ')}`);
    }
    feedbackParts.push(`Style coverage: ${evaluation.observationsReflected}/${evaluation.observationsTotal} observations reflected.`);
    feedback = feedbackParts.join('\n');
  }

  return { text: personalizedText, passed, attempts };
}
