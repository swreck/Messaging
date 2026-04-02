// Five Chapter Story Methodology Check — antagonistic evaluator for 5CS quality
//
// Runs after chapter generation or blending. Checks that each chapter
// does its one job and doesn't bleed into another chapter's territory.
// Uses Opus because chapter boundary judgment requires nuance.
//
// ⚠️ LOCKED: Do not modify without Ken Rosen's explicit approval.

import { callAIWithJSON } from './ai.js';

const CHAPTER_EVALUATOR = `You are a strict structural evaluator for a Five Chapter Story. Each chapter has ONE job. Your job is to catch content that's in the wrong chapter, missing from its chapter, or violating the boundaries.

You understand why the Five Chapters exist — they match the psychological stages of a decision:
1. Feel the problem (before hearing any solution)
2. Hear the solution (before needing trust)
3. Trust the support (before needing proof)
4. See the proof (before committing)
5. Know what to do (action)

This order is sacred. Content that jumps ahead breaks the persuasion arc.

CHECK EACH CHAPTER:

C1. CHAPTER 1 — "YOU NEED THIS CATEGORY"
- Makes the status quo unattractive? The audience should feel uncomfortable NOT acting.
- Category-level ONLY? NEVER mentions the company name or product name. Not once. Not obliquely. If you can identify the specific company from Chapter 1, it fails.
- Grounded in the audience's actual priorities? Not generic industry fears.

C2. CHAPTER 2 — "YOU NEED OUR VERSION"
- This IS the "let me tell you about us" chapter. Product differentiation belongs here.
- Follows the priority ranking? Highest priority addressed first?
- Contains NO proof, NO credentials, NO institutional names, NO customer references? Those belong in Chapters 3-4. If Chapter 2 mentions a specific customer, institution, certification, or data point used as social proof, it fails.

C3. CHAPTER 3 — "WE'LL HOLD YOUR HAND"
- Eliminates risk through CONCRETE support details?
- Specific enough to picture? "We send a specialist for the first 48 hours" passes. "We provide comprehensive support" fails.
- No new value claims? Chapter 3 is about trust and support, not more selling.

C4. CHAPTER 4 — "YOU'RE NOT ALONE"
- Shows similar organizations/people succeeding?
- Uses problem → solution → result format?
- Organizations are similar to the prospect (not random famous names)?
- Does NOT invent specific company names, metrics, or quotes? If the data isn't in the source Three Tier, it should not appear here.
- No new value claims — only validation of what Chapter 2 already promised.

C5. CHAPTER 5 — "LET'S GET STARTED"
- 1-3 concrete, simple, low-risk steps?
- Steps a person could actually take today?
- NO filler sentences? No "That's it for now," no "Simple as that," no empty closers.
- NO vague follow-ups like "think about it" or "let's chat"?
- Aligns with the specified CTA?

CROSS-CHAPTER CHECKS:

X1. BOUNDARY INTEGRITY — Does any chapter contain content that belongs in a different chapter? Most common violations:
- Company name in Chapter 1
- Customer testimonials or proof in Chapter 2
- New value propositions in Chapter 3
- Fear/urgency language in Chapter 4 or 5

X2. CHAPTER ORDER — Is the logical progression maintained? Does each chapter build on the previous one's conclusion?

X3. MEDIUM FIT — Does the length and tone fit the specified medium? An email should feel like an email. A blog post should have room to breathe. Speaking notes should be brief triggers, not prose.

RESPOND WITH JSON:
{
  "overallPass": true/false,
  "chapters": [
    { "num": 1, "pass": true/false, "violations": ["description of violation"] },
    { "num": 2, "pass": true/false, "violations": [] },
    ...
  ],
  "crossChecks": [
    { "id": "X1", "pass": true/false, "detail": "description" },
    { "id": "X2", "pass": true/false, "detail": "description" },
    { "id": "X3", "pass": true/false, "detail": "description" }
  ]
}`;

// ─── Types ──────────────────────────────────────────────────

export interface FiveChapterInput {
  chapters: { num: number; title: string; content: string }[];
  medium: string;
  cta: string;
  offeringName: string;
  audienceName: string;
  tier1Text?: string;
}

export interface ChapterCheckResult {
  num: number;
  pass: boolean;
  violations: string[];
}

export interface FiveChapterCheckResult {
  passed: boolean;
  chapters: ChapterCheckResult[];
  crossChecks: { id: string; pass: boolean; detail: string }[];
}

// ─── Evaluator function ─────────────────────────────────────

export async function checkFiveChapter(input: FiveChapterInput): Promise<FiveChapterCheckResult> {
  const lines: string[] = [];
  lines.push(`OFFERING: "${input.offeringName}"`);
  lines.push(`AUDIENCE: "${input.audienceName}"`);
  lines.push(`MEDIUM: ${input.medium}`);
  lines.push(`CTA: "${input.cta}"`);
  if (input.tier1Text) {
    lines.push(`THREE TIER — TIER 1: "${input.tier1Text}"`);
  }
  lines.push('');

  for (const ch of input.chapters) {
    lines.push(`═══ CHAPTER ${ch.num}: ${ch.title} ═══`);
    lines.push(ch.content);
    lines.push('');
  }

  const result = await callAIWithJSON<{
    overallPass: boolean;
    chapters: { num: number; pass: boolean; violations: string[] }[];
    crossChecks: { id: string; pass: boolean; detail: string }[];
  }>(CHAPTER_EVALUATOR, lines.join('\n'), 'elite');

  return {
    passed: result.overallPass,
    chapters: result.chapters || [],
    crossChecks: result.crossChecks || [],
  };
}

// ─── Feedback builder ───────────────────────────────────────

export function buildFiveChapterFeedback(result: FiveChapterCheckResult): string {
  const issues: string[] = [];

  for (const ch of result.chapters) {
    if (!ch.pass) {
      for (const v of ch.violations) {
        issues.push(`- Chapter ${ch.num}: ${v}`);
      }
    }
  }

  for (const x of result.crossChecks) {
    if (!x.pass) {
      issues.push(`- ${x.id}: ${x.detail}`);
    }
  }

  if (issues.length === 0) return '';
  return `\n\nFIVE CHAPTER METHODOLOGY CHECK — fix these:\n${issues.join('\n')}`;
}
