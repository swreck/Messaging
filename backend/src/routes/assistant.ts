import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { callAI, callAIWithJSON } from '../services/ai.js';
import { buildAssistantPrompt } from '../prompts/assistant.js';
import { COPY_EDIT_SYSTEM } from '../prompts/fiveChapter.js';
import { getMediumSpec } from '../prompts/mediums.js';

const router = Router();
router.use(requireAuth);

// POST /api/assistant/message
router.post('/message', async (req: Request, res: Response) => {
  const { message, context, history } = req.body;
  if (!message) {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  const userId = req.user!.userId;
  const ctx = context || {};

  // Use client-sent history for conversation context (scoped to current page)
  const conversationHistory = (history || []).map((m: any) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));

  // Build system prompt
  const systemPrompt = buildAssistantPrompt(ctx);

  // Call AI
  const result = await callAIWithJSON<{
    response: string;
    action: { type: string; params: Record<string, any> } | null;
  }>(systemPrompt, message, 'fast', conversationHistory);

  // Check if AI wants to read the page
  if (result.action?.type === 'read_page') {
    res.json({
      response: result.response,
      action: result.action,
      actionResult: null,
      refreshNeeded: false,
      needsPageContent: true,
    });
    return;
  }

  let actionResult: string | null = null;
  let refreshNeeded = false;

  // Dispatch action if present
  if (result.action) {
    try {
      const a = result.action;

      if (a.type === 'add_priorities' && ctx.audienceId && a.params.texts) {
        const audience = await prisma.audience.findFirst({
          where: { id: ctx.audienceId, userId },
          include: { priorities: true },
        });
        if (audience) {
          const maxSort = audience.priorities.reduce((max: number, p: any) => Math.max(max, p.sortOrder), 0);
          for (let i = 0; i < a.params.texts.length; i++) {
            await prisma.priority.create({
              data: {
                audienceId: ctx.audienceId,
                text: a.params.texts[i],
                rank: audience.priorities.length + i + 1,
                sortOrder: maxSort + i + 1,
              },
            });
          }
          actionResult = `Added ${a.params.texts.length} priorities`;
          refreshNeeded = true;
        }
      }

      if (a.type === 'update_story_params' && ctx.storyId) {
        const updateData: Record<string, string> = {};
        if (a.params.medium) updateData.medium = a.params.medium;
        if (a.params.cta) updateData.cta = a.params.cta;
        if (a.params.emphasis !== undefined) updateData.emphasis = a.params.emphasis;
        if (Object.keys(updateData).length > 0) {
          await prisma.fiveChapterStory.update({
            where: { id: ctx.storyId },
            data: updateData,
          });
          actionResult = 'Updated story parameters';
          refreshNeeded = true;
        }
      }

      if (a.type === 'regenerate_story' && ctx.storyId) {
        actionResult = 'Regeneration queued — use the Regenerate button to proceed';
        refreshNeeded = true;
      }

      if (a.type === 'copy_edit' && ctx.storyId && a.params.instruction) {
        const story = await prisma.fiveChapterStory.findFirst({
          where: { id: ctx.storyId },
        });
        if (story && story.blendedText) {
          const spec = getMediumSpec(story.medium);
          const userMessage = `CONTENT FORMAT: ${spec.label}\nUSER'S REQUEST: ${a.params.instruction}\n\nCURRENT CONTENT:\n${story.blendedText}\n\nApply the requested changes.`;
          const revised = await callAI(COPY_EDIT_SYSTEM, userMessage, 'fast');
          await prisma.fiveChapterStory.update({
            where: { id: ctx.storyId },
            data: { blendedText: revised },
          });
          actionResult = 'Applied copy edit';
          refreshNeeded = true;
        }
      }

      if (a.type === 'edit_tier' && ctx.draftId && a.params.instruction) {
        actionResult = 'Direction applied — check your Three Tier table';
        refreshNeeded = true;
      }
    } catch (err: any) {
      actionResult = `Action failed: ${err.message}`;
    }
  }

  res.json({
    response: result.response,
    action: result.action,
    actionResult,
    refreshNeeded,
    needsPageContent: false,
  });
});

