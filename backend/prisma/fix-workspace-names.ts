import { PrismaClient } from '@prisma/client'

async function main() {
  const p = new PrismaClient()

  const workspaces = await p.workspace.findMany()

  for (const ws of workspaces) {
    // Capitalize first letter of workspace names that follow the "username's Workspace" pattern
    if (ws.name.match(/^[a-z].*'s Workspace$/)) {
      const fixed = ws.name.charAt(0).toUpperCase() + ws.name.slice(1)
      await p.workspace.update({ where: { id: ws.id }, data: { name: fixed } })
      console.log(`Fixed: "${ws.name}" → "${fixed}"`)
    } else {
      console.log(`OK: "${ws.name}"`)
    }
  }

  await p.$disconnect()
}

main()
