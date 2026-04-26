// Round E2 — Maria learns from your edits.
//
// Pattern detector: when the user has made the same kind of edit three
// times across recent generations, Maria asks one scoped question. Below
// 3 occurrences, no signal. At 3, the detector returns a proposed rule
// + scope (audience-type and/or format) that Maria reads back.
//
// The detector compares a chapter's most recent ai_generate version
// against the most recent manual version (the user's edit) and asks Opus
// to characterize the EDIT — what shape of change did the user make? It
// returns a one-sentence "rule" describing what the user appears to have
// changed. The aggregator then groups by similar rule across recent
// generations and threshold-fires at 3.
//
// Quality-floor principle: the edit characterizer is judgment-heavy
// (must distinguish "user removed a metaphorical verb" from "user fixed
// a typo"), so it runs on Opus.

import { callAIWithJSON } from './ai.js';

// Keep these tight — false-positives here mean Maria asks about non-patterns.
const CHARACTERIZE_SYSTEM = `You characterize a single user edit to a generated chapter. The user took Maria's draft and changed it. Your job: in one short sentence, name the SHAPE of the change — not the specific wording, not the topic. The shape is what could repeat across other generations.

Good shapes:
- "removed marketing adjectives"
- "shortened the closing paragraph"
- "replaced specific percentages with ranges"
- "cut metaphorical verbs"
- "swapped 'we' for 'I' in first-person sections"
- "broke long sentences into shorter ones"

Bad characterizations (too specific to repeat):
- "changed Acme to Beta" (specific entity)
- "fixed typo in chapter 3" (one-off)
- "moved sentence 2 up" (positional, not shape)

If the change is too small to characterize as a shape (typo fix, single-word swap with no clear rule), return shape = "" (empty string).

OUTPUT — return ONLY valid JSON:
{
  "shape": "one short sentence describing the shape of the change, or empty string",
  "confidence": "high | medium | low"
}`;

export interface CharacterizeEditInput {
  before: string;          // ai_generate version content
  after: string;           // user's edited content
  chapterNum?: number;
}
export interface CharacterizeEditResult {
  shape: string;
  confidence: 'high' | 'medium' | 'low' | string;
}

export async function characterizeEdit(input: CharacterizeEditInput): Promise<CharacterizeEditResult> {
  const userMessage = `BEFORE (Maria's draft):
${input.before}

AFTER (user's edit):
${input.after}

What shape of change did the user make? Be terse and pattern-shaped, not topic-specific.`;
  try {
    const result = await callAIWithJSON<CharacterizeEditResult>(CHARACTERIZE_SYSTEM, userMessage, 'elite');
    return {
      shape: typeof result.shape === 'string' ? result.shape.trim() : '',
      confidence: result.confidence === 'high' || result.confidence === 'medium' || result.confidence === 'low' ? result.confidence : 'medium',
    };
  } catch (err) {
    console.error('[editPatternDetect] characterize failed:', err);
    return { shape: '', confidence: 'low' };
  }
}

// Aggregator — group recent edit shapes by similarity. Two shapes are
// "similar" if their normalized token sets share at least 40% (Jaccard).
// B-6 tuning: 0.6 was too strict and missed true paraphrases of the same
// shape (e.g. "shorter sentences" vs "broke long sentences into shorter
// ones"). The confidence guard in detectPattern() compensates for the
// looser similarity by requiring at least 2 observations at high|medium
// confidence within any group that fires.
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'with', 'for', 'is', 'was', 'were']);
function similar(a: string, b: string): boolean {
  const tokA = new Set(normalize(a).split(' ').filter(t => t.length > 2 && !STOP.has(t)));
  const tokB = new Set(normalize(b).split(' ').filter(t => t.length > 2 && !STOP.has(t)));
  if (tokA.size === 0 && tokB.size === 0) return true;
  if (tokA.size === 0 || tokB.size === 0) return false;
  let inter = 0;
  for (const t of tokA) if (tokB.has(t)) inter++;
  return inter / new Set([...tokA, ...tokB]).size >= 0.4;
}

export interface EditObservation {
  shape: string;
  audienceType?: string;
  format?: string;
  observedAt: Date;
  confidence?: 'high' | 'medium' | 'low' | string;
}
export interface DetectedPattern {
  shape: string;            // canonical shape (the most recent or most representative)
  scopeAudienceType: string; // empty string if mixed across audience types
  scopeFormat: string;       // empty string if mixed across formats
  occurrences: number;       // count of similar observations
}

/**
 * Threshold-3 pattern detection. Given a list of recent edit observations,
 * return the dominant detected pattern (if any has reached 3 occurrences).
 * Otherwise return null. Scope narrows to the audience-type / format only
 * if every contributing observation shared it; otherwise scope broadens to
 * empty (applies anywhere).
 */
export function detectPattern(observations: EditObservation[]): DetectedPattern | null {
  if (observations.length < 3) return null;
  // Group by similar shape. Track confidence per-observation so the
  // aggregator can require at least 2 high|medium signals before firing —
  // this guards against the looser 0.4 Jaccard threshold pulling in
  // low-confidence noise that happens to share tokens.
  type Group = { shapes: string[]; audienceTypes: Set<string>; formats: Set<string>; count: number; strongCount: number };
  const groups: Group[] = [];
  for (const o of observations) {
    if (!o.shape) continue;
    const isStrong = o.confidence === 'high' || o.confidence === 'medium';
    const existing = groups.find(g => g.shapes.some(s => similar(s, o.shape)));
    if (existing) {
      existing.shapes.push(o.shape);
      if (o.audienceType) existing.audienceTypes.add(o.audienceType);
      if (o.format) existing.formats.add(o.format);
      existing.count++;
      if (isStrong) existing.strongCount++;
    } else {
      groups.push({
        shapes: [o.shape],
        audienceTypes: new Set(o.audienceType ? [o.audienceType] : []),
        formats: new Set(o.format ? [o.format] : []),
        count: 1,
        strongCount: isStrong ? 1 : 0,
      });
    }
  }
  // Pick the largest group that's reached threshold AND has 2+ strong
  // (high|medium) confidence signals. Secondary sort on strongCount so
  // ties prefer the better-evidenced group.
  groups.sort((a, b) => (b.count - a.count) || (b.strongCount - a.strongCount));
  const top = groups.find(g => g.count >= 3 && g.strongCount >= 2);
  if (!top) return null;
  return {
    shape: top.shapes[top.shapes.length - 1],
    scopeAudienceType: top.audienceTypes.size === 1 ? [...top.audienceTypes][0] : '',
    scopeFormat: top.formats.size === 1 ? [...top.formats][0] : '',
    occurrences: top.count,
  };
}
