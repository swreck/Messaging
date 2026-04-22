// Lightweight regex-based voice guard.
//
// The always-on Opus voice check (voiceCheck.ts) is intentionally disabled
// (see isVoiceCheckEnabled) to keep generation fast. This guard is the
// cheap safety net: pure regex, runs on every generated statement, catches
// the specific patterns that slipped through in the Marcus scenario
// (Ken's Voice Rule 5 "without X" contrast clause, and Rule 10 word count).
//
// This is NOT a replacement for voiceCheck.ts. It only catches the syntactic
// violations that a regex can reliably detect. Semantic violations
// (tautology, flattery, origin stories) still require the Opus evaluator
// via the Polish button.

export interface VoiceGuardViolation {
  type: 'contrast-clause' | 'word-count' | 'proof-comparative';
  message: string;
  pattern?: string;
}

export interface VoiceGuardResult {
  passed: boolean;
  violations: VoiceGuardViolation[];
}

// Contrast-clause patterns that appear in the MAIN CLAIM (before "because")
// and turn a plain statement into a salesperson-anticipates-objections hedge.
// Matching "without <verb-ing>" is the most reliable signal ("without degrading",
// "without compromising", "without sacrificing"). "instead of" / "rather than"
// are universally contrast-clauses. "not just" is another flag.
const CONTRAST_CLAUSE_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bwithout\s+\w+ing\b/i, label: 'without <verb-ing>' },
  { pattern: /\bwithout\s+(?:the\s+|any\s+|a\s+)?(?:risk|hassle|cost|tradeoff|compromise|downside|overhead|delay|loss|sacrifice)\b/i, label: 'without <hedge-noun>' },
  { pattern: /\binstead\s+of\b/i, label: 'instead of' },
  { pattern: /\brather\s+than\b/i, label: 'rather than' },
  { pattern: /\bno\s+tradeoff/i, label: 'no tradeoff' },
  { pattern: /\bnot\s+just\b/i, label: 'not just' },
];

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Check a generated statement (Tier 1 / Tier 2) for syntactic voice violations.
 * Only inspects the main clause (before "because") for contrast clauses,
 * since the mechanism after "because" legitimately uses words like "without"
 * (e.g., "because AI answers without human intervention" — fine).
 */
export function checkStatementVoice(
  text: string,
  opts?: { maxWords?: number },
): VoiceGuardResult {
  const violations: VoiceGuardViolation[] = [];
  const maxWords = opts?.maxWords ?? 20;

  if (!text || !text.trim()) {
    return { passed: true, violations: [] };
  }

  // Isolate the main clause (everything before the first "because")
  const [mainRaw] = text.split(/\bbecause\b/i);
  const mainClause = (mainRaw || text).trim();

  for (const { pattern, label } of CONTRAST_CLAUSE_PATTERNS) {
    if (pattern.test(mainClause)) {
      violations.push({
        type: 'contrast-clause',
        pattern: label,
        message: `Contains contrast clause "${label}" in the main claim. Ken's Voice Rule 5: state the fact and stop — no "not X" / "instead of X" / "without X" hedging before "because".`,
      });
      break; // One contrast-clause violation is enough; no need to pile on
    }
  }

  const words = countWords(text);
  if (words > maxWords) {
    violations.push({
      type: 'word-count',
      message: `Word count ${words} exceeds limit of ${maxWords}. Ken's Voice Rule 10: one thought per sentence, keep it dense-but-short.`,
    });
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}

// ─── Tier 3 proof check ───────────────────────────────────
//
// Tier 3 Proof Standard (from methodology): bullets are ONLY hard proof —
// specific, verifiable facts. Not value claims, not comparative narrative.
//
// GOOD: "One week cycle time reduced to under 1 minute" (specific number)
// GOOD: "$4,000 test cost reduced to under $1" (specific number)
// GOOD: "FDA approval pending" (named certification)
// GOOD: "Geisinger Clinic evaluation" (named organization)
// BAD:  "Faster time-to-treatment" (comparative without number)
// BAD:  "Better lab efficiency" (comparative without number)
//
// The test a skeptic applies: can I verify this independently? If not, it's
// not proof. Comparative adjectives alone never pass — they need a number,
// percent, dollar amount, proper noun, or acronym to anchor them to a fact.

// Comparatives and value-claim verbs/adjectives that must be backed by
// a concrete anchor when they appear in a Tier 3 bullet.
const COMPARATIVE_WORDS = /\b(faster|quicker|slower|better|worse|easier|simpler|harder|stronger|weaker|smoother|cleaner|safer|sharper|higher|lower|greater|smaller|larger|bigger|shorter|longer|improved|enhanced|superior|optimized|streamlined|reduced|increased|decreased|boosted|minimized|maximized|more|less|fewer)\b/i;

// Anchors that indicate a concrete, verifiable fact:
//   \d — any digit (covers "1 week", "$4,000", "99%", "3x", "under 1 minute")
//   \b[A-Z]{2,}\b — acronyms like FDA, ISO, SOC, HIPAA, HITRUST
//   mid-word proper noun like "Geisinger" or "Mayo" (capital after first char,
//   skipping sentence-initial capital which is just grammar)
function hasConcreteAnchor(text: string): boolean {
  if (/\d/.test(text)) return true;
  if (/\b[A-Z]{2,}\b/.test(text)) return true;
  // Proper-noun detection: a word starting with a capital letter that is NOT
  // the first word of the bullet. Avoids flagging "Reduced" at sentence start
  // while still catching "Geisinger Clinic" or "Mayo eval."
  const trimmed = text.trim();
  const afterFirst = trimmed.slice(trimmed.split(/\s+/)[0]?.length ?? 0);
  if (/\b[A-Z][a-zA-Z]{2,}\b/.test(afterFirst)) return true;
  return false;
}

/**
 * Check a Tier 3 proof bullet. Returns a violation if the bullet contains
 * a comparative/value-claim word WITHOUT any concrete anchor (number, acronym,
 * or proper noun). This enforces the "skeptic verification" rule.
 */
export function checkProofBullet(text: string): VoiceGuardResult {
  const violations: VoiceGuardViolation[] = [];
  if (!text || !text.trim()) return { passed: true, violations: [] };

  const match = text.match(COMPARATIVE_WORDS);
  if (match && !hasConcreteAnchor(text)) {
    violations.push({
      type: 'proof-comparative',
      pattern: match[0],
      message: `Comparative "${match[0]}" used without a specific number, percent, dollar amount, acronym, or named organization. Tier 3 Proof Standard: bullets must be independently verifiable facts — a skeptic can confirm them. Comparative adjectives alone are value claims, not proof.`,
    });
  }
  return { passed: violations.length === 0, violations };
}

/**
 * Build a correction message from violations, to feed back into generation
 * as retry context.
 */
export function buildGuardCorrection(
  text: string,
  result: VoiceGuardResult,
  column?: string,
): string {
  if (result.passed) return '';
  const header = column
    ? `The ${column} statement "${text}" has voice violations:`
    : `Statement "${text}" has voice violations:`;
  const list = result.violations.map(v => `  - ${v.message}`).join('\n');
  return `\n\n══ VOICE CORRECTION ══\n${header}\n${list}\n\nRewrite the statement fixing these specific issues. Keep the same priority and mechanism; just drop the hedging and shorten if needed.`;
}
