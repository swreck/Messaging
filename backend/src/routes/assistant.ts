import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { callAIWithJSON } from '../services/ai.js';
import { buildAssistantPrompt } from '../prompts/assistant.js';
import { ACTION_ALIASES, dispatchActions, readPageContent } from '../lib/actions.js';

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
    action?: { type: string; params: Record<string, any> } | null;
    actions?: { type: string; params: Record<string, any> }[];
  }>(systemPrompt, message, 'fast', conversationHistory);

  // Normalize: support both "action" (single) and "actions" (array) from AI
  let rawActions: { type: string; params: Record<string, any> }[] = [];
  if (result.actions && Array.isArray(result.actions) && result.actions.length > 0) {
    rawActions = result.actions;
  } else if (result.action && result.action.type) {
    rawActions = [result.action];
  }

  // Apply aliases for the read_page check
  const normalizedActions = rawActions.map(a => ({
    ...a,
    type: ACTION_ALIASES[a.type] || a.type,
  }));

  // Check if AI wants to read the page
  if (normalizedActions.length === 1 && normalizedActions[0].type === 'read_page') {
    res.json({
      response: result.response,
      action: normalizedActions[0],
      actionResult: null,
      refreshNeeded: false,
      needsPageContent: true,
    });
    return;
  }

  // Dispatch all actions
  const { results: actionResults, refreshNeeded } = await dispatchActions(rawActions, userId, ctx);

  // If any action failed, override Maria's optimistic response with the failure details.
  // Maria writes her response before the action executes, so she doesn't know it failed.
  const failedResults = actionResults.filter(r =>
    r.startsWith('Could not') || r.startsWith('Action failed') || r.includes('not recognized')
  );
  const finalResponse = failedResults.length > 0
    ? `I tried, but it didn't work: ${failedResults.join('. ')}`
    : result.response;

  res.json({
    response: finalResponse,
    action: normalizedActions[0] || null,
    actionResult: actionResults.length > 0 ? actionResults.join(' · ') : null,
    refreshNeeded,
    needsPageContent: false,
  });
});

// POST /api/assistant/page-content — fetch human-readable content for the current page
router.post('/page-content', async (req: Request, res: Response) => {
  const { context } = req.body;
  const userId = req.user!.userId;
  const ctx = context || {};

  const content = await readPageContent(userId, ctx);
  res.json({ content });
});

// DELETE /api/assistant/history
router.delete('/history', async (req: Request, res: Response) => {
  await prisma.assistantMessage.deleteMany({
    where: {
      userId: req.user!.userId,
      NOT: { context: { path: ['channel'], equals: 'partner' } },
    },
  });
  res.json({ success: true });
});

export default router;
