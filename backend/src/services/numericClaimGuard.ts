// Round 3.4 coaching-fix Finding 1 — numeric-claim guard.
//
// Cheap, deterministic, non-LLM service. Extracts every numeric claim
// from a generated output text and verifies the number appears in the
// user-input transcript. The provenance classifier (Round D) only
// classifies provenance PATTERN; it does not compare numbers. The
// fabrication check (Round B-ish) only runs on chapter content and not
// on Three Tier statements or email medium adaptation. This guard
// closes the gap that let Lila's "30%" become the deliverable's "40%"
// across four surfaces.
//
// Surface coverage: callers wire this into every generation surface
// that emits prose containing numbers. Specifically:
//   - Tier 2 / Tier 3 statements (routes/ai.ts:generateTierWithVoiceCheck)
//   - Per-chapter generation (expressPipeline.ts chapter loop)
//   - Post-blend chapter content (expressPipeline.ts blend output)
//   - Email/medium adaptation (medium-specific render path)
//
// Behavior: extract → compare → flag → caller regenerates with feedback.
// Three-retry hard cap is enforced at the caller level so each call
// site can log its own retry exhaust trail.

export interface NumericClaim {
  /** The exact text the regex matched, e.g. "40%", "$1.2M", "3x", "30 percent". */
  raw: string;
  /** Normalized numeric value, e.g. 40, 1200000, 3, 30. */
  value: number;
  /** A unit hint: "%", "x", "$", "K", "M", "B", or "" for a bare number. */
  unit: string;
  /** A short window of surrounding text (~40 chars) for caller diagnostics. */
  context: string;
}

export interface NumericClaimGuardInput {
  /** The generated output text being checked. */
  outputText: string;
  /** Free-text transcript of every authorized source the user provided —
   *  situation, interview answers, attached document text, named-peer
   *  evidence, Three Tier statements that were already user-approved.
   *  Anything in this transcript is considered a valid source for a
   *  numeric claim in the output. */
  userInputTranscript: string;
}

export interface NumericClaimViolation {
  /** The mismatched claim from the output. */
  claim: NumericClaim;
  /** Short human-readable description for caller feedback. */
  reason: string;
}

export interface NumericClaimGuardResult {
  passed: boolean;
  violations: NumericClaimViolation[];
}

// ─── Extraction ─────────────────────────────────────────────────────
// Regex covers the common shapes Maria's deliverables use:
//   - "40%", "99.5%"
//   - "30 percent"
//   - "$4,000", "$1.2M", "$50B"
//   - "3x", "3.2x", "10×"
//   - "1,000 times", "30 days", "60 seconds"
//   - "over 99%", "more than 3x" — these are matched as the inner
//     numeric; the surrounding hedge doesn't change the claim's value.
//
// Bare integers smaller than 4 digits without a unit are skipped — they
// produce too many false positives ("the 5 priorities", "Chapter 2",
// etc.). The deliverable's quantitative-evidence claims are virtually
// always 4+ digits or carry a unit like %, x, $, etc.
const NUMERIC_TOKEN_PATTERN = new RegExp([
  // Percentages: "40%", "99.5%"
  '(\\d+(?:\\.\\d+)?)(\\s*%)',
  // "40 percent", "30 percent"
  '(\\d+(?:\\.\\d+)?)\\s+(percent)\\b',
  // Dollar amounts with optional suffix: "$4,000", "$1.2M", "$50K", "$2B"
  '(\\$\\s*\\d{1,3}(?:,\\d{3})*(?:\\.\\d+)?)(\\s*[KMB])?',
  '(\\$\\s*\\d+(?:\\.\\d+)?)(\\s*[KMB])?',
  // Multipliers: "3x", "3.2×", "over 10x"
  '(\\d+(?:\\.\\d+)?)(\\s*[x×])',
  // "1,000 times", "5 times"
  '(\\d{1,3}(?:,\\d{3})+|\\d+)\\s+(times)\\b',
  // Time units: "30 days", "60 seconds", "90 days"
  '(\\d+)\\s+(seconds?|minutes?|hours?|days?|weeks?|months?|quarters?|years?)\\b',
  // Bare integers >= 1000 (numeric magnitudes worth verifying)
  '(\\d{1,3}(?:,\\d{3})+)(?!\\s*[%xX×])',
  '(\\d{4,})(?!\\s*[%xX×])',
].join('|'), 'gi');

