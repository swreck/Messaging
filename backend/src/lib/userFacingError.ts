// Bundle 1B Item 1 — error-translation layer.
//
// Architectural invariant: every backend error path that surfaces in Maria's
// chat routes through this translator before being written to the user. The
// translator returns Cowork-authored, Maria-voice copy from the locked COPY
// map below. The underlying error is logged via console.error for debugging
// but is never returned to the user.
//
// COPY is locked methodology copy. Edits require Cowork sign-off. New kinds
// are added by Cowork via cc-prompts/cowork-item-1-copy-extension-*.md
// files; CC drops the locked text in verbatim.

export type ErrorKind =
  | 'priority-save'
  | 'audience-save'
  | 'offering-save'
  | 'chapter-generate'
  | 'chapter-regenerate'
  | 'tier-generate'
  | 'tier-restructure'
  | 'export-generate'
  | 'name-save'
  | 'auth-expired'
  | 'mf-draft'
  | 'direction-apply'
  | 'build-start'
  | 'build-failed'
  | 'build-status'
  | 'foundation-rebuild'
  | 'acknowledge'
  | 'url-read'
  | 'audience-research'
  | 'differentiation-test'
  | 'generic';

export interface ErrorContext {
  kind: ErrorKind;
  /** Pass through the underlying error for log correlation. NEVER returned to user. */
  underlying?: unknown;
  /** Optional: workspace/user IDs for log correlation. */
  userId?: string;
  workspaceId?: string;
  /** Optional free-form site label for the log line, e.g. "actions.ts:1742 save_durable_context". */
  site?: string;
}

// Locked Cowork copy per kind. DO NOT EDIT without Cowork sign-off.
// Sources:
//   - cc-prompts/cowork-item-1-copy-templates-2026-05-04.md (initial 10 kinds)
//   - cc-prompts/cowork-item-5-rulings-2026-05-05.md (Item 1 follow-up: 10 more kinds)
const COPY: Record<ErrorKind, string> = {
  'priority-save':
    "I'd save that, but the priority I'm trying to save it under isn't where I expected. Want to refresh the page and try again, or skip the save for now?",
  'audience-save':
    "I'd save that, but the audience I'm trying to save it under isn't where I expected. Want to refresh the page and try again, or skip the save for now?",
  'offering-save':
    "I'd save that, but the offering I'm trying to save it under isn't where I expected. Want to refresh the page and try again, or skip the save for now?",
  'chapter-generate':
    "Something stalled while I was writing that chapter. Let me try again — it usually clears on a retry.",
  'chapter-regenerate':
    "That regenerate didn't go through. Want me to try once more, or leave the current version?",
  'tier-generate':
    "Something stalled while I was building your Three Tier. Let me try that again from the last clean step.",
  'tier-restructure':
    "Couldn't restructure the table this round — your previous version is back. Try saying it differently, or point me at the specific cells you want to change.",
  'export-generate':
    "That export didn't come through. Want me to try once more?",
  'name-save':
    "I had trouble saving the name — let me try again, or you can re-enter it in Settings.",
  'auth-expired':
    "Looks like your session timed out. Sign back in and we'll pick up where we left off.",
  'mf-draft':
    "I tried to draft those motivating factors but couldn't this round. Try again from the offering page, or share what you've got and I'll work with it.",
  'direction-apply':
    "I couldn't apply that direction this round. Try saying it differently, or point me at the specific cells you want to change.",
  'build-start':
    "Something blocked the build before it started. Want me to try again?",
  'build-failed':
    "The build ran into a problem partway through. Tell me which part you'd like to redo, or I can try once more from the start.",
  'build-status':
    "I couldn't pull the build status just now. Want me to try again?",
  'foundation-rebuild':
    "Couldn't rebuild the foundation this round. Want me to try once more, or work with what we've got?",
  'acknowledge':
    "I noted that — keep going.",
  'url-read':
    "I couldn't read that URL just now. Want to paste the content directly so I can work from it?",
  'audience-research':
    "I couldn't pull research on that audience this round. Try again, or tell me what you already know about them.",
  'differentiation-test':
    "Couldn't finish the differentiation test this round. Want me to try once more, or tell me which competitors to focus on?",
  'generic':
    "I ran into something I couldn't get past just now. Want to try that again, or skip it for now?",
};

/**
 * Translate a backend error into a Maria-voice user-facing string.
 *
 * The underlying error is logged for debugging; it is NEVER returned.
 *
 * Usage:
 *   } catch (err) {
 *     actionResult = translateError(err, {
 *       kind: 'priority-save',
 *       site: 'actions.ts:1742 save_durable_context',
 *       userId,
 *       workspaceId,
 *     });
 *   }
 */
export function translateError(err: unknown, context: ErrorContext): string {
  const errMessage = err instanceof Error ? err.message : String(err);
  const errStack = err instanceof Error ? err.stack : undefined;
  console.error(
    `[userFacingError] kind=${context.kind} site=${context.site || 'unspecified'} userId=${context.userId || ''} workspaceId=${context.workspaceId || ''} err=${errMessage}`,
    errStack ? `\n${errStack}` : '',
  );
  return COPY[context.kind] || COPY.generic;
}

// Acceptance-test helper. Used by tests and by the lint-catch-net assertions
// below — exposed so callers can verify a given message contains no internal
// vocabulary. Returns true when the message is safe.
const INTERNAL_VOCAB_PATTERNS: RegExp[] = [
  /\bprisma\b/i,
  /\bpostgres\b/i,
  /\bpostgresql\b/i,
  /\bneon\b/i,
  /\bdatabase\b/i,
  /\bendpoint\b/i,
  /\bhttp\s*4\d\d\b/i,
  /\bhttp\s*5\d\d\b/i,
  /\b(?:status|error)\s*[45]\d\d\b/i,
  /\binvocation\b/i,
  /\bstack\s*trace\b/i,
  /\bnull\b/i,
  /\bundefined\b/i,
  /\bexception\b/i,
  /\bschema\b/i,
  /\bquery\b/i,
  /\btransaction\b/i,
  /\.update\(\)/i,
  /\.findUnique\(\)/i,
  /\.findFirst\(\)/i,
  /\.findMany\(\)/i,
  /\.create\(\)/i,
  /\.delete\(\)/i,
];

export function messageContainsInternalVocab(message: string): boolean {
  return INTERNAL_VOCAB_PATTERNS.some((rx) => rx.test(message));
}