// POST /api/assistant/page-content — fetch human-readable content for the current page
router.post('/page-content', async (req: Request, res: Response) => {
  const { context } = req.body;
  const userId = req.user!.userId;
  const ctx = context || {};
  const lines: string[] = [];

  try {
    // Audiences page or any page with an active audience
    if (ctx.audienceId) {
      const audience = await prisma.audience.findFirst({
        where: { id: ctx.audienceId, userId },
        include: { priorities: { orderBy: { sortOrder: 'asc' } } },
      });
      if (audience) {
        lines.push(`Audience: ${audience.name}`);
        if (audience.description) lines.push(`Description: ${audience.description}`);
        lines.push(`Priorities (${audience.priorities.length}):`);
        for (const p of audience.priorities) {
          lines.push(`  ${p.sortOrder + 1}. "${p.text}" (rank ${p.rank})${p.motivatingFactor ? ` — Why: "${p.motivatingFactor}"` : ''}`);
        }
      }
    }

    // Audiences listing page
    if (ctx.page === 'audiences' && !ctx.audienceId) {
      const audiences = await prisma.audience.findMany({
        where: { userId },
        include: { priorities: { orderBy: { sortOrder: 'asc' } } },
      });
      for (const a of audiences) {
        lines.push(`\nAudience: ${a.name}`);
        if (a.description) lines.push(`  Description: ${a.description}`);
        lines.push(`  Priorities (${a.priorities.length}):`);
        for (const p of a.priorities) {
          lines.push(`    ${p.sortOrder + 1}. "${p.text}" (rank ${p.rank})${p.motivatingFactor ? ` — Why: "${p.motivatingFactor}"` : ''}`);
        }
      }
    }

    // Offerings page
    if (ctx.page === 'offerings' && !ctx.offeringId) {
      const offerings = await prisma.offering.findMany({
        where: { userId },
        include: { elements: { orderBy: { sortOrder: 'asc' } } },
      });
      for (const o of offerings) {
        lines.push(`\nOffering: ${o.name}`);
        if (o.description) lines.push(`  Description: ${o.description}`);
        lines.push(`  Capabilities (${o.elements.length}):`);
        for (const e of o.elements) {
          lines.push(`    - "${e.text}"`);
        }
      }
    }

    // Active offering
    if (ctx.offeringId) {
      const offering = await prisma.offering.findFirst({
        where: { id: ctx.offeringId, userId },
        include: { elements: { orderBy: { sortOrder: 'asc' } } },
      });
      if (offering) {
        lines.push(`Offering: ${offering.name}`);
        if (offering.description) lines.push(`Description: ${offering.description}`);
        lines.push(`Capabilities (${offering.elements.length}):`);
        for (const e of offering.elements) {
          lines.push(`  - "${e.text}"`);
        }
      }
    }

    // Three Tier detail
    if (ctx.draftId) {
      const draft = await prisma.threeTierDraft.findFirst({
        where: { id: ctx.draftId, offering: { userId } },
        include: {
          tier1Statement: true,
          tier2Statements: { orderBy: { sortOrder: 'asc' }, include: { tier3Bullets: { orderBy: { sortOrder: 'asc' } } } },
          offering: true,
          audience: { include: { priorities: { orderBy: { sortOrder: 'asc' } } } },
        },
      });
      if (draft) {
        lines.push(`\nThree Tier Message: ${draft.offering.name} → ${draft.audience.name}`);
        lines.push(`Tier 1: "${draft.tier1Statement?.text || '(not set)'}"`);
        for (let i = 0; i < draft.tier2Statements.length; i++) {
          const t2 = draft.tier2Statements[i];
          lines.push(`Tier 2 column ${i + 1}${t2.categoryLabel ? ` [${t2.categoryLabel}]` : ''}: "${t2.text}"`);
          for (const t3 of t2.tier3Bullets) {
            lines.push(`  Proof: "${t3.text}"`);
          }
        }
        lines.push(`\nAudience priorities:`);
        for (const p of draft.audience.priorities) {
          lines.push(`  ${p.sortOrder + 1}. "${p.text}"${p.motivatingFactor ? ` — Why: "${p.motivatingFactor}"` : ''}`);
        }
      }
    }

    // Five Chapter Story detail
    if (ctx.storyId) {
      const story = await prisma.fiveChapterStory.findFirst({
        where: { id: ctx.storyId, draft: { offering: { userId } } },
        include: {
          chapters: { orderBy: { chapterNum: 'asc' } },
          draft: { include: { offering: true, audience: true } },
        },
      });
      if (story) {
        lines.push(`\nFive Chapter Story: ${story.draft.offering.name} → ${story.draft.audience.name}`);
        lines.push(`Format: ${story.medium}, CTA: "${story.cta}"${story.emphasis ? `, Emphasis: ${story.emphasis}` : ''}`);
        for (const ch of story.chapters) {
          lines.push(`\nChapter ${ch.chapterNum} — ${ch.title}:`);
          lines.push(ch.content);
        }
        if (story.blendedText) {
          lines.push(`\nBlended Story:`);
          lines.push(story.blendedText);
        }
      }
    }

    // Dashboard
    if (ctx.page === 'dashboard') {
      const [audiences, offerings, drafts] = await Promise.all([
        prisma.audience.findMany({ where: { userId }, include: { _count: { select: { priorities: true } } } }),
        prisma.offering.findMany({ where: { userId }, include: { _count: { select: { elements: true } } } }),
        prisma.threeTierDraft.findMany({
          where: { offering: { userId } },
          include: { offering: { select: { name: true } }, audience: { select: { name: true } } },
        }),
      ]);
      lines.push(`Dashboard summary:`);
      lines.push(`  ${audiences.length} audience(s): ${audiences.map(a => `${a.name} (${a._count.priorities} priorities)`).join(', ')}`);
      lines.push(`  ${offerings.length} offering(s): ${offerings.map(o => `${o.name} (${o._count.elements} capabilities)`).join(', ')}`);
      lines.push(`  ${drafts.length} Three Tier draft(s): ${drafts.map(d => `${d.offering.name} → ${d.audience.name} (step ${d.currentStep})`).join(', ')}`);
    }
  } catch (err: any) {
    lines.push(`Error reading page content: ${err.message}`);
  }

  res.json({ content: lines.join('\n') || 'No content available for this page.' });
});

// DELETE /api/assistant/history
router.delete('/history', async (req: Request, res: Response) => {
  await prisma.assistantMessage.deleteMany({
    where: { userId: req.user!.userId },
  });
  res.json({ success: true });
});

export default router;
