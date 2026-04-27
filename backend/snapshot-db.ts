// Belt-and-suspenders DB snapshot. Reads every Prisma-managed table into
// a single JSON file timestamped at run start. NOT a full pg_dump
// equivalent — schema/migrations are not captured here (those live in
// backend/prisma/migrations/ in the git repo). What this captures:
// every row of user-generated data, sufficient to rebuild the app's
// state if Neon were lost or corrupted.
//
// To restore: read the JSON, walk each table in dependency order, and
// re-insert via Prisma. Cuid IDs and timestamps round-trip.
//
// Run from anywhere with the backend's DATABASE_URL in env:
//   API_URL is not needed; this hits the DB directly.
//   npx tsx --env-file=/path/to/backend/.env /path/to/snapshot-db.ts

import { PrismaClient } from '@prisma/client';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const prisma = new PrismaClient();

async function main() {
  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(
    '/Users/kenrosen/Documents/MariaBackups',
    `maria-db-snapshot-${stamp}.json`
  );

  console.log(`Reading every table into ${outFile} ...`);

  const data = {
    snapshotStartedAt: startedAt.toISOString(),
    user: await prisma.user.findMany(),
    workspace: await prisma.workspace.findMany(),
    workspaceMember: await prisma.workspaceMember.findMany(),
    inviteCode: await prisma.inviteCode.findMany(),
    offering: await prisma.offering.findMany(),
    offeringElement: await prisma.offeringElement.findMany(),
    audience: await prisma.audience.findMany(),
    priority: await prisma.priority.findMany(),
    threeTierDraft: await prisma.threeTierDraft.findMany(),
    mapping: await prisma.mapping.findMany(),
    tier1Statement: await prisma.tier1Statement.findMany(),
    tier2Statement: await prisma.tier2Statement.findMany(),
    tier3Bullet: await prisma.tier3Bullet.findMany(),
    fiveChapterStory: await prisma.fiveChapterStory.findMany(),
    chapterContent: await prisma.chapterContent.findMany(),
    claim: await prisma.claim.findMany(),
    cellVersion: await prisma.cellVersion.findMany(),
    tableVersion: await prisma.tableVersion.findMany(),
    storyVersion: await prisma.storyVersion.findMany(),
    chapterVersion: await prisma.chapterVersion.findMany(),
    conversationMessage: await prisma.conversationMessage.findMany(),
    assistantMessage: await prisma.assistantMessage.findMany(),
    shareLink: await prisma.shareLink.findMany(),
    observation: await prisma.observation.findMany(),
    expressJob: await prisma.expressJob.findMany(),
    guidedSession: await prisma.guidedSession.findMany(),
    userStyleRule: await prisma.userStyleRule.findMany(),
    snapshotFinishedAt: new Date().toISOString(),
  };

  const counts = Object.entries(data)
    .filter(([, v]) => Array.isArray(v))
    .map(([k, v]) => `${k}: ${(v as unknown[]).length}`);

  await writeFile(outFile, JSON.stringify(data, null, 2));
  console.log(`Wrote ${outFile}`);
  console.log(`Row counts:`);
  for (const c of counts) console.log(`  ${c}`);
}

main()
  .catch((err) => {
    console.error('Snapshot failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
