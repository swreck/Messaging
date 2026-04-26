// Round C — Engineering Table style system: effective-style resolver.
//
// Generation, Refine Language, and Polish all read the EFFECTIVE style at
// each invocation. Resolution chain (highest priority first):
//
//   deliverable.style ?? user.defaultStyle ?? workspace.defaultStyle ?? SYSTEM_DEFAULT
//
// Empty string at any level means "unset, fall through." SYSTEM_DEFAULT is
// always TABLE_FOR_2 (preserves the v3.x behavior for existing users).
//
// Personalized fallback: if the resolved style is PERSONALIZED but the user
// has no voice profile yet, callers must fall back to TABLE_FOR_2. The
// frontend surfaces a banner; the backend is responsible for the safety
// fallback in voice selection.

import { prisma } from './prisma.js';

export type EffectiveStyle = 'TABLE_FOR_2' | 'ENGINEERING_TABLE' | 'PERSONALIZED';

export const SYSTEM_DEFAULT_STYLE: EffectiveStyle = 'TABLE_FOR_2';

const VALID_STYLES: ReadonlySet<string> = new Set(['TABLE_FOR_2', 'ENGINEERING_TABLE', 'PERSONALIZED']);

function normalize(value: string | null | undefined): EffectiveStyle | '' {
  if (!value) return '';
  return VALID_STYLES.has(value) ? (value as EffectiveStyle) : '';
}

/**
 * Resolve the effective style for a generation call. Pass the most specific
 * pieces you have — null/undefined for any layer that doesn't apply.
 */
export function resolveStyle(opts: {
  deliverableStyle?: string | null;
  userStyle?: string | null;
  workspaceStyle?: string | null;
}): EffectiveStyle {
  const deliverable = normalize(opts.deliverableStyle);
  if (deliverable) return deliverable;
  const user = normalize(opts.userStyle);
  if (user) return user;
  const workspace = normalize(opts.workspaceStyle);
  if (workspace) return workspace;
  return SYSTEM_DEFAULT_STYLE;
}

/**
 * Look up the effective style for a Five Chapter Story. Reads the
 * deliverable's per-deliverable override, the author's user-level default,
 * and the workspace-level default in one query.
 */
export async function resolveStyleForStory(storyId: string, userId: string): Promise<EffectiveStyle> {
  const story = await prisma.fiveChapterStory.findUnique({
    where: { id: storyId },
    select: {
      style: true,
      draft: { select: { offering: { select: { workspaceId: true } } } },
    },
  });
  const workspaceId = story?.draft?.offering?.workspaceId || null;
  const [user, workspace] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { defaultStyle: true } }),
    workspaceId ? prisma.workspace.findUnique({ where: { id: workspaceId }, select: { defaultStyle: true } }) : Promise.resolve(null),
  ]);
  return resolveStyle({
    deliverableStyle: story?.style ?? null,
    userStyle: user?.defaultStyle ?? null,
    workspaceStyle: workspace?.defaultStyle ?? null,
  });
}

/**
 * Effective style WITHOUT a specific deliverable in scope — used for chat
 * generation, ad-hoc rewrites, etc. Requires only the user/workspace context.
 */
export async function resolveStyleForUser(userId: string, workspaceId?: string | null): Promise<EffectiveStyle> {
  const [user, workspace] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { defaultStyle: true } }),
    workspaceId ? prisma.workspace.findUnique({ where: { id: workspaceId }, select: { defaultStyle: true } }) : Promise.resolve(null),
  ]);
  return resolveStyle({
    userStyle: user?.defaultStyle ?? null,
    workspaceStyle: workspace?.defaultStyle ?? null,
  });
}

/** Validate input from a settings PUT before writing to the DB. */
export function validateStyleInput(value: unknown): { ok: true; value: '' | EffectiveStyle } | { ok: false; error: string } {
  if (value === '' || value === null || typeof value === 'undefined') return { ok: true, value: '' };
  if (typeof value !== 'string') return { ok: false, error: 'style must be a string' };
  if (value === '' || VALID_STYLES.has(value)) return { ok: true, value: value as EffectiveStyle };
  return { ok: false, error: `style must be one of: "" (unset), ${[...VALID_STYLES].join(', ')}` };
}
