import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const codes = await p.inviteCode.findMany({ where: { usedById: null }, take: 5 })
console.log(JSON.stringify(codes, null, 2))
await p.$disconnect()
