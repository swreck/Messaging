// Bundle 1B Rules 1 + 8 — derived build status for Recent Work cards.
//
// Today, the home Recent Work card reads from FiveChapterStory.stage
// (which advances through chapters → joined → blended) and from
// ExpressJob.status. The two are not always in sync: the stage may
// advance while the job is still running, OR the job may be `complete`
// while a downstream methodology-failure suppressed
// AUTONOMOUS_BUILD_COMPLETE. The card's status text needs a single
// derived value that the user-perceptible chat state can be trusted
// to align with.
//
// The canonical "complete" signal is the locked Cowork chat message
// (kind='autonomous-build-complete' OR kind='methodology-failure')
// associated with the same story. The presence of that message is
// what the user sees as the "done" moment in chat. The card matches.
//
// Per Cowork's Rule 1 edit: the lookup is "the most recent
// assistantMessage of kind autonomous-build-complete OR
// methodology-failure for this story, regardless of age." No "last
// hour" window — older builds whose terminal message was written
// long ago still resolve correctly.

import { prisma } from './prisma.js';

export type DerivedBuildStatus =
  | 'building'        // pipeline running, no terminal chat message yet
  | 'polishing'       // blend stage active (subset of building, kept for UX label)
  | 'complete'        // AUTONOMOUS_BUILD_COMPLETE chat message present
  | 'methodology-failed' // methodology-failure chat message present
  | 'error';          // ExpressJob.status === 'error' AND no later complete/methodology-failure

export interface DeriveBuildStatusInput {
  /** ExpressJob row for the build, OR null if no job exists yet. */
  job: { status: string; stage: string; userId: string; draftId: string | null } | null;
  /** Story id (the build's deliverable). When non-null, the lookup
   *  scopes the terminal chat message search to this story via the
   *  storyId field on assistantMessage.context. */
  storyId: string | null;
  /** UserId for the assistantMessage scope. */
  userId: string;
}

export interface DerivedBuildStatusResult {
  status: DerivedBuildStatus;
  /** Optional UX label for cards: "Building", "Polishing", "Complete · 8m ago", etc.
   *  Caller renders this, not the raw status enum. */
  label: string;
}

const TERMINAL_KINDS = ['autonomous-build-complete', 'methodology-failure'] as const;

/**
 * Derive the build status for a Recent Work card or in-progress
 * draft view. Reads:
 *   - ExpressJob.status + stage (running indicator)
 *   - The most recent assistantMessage with kind in TERMINAL_KINDS
 *     scoped to the story (terminal indicator)
 *
 * Precedence:
 *   1. Terminal chat message exists → 'complete' or 'methodology-failed'.
 *   2. Job.status === 'error' AND no terminal message → 'error'.
 *   3. Job.status indicates blend stage → 'polishing'.
 *   4. Otherwise → 'building'.
 *
 * The terminal chat message lookup uses the JSON path
 * context.storyId match. AssistantMessage.context is JSON; Prisma's
 * `path` filter handles the lookup. When storyId is null (early
 * pipeline state before story creation), the lookup falls back to
 * the most recent terminal-kind message for the user within the
 * last 24 hours.
 */
export async function deriveBuildStatus(
  input: DeriveBuildStatusInput,
): Promise<DerivedBuildStatusResult> {
  const { job, storyId, userId } = input;

  // Step 1: look for a terminal chat message scoped to this story.
  const terminalMessage = await findTerminalMessage(userId, storyId);

  if (terminalMessage) {
    if (terminalMessage.kind === 'autonomous-build-complete') {
      return { status: 'complete', label: buildLabelComplete(terminalMessage.createdAt) };
    }
    if (terminalMessage.kind === 'methodology-failure') {
      return { status: 'methodology-failed', label: 'Needs review' };
    }
  }

  // Step 2: error state.
  if (job && job.status === 'error') {
    return { status: 'error', label: 'Error — try again' };
  }

  // Step 3: polishing vs building.
  const stage = (job?.stage || '').toLowerCase();
  if (stage.includes('polish') || stage.includes('blend')) {
    return { status: 'polishing', label: 'Polishing' };
  }

  // Step 4: default — building.
  return { status: 'building', label: 'Building' };
}

interface TerminalMessageHit {
  kind: string;
  createdAt: Date;
}

async function findTerminalMessage(
  userId: string,
  storyId: string | null,
): Promise<TerminalMessageHit | null> {
  const baseWhere: any = { userId };

  // When we have a storyId, scope by context.storyId match. When we
  // don't, fall back to a 24-hour user-scoped lookup so a fresh
  // pipeline that hasn't created its story yet doesn't accidentally
  // match an unrelated older terminal message.
  if (storyId) {
    baseWhere.context = { path: ['storyId'], equals: storyId };
  } else {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    baseWhere.createdAt = { gte: cutoff };
  }

  const recent = await prisma.assistantMessage.findFirst({
    where: baseWhere,
    orderBy: { createdAt: 'desc' },
    select: { context: true, createdAt: true },
    take: 1,
  });

  if (!recent) return null;
  const ctx = recent.context as Record<string, any> | null;
  const kind = typeof ctx?.kind === 'string' ? ctx.kind : '';
  if (TERMINAL_KINDS.includes(kind as any)) {
    return { kind, createdAt: recent.createdAt };
  }
  return null;
}

function buildLabelComplete(createdAt: Date): string {
  const ageMs = Date.now() - createdAt.getTime();
  const ageMin = Math.round(ageMs / 60000);
  if (ageMin < 1) return 'Complete · just now';
  if (ageMin < 60) return `Complete · ${ageMin}m ago`;
  const ageHrs = Math.floor(ageMin / 60);
  if (ageHrs < 24) return `Complete · ${ageHrs}h ago`;
  const ageDays = Math.floor(ageHrs / 24);
  return `Complete · ${ageDays}d ago`;
}