function normalizeValue(raw: string): { value: number; unit: string } {
  const trimmed = raw.trim();
  // Pull off the surrounding shape; treat the digit-bearing segment as
  // the value and the trailing unit token as the unit hint.
  const lower = trimmed.toLowerCase();

  // Percentage
  if (/%$/.test(trimmed) || /\bpercent\b/i.test(trimmed)) {
    const num = parseFloat(trimmed.replace(/[^\d.]/g, ''));
    return { value: num, unit: '%' };
  }
  // Dollar amount
  if (/^\$/.test(trimmed)) {
    let num = parseFloat(trimmed.replace(/[^\d.]/g, ''));
    if (/\bk\b/i.test(trimmed) || /K$/.test(trimmed)) num *= 1_000;
    else if (/\bm\b/i.test(trimmed) || /M$/.test(trimmed)) num *= 1_000_000;
    else if (/\bb\b/i.test(trimmed) || /B$/.test(trimmed)) num *= 1_000_000_000;
    return { value: num, unit: '$' };
  }
  // Multiplier
  if (/[x×]/i.test(trimmed)) {
    const num = parseFloat(trimmed.replace(/[^\d.]/g, ''));
    return { value: num, unit: 'x' };
  }
  // "times"
  if (/\btimes\b/i.test(lower)) {
    const num = parseFloat(trimmed.replace(/[^\d.]/g, ''));
    return { value: num, unit: 'times' };
  }
  // Time units
  const timeMatch = lower.match(/^(\d+)\s+(seconds?|minutes?|hours?|days?|weeks?|months?|quarters?|years?)$/);
  if (timeMatch) {
    return { value: parseInt(timeMatch[1], 10), unit: timeMatch[2] };
  }
  // Bare integer
  const num = parseFloat(trimmed.replace(/[^\d.]/g, ''));
  return { value: num, unit: '' };
}

export function extractNumericClaims(text: string): NumericClaim[] {
  const claims: NumericClaim[] = [];
  if (!text) return claims;
  let match: RegExpExecArray | null;
  // Reset regex state.
  NUMERIC_TOKEN_PATTERN.lastIndex = 0;
  while ((match = NUMERIC_TOKEN_PATTERN.exec(text)) !== null) {
    const raw = match[0].trim();
    if (!raw) continue;
    const { value, unit } = normalizeValue(raw);
    if (!Number.isFinite(value)) continue;
    // Skip bare integers under 1000 — too noisy.
    if (unit === '' && value < 1000) continue;
    const start = Math.max(0, match.index - 40);
    const end = Math.min(text.length, match.index + raw.length + 40);
    const context = text.substring(start, end).replace(/\s+/g, ' ').trim();
    claims.push({ raw, value, unit, context });
  }
  return claims;
}

// ─── Verification ────────────────────────────────────────────────────
// A claim is supported if the same numeric VALUE (with unit-aware
// tolerance) appears anywhere in the user-input transcript. Numeric
// equality is exact for percentages, multipliers, and time units; for
// dollar amounts we allow 1% slop to absorb format differences ("$4M"
// vs "$4,000,000").

function findMatchInTranscript(claim: NumericClaim, transcriptClaims: NumericClaim[]): boolean {
  for (const t of transcriptClaims) {
    if (claim.unit === t.unit) {
      // Same unit — value must match exactly (or within 1% for $).
      if (claim.unit === '$') {
        const tol = Math.max(claim.value, t.value) * 0.01;
        if (Math.abs(claim.value - t.value) <= tol) return true;
      } else {
        if (Math.abs(claim.value - t.value) < 1e-6) return true;
      }
    }
    // Cross-unit match: "30 percent" (transcript) === "30%" (output).
    if ((claim.unit === '%' && t.unit === '%') ||
        (claim.unit === 'percent' && t.unit === '%') ||
        (claim.unit === '%' && t.unit === 'percent')) {
      if (Math.abs(claim.value - t.value) < 1e-6) return true;
    }
  }
  return false;
}

export function checkNumericClaims(input: NumericClaimGuardInput): NumericClaimGuardResult {
  const outputClaims = extractNumericClaims(input.outputText);
  const transcriptClaims = extractNumericClaims(input.userInputTranscript);
  const violations: NumericClaimViolation[] = [];
  const seen = new Set<string>();
  for (const claim of outputClaims) {
    const key = `${claim.value}|${claim.unit}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!findMatchInTranscript(claim, transcriptClaims)) {
      violations.push({
        claim,
        reason: `Numeric claim "${claim.raw}" (value=${claim.value}, unit=${claim.unit || 'bare'}) does not appear anywhere in the user's input. Numeric specifics in the output must trace to a number the user actually stated.`,
      });
    }
  }
  return { passed: violations.length === 0, violations };
}

export function buildNumericClaimFeedback(violations: NumericClaimViolation[]): string {
  if (violations.length === 0) return '';
  const lines: string[] = [
    '',
    'NUMERIC-CLAIM GUARD VIOLATIONS — every numeric specific in the output must trace to a number the user actually stated. Regenerate with these violations corrected. Either:',
    '  (a) Replace the unsupported number with the user\'s stated number (look at the user input for the right value), OR',
    '  (b) Remove the specific number entirely and use a non-quantified phrasing the methodology supports.',
    '',
    'Violations:',
  ];
  for (const v of violations) {
    lines.push(`  - "${v.claim.raw}" — ${v.reason} Surrounding context: "${v.claim.context}"`);
  }
  lines.push('');
  lines.push('Do NOT invent a different number. Do NOT round up or down. Use only numbers the user actually said, or omit numeric specifics from the output entirely.');
  return lines.join('\n');
}
