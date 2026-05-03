// Bundle 1B Rule 7 — pipeline stall recovery watchdog.
//
// Today's heartbeats (TIER_GENERATION_HEARTBEAT, CHAPTERS_HEARTBEAT,
// BLEND_HEARTBEAT, STRUCTURAL_REGEN_HEARTBEAT) fire on per-stage
// timers. If a stage timer cancels but the next stage's timer fails
// to schedule (thrown error mid-transition, missed cleanup, etc.),
// the pipeline goes silent indefinitely. There's no global "pipeline
// silent for N minutes" detector.
//
// The watchdog is that detector. Wired from runPipeline at start, it
// checks every 4 minutes whether the pipeline is still emitting
// activity (heartbeats, milestones, soft-notes, build-complete,
// methodology-failure messages). If no activity for >4 minutes AND
// the ExpressJob.status is not yet terminal (complete | error), the
// watchdog writes the locked Cowork recovery message to chat with
// the three chips ("Start over", "I'll take it from here", "Get help").
//
// One-shot per pipeline run: after the recovery fires once, the
// watchdog stops. The user has the three chips to recover; the
// pipeline does NOT auto-restart.

import { prisma } from './prisma.js';
import {
  PIPELINE_STALL_RECOVERY_MESSAGE,
  PIPELINE_STALL_RECOVERY_CHIP_RESTART,
  PIPELINE_STALL_RECOVERY_CHIP_TAKE_OVER,
  PIPELINE_STALL_RECOVERY_CHIP_GET_HELP,
  PIPELINE_STALL_RECOVERY_THRESHOLD_MS,
} from '../prompts/milestoneCopy.js';

/** Pipeline-event message kinds the watchdog treats as activity. */
const ACTIVITY_KINDS = new Set([
  'milestone',
  'soft-note',
  'autonomous-pre-build',
  'autonomous-post-delivery',
  'autonomous-build-complete',
  'methodology-failure',
  'tier-heartbeat',
  'chapters-heartbeat',
  'blend-heartbeat',
  'stage-checkin-tier',
  'stage-checkin-chapters',
  'stage-checkin-blend',
  'stage-checkin-foundational',
  'stage-checkin-foundational-midpoint',
  'foundational-shift-pause',
  'structural-regen-heartbeat',
]);

interface WatchdogHandle {
  stop: () => void;
}

/**
 * Start a watchdog that monitors pipeline activity for the given job.
 * Returns a handle the caller can use to stop the watchdog when the
 * pipeline reaches a terminal state.
 *
 * The watchdog runs in a JS interval. Each tick reads the most recent
 * assistantMessage for the user with one of the ACTIVITY_KINDS. If the
 * latest activity message is older than the threshold AND the job's
 * status is not terminal, the recovery message fires and the watchdog
 * cancels.
 *
 * The pipeline-start time is also treated as activity for the FIRST
 * tick — so a pipeline that fails to write any message at all in its
 * first 4 minutes still triggers recovery.
 */
export function startPipelineWatchdog(
  jobId: string,
  userId: string,
  workspaceId: string,
): WatchdogHandle {
  const startedAtMs = Date.now();
  let cancelled = false;
  let recoveryFired = false;

  const tickIntervalMs = Math.min(60000, PIPELINE_STALL_RECOVERY_THRESHOLD_MS);

  const interval = setInterval(async () => {
    if (cancelled || recoveryFired) {
      clearInterval(interval);
      return;
    }
    try {
      // Check terminal state — if the job finished cleanly we're done.
      const job = await prisma.expressJob.findUnique({
        where: { id: jobId },
        select: { status: true },
      });
      if (!job) {
        cancelled = true;
        clearInterval(interval);
        return;
      }
      if (job.status === 'complete' || job.status === 'error') {
        cancelled = true;
        clearInterval(interval);
        return;
      }

      // Check most-recent activity message for this user. The
      // assistantMessage.context.kind field carries the marker we
      // match against ACTIVITY_KINDS.
      const recent = await prisma.assistantMessage.findFirst({
        where: {
          userId,
          createdAt: { gte: new Date(startedAtMs - 1000) },
        },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, context: true },
      });

      const lastActivityMs = (() => {
        if (!recent) return startedAtMs;
        const ctx = recent.context as Record<string, any> | null;
        const kind = typeof ctx?.kind === 'string' ? ctx.kind : '';
        if (ACTIVITY_KINDS.has(kind)) return recent.createdAt.getTime();
        return startedAtMs;
      })();

      const silentForMs = Date.now() - lastActivityMs;
      if (silentForMs >= PIPELINE_STALL_RECOVERY_THRESHOLD_MS) {
        recoveryFired = true;
        const chips = [
          PIPELINE_STALL_RECOVERY_CHIP_RESTART,
          PIPELINE_STALL_RECOVERY_CHIP_TAKE_OVER,
          PIPELINE_STALL_RECOVERY_CHIP_GET_HELP,
        ];
        try {
          await prisma.assistantMessage.create({
            data: {
              userId,
              role: 'assistant',
              content: PIPELINE_STALL_RECOVERY_MESSAGE,
              context: {
                channel: 'partner',
                workspaceId,
                kind: 'pipeline-stall-recovery',
                chips,
                stalledJobId: jobId,
              },
            },
          });
          console.warn(
            `[PipelineWatchdog] ${jobId} STALL DETECTED — silent for ${Math.round(silentForMs / 1000)}s; recovery message + chips written.`,
          );
        } catch (err) {
          console.error(
            `[PipelineWatchdog] ${jobId} recovery message write failed:`,
            err,
          );
        }
        clearInterval(interval);
      }
    } catch (err) {
      console.error(`[PipelineWatchdog] ${jobId} tick error (continuing):`, err);
    }
  }, tickIntervalMs);

  return {
    stop: () => {
      cancelled = true;
      clearInterval(interval);
    },
  };
}
