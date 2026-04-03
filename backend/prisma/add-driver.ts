import { PrismaClient } from '@prisma/client'

async function main() {
  const p = new PrismaClient()
  const prios = await p.priority.findMany({
    where: { audienceId: 'cmnj2rga3000j86z0thi5x6hr' },
    orderBy: { rank: 'asc' }
  })

  console.log('Current priorities:')
  for (const pr of prios) {
    console.log(`  rank ${pr.rank}: ${pr.text?.substring(0, 50)} | driver: ${pr.driver || 'NONE'}`)
  }

  // Add driver to rank 1 priority
  const top = prios.find(pr => pr.rank === 1)
  if (top && !top.driver) {
    await p.priority.update({
      where: { id: top.id },
      data: { motivatingFactor: 'Every unplanned vacancy costs overtime, hurts morale, and makes the next person more likely to leave — turnover compounds.' }
    })
    console.log('\nAdded driver to top priority:', top.id)
  }

  await p.$disconnect()
}

main()
