import { PrismaClient } from '@prisma/client'

async function main() {
  const p = new PrismaClient()

  // Find Dana's user
  const dana = await p.user.findUnique({ where: { username: 'dana' } })
  if (!dana) { console.log('Dana not found'); return }

  // Find Dana's workspace
  const member = await p.workspaceMember.findFirst({ where: { userId: dana.id } })
  const workspace = member ? await p.workspace.findUnique({ where: { id: member.workspaceId } }) : null
  if (!workspace) { console.log('Workspace not found'); return }

  // Create offering
  const offering = await p.offering.create({
    data: {
      name: 'RouteIQ',
      description: 'AI-powered call routing for tech sales teams. Routes inbound leads to the right rep based on deal history, industry match, and availability. Predicts which pipeline deals are going cold and alerts reps.',
      smeRole: 'VP Sales',
      userId: dana.id,
      workspaceId: workspace.id,
      elements: {
        create: [
          { text: 'AI routes inbound leads to the rep most likely to close based on deal history and industry match', sortOrder: 1 },
          { text: 'Predicts which pipeline deals are going cold and alerts reps before they lose them', sortOrder: 2 },
          { text: 'Real-time availability matching so hot leads never wait in a queue', sortOrder: 3 },
          { text: 'Integrates with Salesforce and HubSpot without IT involvement', sortOrder: 4 },
        ]
      }
    }
  })
  console.log('Created offering:', offering.id)

  // Create Sales Ops Manager audience with priorities
  const salesOps = await p.audience.create({
    data: {
      name: 'Sales Ops Manager - Mid-Market SaaS',
      description: 'Responsible for sales process optimization, CRM administration, and rep productivity at mid-market SaaS companies',
      userId: dana.id,
      workspaceId: workspace.id,
      priorities: {
        create: [
          { text: 'Improving lead response time to increase conversion rates', rank: 1, motivatingFactor: 'Every minute a hot lead waits drops conversion by 10%. The CEO sees this number weekly.' },
          { text: 'Reducing time reps spend on administrative routing and assignment tasks', rank: 2 },
          { text: 'Getting accurate pipeline forecasts to report to leadership', rank: 3 },
          { text: 'Ensuring fair lead distribution that reps trust', rank: 4 },
          { text: 'Integrating new tools without burdening the IT team', rank: 5 },
          { text: 'Identifying at-risk deals before they go dark', rank: 6 },
        ]
      }
    }
  })
  console.log('Created Sales Ops audience:', salesOps.id)

  // Create CRO audience with priorities
  const cro = await p.audience.create({
    data: {
      name: 'CRO - Enterprise Software',
      description: 'Chief Revenue Officer at enterprise software companies responsible for overall revenue growth and sales team performance',
      userId: dana.id,
      workspaceId: workspace.id,
      priorities: {
        create: [
          { text: 'Increasing win rates on enterprise deals', rank: 1, motivatingFactor: 'Board measures the CRO on bookings growth. Win rate is the only lever that scales without adding headcount.' },
          { text: 'Reducing sales cycle length', rank: 2 },
          { text: 'Improving forecast accuracy for board reporting', rank: 3 },
          { text: 'Scaling the sales team without proportionally scaling costs', rank: 4 },
          { text: 'Retaining top-performing reps', rank: 5 },
          { text: 'Getting visibility into which reps need coaching and on what', rank: 6 },
        ]
      }
    }
  })
  console.log('Created CRO audience:', cro.id)

  await p.$disconnect()
}

main()
