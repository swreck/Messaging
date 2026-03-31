/**
 * Data migration: Create workspaces for existing users and assign their data.
 *
 * For each user:
 * 1. Creates a workspace named "[First Offering Name] Messages" (or "[Username]'s Messages" if no offerings)
 * 2. Adds the user as workspace owner
 * 3. Assigns all their offerings and audiences to the workspace
 *
 * Safe to run multiple times — skips users who already have a workspace.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany({
    include: {
      offerings: { orderBy: { createdAt: 'asc' }, take: 1 },
      audiences: true,
      workspaces: true,
    },
  });

  for (const user of users) {
    // Skip if user already has a workspace
    if (user.workspaces.length > 0) {
      console.log(`  Skipping ${user.username} — already has ${user.workspaces.length} workspace(s)`);
      continue;
    }

    // Name the workspace after the first offering, or fall back to username
    const firstOffering = user.offerings[0];
    const name = firstOffering
      ? `${firstOffering.name} Messages`
      : `${user.username}'s Messages`;

    // Create workspace
    const workspace = await prisma.workspace.create({
      data: {
        name,
        members: {
          create: {
            userId: user.id,
            role: 'owner',
          },
        },
      },
    });

    console.log(`  Created workspace "${name}" for ${user.username}`);

    // Assign all offerings to this workspace
    const offeringResult = await prisma.offering.updateMany({
      where: { userId: user.id, workspaceId: null },
      data: { workspaceId: workspace.id },
    });
    console.log(`    → Assigned ${offeringResult.count} offering(s)`);

    // Assign all audiences to this workspace
    const audienceResult = await prisma.audience.updateMany({
      where: { userId: user.id, workspaceId: null },
      data: { workspaceId: workspace.id },
    });
    console.log(`    → Assigned ${audienceResult.count} audience(s)`);
  }

  console.log('\nDone.');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
