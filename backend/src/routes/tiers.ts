import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace } from '../middleware/workspace.js';
import { param } from '../lib/params.js';
import { getLearning, updateLearning } from '../lib/learning.js';

const router = Router();
router.use(requireAuth);
router.use(requireWorkspace);

async function verifyDraftOwnership(draftId: string, workspaceId: string) {
  return prisma.threeTierDraft.findFirst({
    where: { id: draftId, offering: { workspaceId } },
  });
}

async function createCellVersion(cellId: string, cellType: 'tier1' | 'tier2' | 'tier3', text: string, changeSource: string) {
  const where = cellType === 'tier1' ? { tier1Id: cellId } : cellType === 'tier2' ? { tier2Id: cellId } : { tier3Id: cellId };
  const maxVersion = await prisma.cellVersion.aggregate({
    where,
    _max: { versionNum: true },
  });
  const versionNum = (maxVersion._max?.versionNum ?? 0) + 1;

  return prisma.cellVersion.create({
    data: {
      ...where,
      text,
      versionNum,
      changeSource,
    },
  });
}

// ─── Tier 1 ─────────────────────────────────────────────

// PUT /api/tiers/:draftId/tier1
router.put('/:draftId/tier1', async (req: Request, res: Response) => {
  const draft = await verifyDraftOwnership(param(req.params.draftId), req.workspaceId!);
  if (!draft) { res.status(404).json({ error: 'Draft not found' }); return; }

  const { text, changeSource } = req.body;
  if (!text) { res.status(400).json({ error: 'Text is required' }); return; }

  const existing = await prisma.tier1Statement.findUnique({ where: { draftId: param(req.params.draftId) } });

  let tier1;
  if (existing) {
    tier1 = await prisma.tier1Statement.update({
      where: { draftId: param(req.params.draftId) },
      data: { text },
    });
  } else {
    tier1 = await prisma.tier1Statement.create({
      data: { draftId: param(req.params.draftId), text },
    });
  }

  await createCellVersion(tier1.id, 'tier1', text, changeSource || 'manual');
  res.json({ tier1 });
});

// ─── Tier 2 ─────────────────────────────────────────────

// POST /api/tiers/:draftId/tier2
router.post('/:draftId/tier2', async (req: Request, res: Response) => {
  const draft = await verifyDraftOwnership(param(req.params.draftId), req.workspaceId!);
  if (!draft) { res.status(404).json({ error: 'Draft not found' }); return; }

  const { text, priorityId, categoryLabel, changeSource } = req.body;
  if (!text) { res.status(400).json({ error: 'Text is required' }); return; }

  const maxOrder = await prisma.tier2Statement.aggregate({
    where: { draftId: param(req.params.draftId) },
    _max: { sortOrder: true },
  });

  const tier2 = await prisma.tier2Statement.create({
    data: {
      draftId: param(req.params.draftId),
      text,
      sortOrder: (maxOrder._max?.sortOrder ?? -1) + 1,
      priorityId: priorityId || null,
      categoryLabel: categoryLabel || '',
    },
    include: { tier3Bullets: true },
  });

  await createCellVersion(tier2.id, 'tier2', text, changeSource || 'manual');
  res.status(201).json({ tier2 });
});

