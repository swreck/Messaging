/**
 * Data migration: Move motivating factors from priorities to their mapped differentiators.
 *
 * For each priority that has a motivating factor AND has mappings to offering elements,
 * copy the motivating factor to each mapped element (if the element doesn't already have one).
 *
 * Run: npx tsx prisma/migrate-mf-to-elements.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Migrating motivating factors from priorities to offering elements...\n');

  // Find all priorities with motivating factors
  const priorities = await prisma.priority.findMany({
    where: { motivatingFactor: { not: '' } },
    include: {
      mappings: {
        include: { element: true },
      },
    },
  });

  let migrated = 0;
  let skipped = 0;

  for (const p of priorities) {
    if (p.mappings.length === 0) {
      console.log(`  Priority "${p.text}" has MF but no mappings — skipping`);
      skipped++;
      continue;
    }

    for (const m of p.mappings) {
      if (m.element.motivatingFactor) {
        console.log(`  Element "${m.element.text}" already has MF — skipping`);
        skipped++;
        continue;
      }

      await prisma.offeringElement.update({
        where: { id: m.element.id },
        data: { motivatingFactor: p.motivatingFactor },
      });
      console.log(`  ✓ "${m.element.text}" ← MF: "${p.motivatingFactor.substring(0, 60)}..."`);
      migrated++;
    }
  }

  console.log(`\nDone. Migrated: ${migrated}, Skipped: ${skipped}`);
  console.log('\nNote: Priority.motivatingFactor fields are preserved for now (not deleted).');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
