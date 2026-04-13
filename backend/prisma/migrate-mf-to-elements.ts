/**
 * HISTORICAL MIGRATION (already run April 2026). Kept for reference and compilation.
 *
 * Original purpose: back when MFs lived on priorities, copy them to the mapped offering
 * elements so the MF lived in its correct home (differentiator side). After this script ran,
 * Priority.motivatingFactor was later renamed to Priority.driver to reflect its true meaning.
 *
 * Do not re-run this — it is here to compile against the current schema.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Historical migration (already run). Copying priority drivers to mapped element MFs where empty...\n');

  // Find all priorities with drivers (formerly "motivating factors" when they lived here)
  const priorities = await prisma.priority.findMany({
    where: { driver: { not: '' } },
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
      console.log(`  Priority "${p.text}" has driver but no mappings — skipping`);
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
        data: { motivatingFactor: p.driver },
      });
      console.log(`  ✓ "${m.element.text}" ← MF: "${p.driver.substring(0, 60)}..."`);
      migrated++;
    }
  }

  console.log(`\nDone. Migrated: ${migrated}, Skipped: ${skipped}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
