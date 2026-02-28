import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { callAI, callAIWithJSON } from '../services/ai.js';
import { buildAssistantPrompt } from '../prompts/assistant.js';
import { DIRECTION_SYSTEM } from '../prompts/generation.js';
import { COPY_EDIT_SYSTEM } from '../prompts/fiveChapter.js';
import { getMediumSpec } from '../prompts/mediums.js';

const router = Router();
router.use(requireAuth);

// GET /api/assistant/history — last 50 messages
router.get('/history', async (req: Request, res: Response) => {
  const messages = await prisma.assistantMessage.findMany({
    where: { userId: req.user!.userId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  // Return in chronological order
  res.json({ messages: messages.reverse() });
});

// POST /api/assistant/message
router.post('/message', async (req: Request, res: Response) => {
  const { message, context } = req.body;
  if (!message) {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  const userId = req.user!.userId;
  const ctx = context || {};

  // Save user message
  await prisma.assistantMessage.create({
    data: { userId, role: 'user', content: message, context: ctx },
  });

  // Get recent history for context
  const history = await prisma.assistantMessage.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
  const conversationHistory = history.reverse().map(m => ({
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
          const maxSort = audience.priorities.reduce((max, p) => Math.max(max, p.sortOrder), 0);
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

  // Save assistant response
  await prisma.assistantMessage.create({
    data: {
      userId,
      role: 'assistant',
      content: result.response,
      context: ctx,
      action: result.action?.type || null,
    },
  });

  res.json({
    response: result.response,
    action: result.action,
    actionResult,
    refreshNeeded,
  });
});

// DELETE /api/assistant/history
router.delete('/history', async (req: Request, res: Response) => {
  await prisma.assistantMessage.deleteMany({
    where: { userId: req.user!.userId },
  });
  res.json({ success: true });
});

export default router;
