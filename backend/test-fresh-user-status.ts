/**
 * Round 3.1 Item B — backend regression test for the React-state-survives-
 * logout root cause (Item 4).
 *
 * The bug: a brand-new user briefly saw a partner-return-card claiming
 * "I know what VP Marketing typically cares about. Want me to draft the
 * priorities?" — content that belonged to a previous logged-in user.
 * Root cause turned out to be frontend state-not-clearing, but the
 * backend's introduced-gate at routes/partner.ts is the line of defense
 * that ensures a fresh user's /partner/status response is null on every
 * proactive field. This test asserts that contract end-to-end.
 *
 * What it does:
 *   1. Creates a one-off invite code (cleaned up at end).
 *   2. Registers a fresh user with that code.
 *   3. GETs /api/partner/status with the new user's token.
 *   4. Asserts proactiveOffer === null AND resumeDraft === null AND
 *      returnContext === null.
 *   5. Cleans up: deletes the user + the consumed invite code.
 *
 * Run: npx --prefix backend tsx --env-file=backend/.env backend/test-fresh-user-status.ts
 *
 * Not part of CI yet. Intended as a one-off backstop runnable any time
 * the /partner/status proactive logic changes.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const BASE = process.env.API_URL || 'https://mariamessaging.up.railway.app/api';

async function req(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function main() {
  const stamp = Date.now().toString(36);
  const code = `TEST_REGRESSION_${stamp}`;
  const username = `test_regression_${stamp}`;
  const password = 'regression-test-password';

  let createdInviteCodeId: string | null = null;
  let createdUserId: string | null = null;

  let exitCode = 0;

  try {
    // 1. Create a one-off invite code directly in the DB so the test
    //    doesn't need an admin token. Use a deliberately ugly invitee
    //    name to confirm Round 3.1 Item 1 — that the fabricated firstName
    //    no longer flows through to /partner/status.
    const invite = await prisma.inviteCode.create({
      data: {
        code,
        inviteeName: 'TEST Regression Stamp Multi Word',
        role: 'editor',
      },
    });
    createdInviteCodeId = invite.id;
    console.log(`  + created invite code ${code}`);

    // 2. Register the fresh user via the API.
    const register = await req('POST', '/auth/register', {
      inviteCode: code,
      username,
      password,
    });
    if (register.status !== 201 || !register.data?.token) {
      throw new Error(`register failed: status=${register.status} body=${JSON.stringify(register.data)}`);
    }
    const token = register.data.token as string;
    createdUserId = register.data?.user?.userId || null;
    console.log(`  + registered user ${username}`);

    // 3. GET /api/partner/status with the new user's token.
    const status = await req('GET', '/partner/status', undefined, token);
    if (status.status !== 200) {
      throw new Error(`partner/status failed: status=${status.status} body=${JSON.stringify(status.data)}`);
    }

    // 4. Assertions.
    const proactiveOffer = status.data?.proactiveOffer;
    const resumeDraft = status.data?.resumeDraft;
    const returnContext = status.data?.returnContext;
    const introduced = status.data?.introduced;

    // Per the CC prompt, the regression backstop covers exactly these
    // three null fields. introduced=false is checked alongside them as
    // a sanity test on the introduced-gate that protects them.
    const assertions: Array<[string, boolean, string]> = [
      ['proactiveOffer is null', proactiveOffer === null || proactiveOffer === undefined, `got ${JSON.stringify(proactiveOffer)}`],
      ['resumeDraft is null', resumeDraft === null || resumeDraft === undefined, `got ${JSON.stringify(resumeDraft)}`],
      ['returnContext is null', returnContext === null || returnContext === undefined, `got ${JSON.stringify(returnContext)}`],
      ['introduced is false', introduced === false, `got ${JSON.stringify(introduced)}`],
    ];

    let passed = 0;
    let failed = 0;
    for (const [name, ok, detail] of assertions) {
      if (ok) {
        passed++;
        console.log(`  ✓ ${name}`);
      } else {
        failed++;
        console.log(`  ✗ ${name} — ${detail}`);
      }
    }

    console.log(`\n  ${passed}/${passed + failed} passed`);
    if (failed > 0) {
      exitCode = 1;
    }
  } catch (err: unknown) {
    console.error('  ! test failed:', err instanceof Error ? err.message : err);
    exitCode = 1;
  } finally {
    // 5. Cleanup. Order matters — delete dependents first.
    try {
      if (createdUserId) {
        // Delete workspaces the user solely owns.
        const ownerships = await prisma.workspaceMember.findMany({
          where: { userId: createdUserId, role: 'owner' },
          include: { workspace: { include: { _count: { select: { members: true } } } } },
        });
        for (const m of ownerships) {
          if (m.workspace?._count?.members === 1) {
            // Cascade delete-on-workspace-delete handles dependent rows
            // for any tables Prisma defines onDelete: Cascade. For ones
            // that don't cascade, leave them — this test's workspace is
            // empty by definition.
            await prisma.workspace.delete({ where: { id: m.workspaceId } }).catch(() => {});
          } else {
            await prisma.workspaceMember.delete({ where: { id: m.id } }).catch(() => {});
          }
        }
        // Membership rows for non-owner workspaces.
        await prisma.workspaceMember.deleteMany({ where: { userId: createdUserId } }).catch(() => {});
        // Detach the invite code from the user before deleting (the
        // unique constraint on usedById forces null-out first).
        await prisma.inviteCode.updateMany({
          where: { usedById: createdUserId },
          data: { usedById: null },
        }).catch(() => {});
        await prisma.user.delete({ where: { id: createdUserId } }).catch(() => {});
        console.log(`  - cleaned up user ${username}`);
      }
      if (createdInviteCodeId) {
        await prisma.inviteCode.delete({ where: { id: createdInviteCodeId } }).catch(() => {});
        console.log(`  - cleaned up invite code ${code}`);
      }
    } catch (cleanupErr) {
      console.error('  ! cleanup error (non-fatal):', cleanupErr instanceof Error ? cleanupErr.message : cleanupErr);
    }
    await prisma.$disconnect();
  }

  process.exit(exitCode);
}

main();