// PUT /api/tiers/:draftId/tier2/:tier2Id
router.put('/:draftId/tier2/:tier2Id', async (req: Request, res: Response) => {
  const draft = await verifyDraftOwnership(param(req.params.draftId), req.workspaceId!);
  if (!draft) { res.status(404).json({ error: 'Draft not found' }); return; }

  const { text, categoryLabel, changeSource } = req.body;
  if (!text) { res.status(400).json({ error: 'Text is required' }); return; }

  const updateData: any = { text };
  if (categoryLabel !== undefined) updateData.categoryLabel = categoryLabel;

  const tier2 = await prisma.tier2Statement.update({
    where: { id: param(req.params.tier2Id) },
    data: updateData,
    include: { tier3Bullets: { orderBy: { sortOrder: 'asc' } } },
  });

  const source = changeSource || 'manual';
  await createCellVersion(tier2.id, 'tier2', text, source);

  // Track manual edits for Maria's learning
  if (source === 'manual') {
    const prevVersion = await prisma.cellVersion.findFirst({
      where: { tier2Id: tier2.id, changeSource: { not: 'manual' } },
      orderBy: { versionNum: 'desc' },
    });
    if (prevVersion) {
      const learning = await getLearning(req.user!.userId);
      const column = tier2.categoryLabel || 'unknown';
      const columnEdits = { ...learning.columnEdits };
      columnEdits[column] = (columnEdits[column] || 0) + 1;
      const corrections = [...learning.corrections, {
        aiText: prevVersion.text,
        userText: text,
        column,
        createdAt: new Date().toISOString(),
      }];
      await updateLearning(req.user!.userId, { columnEdits, corrections });
    }
  }

  res.json({ tier2 });
});

// DELETE /api/tiers/:draftId/tier2/:tier2Id
router.delete('/:draftId/tier2/:tier2Id', async (req: Request, res: Response) => {
  const draft = await verifyDraftOwnership(param(req.params.draftId), req.workspaceId!);
  if (!draft) { res.status(404).json({ error: 'Draft not found' }); return; }

  await prisma.tier2Statement.delete({ where: { id: param(req.params.tier2Id) } });
  res.json({ success: true });
});

// POST /api/tiers/:draftId/tier2/bulk — replace all tier2 statements (used by Refine Language, Convert Lines)
router.post('/:draftId/tier2/bulk', async (req: Request, res: Response) => {
  const draft = await verifyDraftOwnership(param(req.params.draftId), req.workspaceId!);
  if (!draft) { res.status(404).json({ error: 'Draft not found' }); return; }

  const { statements, changeSource } = req.body;
  if (!Array.isArray(statements)) { res.status(400).json({ error: 'statements array required' }); return; }

  // Delete existing tier2 and their tier3 bullets
  await prisma.tier2Statement.deleteMany({ where: { draftId: param(req.params.draftId) } });

  const created = await Promise.all(
    statements.map(async (s: any, index: number) => {
      const tier2 = await prisma.tier2Statement.create({
        data: {
          draftId: param(req.params.draftId),
          text: s.text,
          sortOrder: index,
          priorityId: s.priorityId || null,
          categoryLabel: s.categoryLabel || '',
        },
        include: { tier3Bullets: true },
      });
      await createCellVersion(tier2.id, 'tier2', s.text, changeSource || 'ai_generate');
      return tier2;
    })
  );

  res.status(201).json({ tier2Statements: created });
});

// ─── Tier 3 ─────────────────────────────────────────────

// POST /api/tiers/:draftId/tier2/:tier2Id/tier3
router.post('/:draftId/tier2/:tier2Id/tier3', async (req: Request, res: Response) => {
  const draft = await verifyDraftOwnership(param(req.params.draftId), req.workspaceId!);
  if (!draft) { res.status(404).json({ error: 'Draft not found' }); return; }

  const { text, changeSource } = req.body;
  if (!text) { res.status(400).json({ error: 'Text is required' }); return; }

  const maxOrder = await prisma.tier3Bullet.aggregate({
    where: { tier2Id: param(req.params.tier2Id) },
    _max: { sortOrder: true },
  });

  const tier3 = await prisma.tier3Bullet.create({
    data: {
      tier2Id: param(req.params.tier2Id),
      text,
      sortOrder: (maxOrder._max?.sortOrder ?? -1) + 1,
    },
  });

  await createCellVersion(tier3.id, 'tier3', text, changeSource || 'manual');
  res.status(201).json({ tier3 });
});

// PUT /api/tiers/:draftId/tier3/:tier3Id
router.put('/:draftId/tier3/:tier3Id', async (req: Request, res: Response) => {
  const draft = await verifyDraftOwnership(param(req.params.draftId), req.workspaceId!);
  if (!draft) { res.status(404).json({ error: 'Draft not found' }); return; }

  const { text, changeSource } = req.body;
  if (!text) { res.status(400).json({ error: 'Text is required' }); return; }

  const tier3 = await prisma.tier3Bullet.update({
    where: { id: param(req.params.tier3Id) },
    data: { text },
  });

  await createCellVersion(tier3.id, 'tier3', text, changeSource || 'manual');
  res.json({ tier3 });
});

// DELETE /api/tiers/:draftId/tier3/:tier3Id
router.delete('/:draftId/tier3/:tier3Id', async (req: Request, res: Response) => {
  const draft = await verifyDraftOwnership(param(req.params.draftId), req.workspaceId!);
  if (!draft) { res.status(404).json({ error: 'Draft not found' }); return; }

  await prisma.tier3Bullet.delete({ where: { id: param(req.params.tier3Id) } });
  res.json({ success: true });
});

// POST /api/tiers/:draftId/tier3/bulk — replace all tier3 bullets for a tier2
router.post('/:draftId/tier2/:tier2Id/tier3/bulk', async (req: Request, res: Response) => {
  const draft = await verifyDraftOwnership(param(req.params.draftId), req.workspaceId!);
  if (!draft) { res.status(404).json({ error: 'Draft not found' }); return; }

  const { bullets, changeSource } = req.body;
  if (!Array.isArray(bullets)) { res.status(400).json({ error: 'bullets array required' }); return; }

  await prisma.tier3Bullet.deleteMany({ where: { tier2Id: param(req.params.tier2Id) } });

  const created = await Promise.all(
    bullets.map(async (text: string, index: number) => {
      const tier3 = await prisma.tier3Bullet.create({
        data: { tier2Id: param(req.params.tier2Id), text, sortOrder: index },
      });
      await createCellVersion(tier3.id, 'tier3', text, changeSource || 'ai_generate');
      return tier3;
    })
  );

  res.status(201).json({ tier3Bullets: created });
});

// POST /api/tiers/:draftId/reset — wipe tier statements and mappings for regeneration
router.post('/:draftId/reset', async (req: Request, res: Response) => {
  const draft = await prisma.threeTierDraft.findFirst({
    where: { id: param(req.params.draftId), offering: { workspaceId: req.workspaceId } },
    include: {
      tier1Statement: true,
      tier2Statements: { orderBy: { sortOrder: 'asc' }, include: { tier3Bullets: { orderBy: { sortOrder: 'asc' } } } },
    },
  });
  if (!draft) { res.status(404).json({ error: 'Draft not found' }); return; }

  // Auto-snapshot before wiping
  if (draft.tier1Statement || draft.tier2Statements.length > 0) {
    const maxVer = await prisma.tableVersion.aggregate({
      where: { draftId: param(req.params.draftId) },
      _max: { versionNum: true },
    });
    await prisma.tableVersion.create({
      data: {
        draftId: param(req.params.draftId),
        snapshot: {
          tier1: draft.tier1Statement?.text || '',
          tier2: draft.tier2Statements.map(t2 => ({
            text: t2.text,
            categoryLabel: t2.categoryLabel,
            tier3: t2.tier3Bullets.map(t3 => t3.text),
          })),
        },
        label: 'Before regeneration',
        versionNum: (maxVer._max?.versionNum ?? 0) + 1,
      },
    });
  }

  // Wipe tier statements (tier3 cascades from tier2) and mappings
  await prisma.tier2Statement.deleteMany({ where: { draftId: param(req.params.draftId) } });
  await prisma.tier1Statement.deleteMany({ where: { draftId: param(req.params.draftId) } });
  await prisma.mapping.deleteMany({ where: { draftId: param(req.params.draftId) } });

  res.json({ success: true });
});

export default router;
