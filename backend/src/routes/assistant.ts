import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { callAI, callAIWithJSON } from '../services/ai.js';
import { buildAssistantPrompt } from '../prompts/assistant.js';
import { buildChapterPrompt, CHAPTER_CRITERIA, REFINE_CHAPTER_SYSTEM, JOIN_CHAPTERS_SYSTEM, BLEND_SYSTEM, COPY_EDIT_SYSTEM } from '../prompts/fiveChapter.js';
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
    action?: { type: string; params: Record<string, any> } | null;
    actions?: { type: string; params: Record<string, any> }[];
  }>(systemPrompt, message, 'fast', conversationHistory);

  // Normalize: support both "action" (single) and "actions" (array) from AI
  const ACTION_ALIASES: Record<string, string> = {
    'add_audience': 'create_audience',
    'new_audience': 'create_audience',
    'add_offering': 'create_offering',
    'new_offering': 'create_offering',
    'create_priorities': 'add_priorities',
    'new_priorities': 'add_priorities',
    'create_capabilities': 'add_capabilities',
    'new_capabilities': 'add_capabilities',
    'update_params': 'update_story_params',
    'change_params': 'update_story_params',
    'edit_story_params': 'update_story_params',
    'generate_story': 'create_story',
    'new_story': 'create_story',
  };

  let rawActions: { type: string; params: Record<string, any> }[] = [];
  if (result.actions && Array.isArray(result.actions) && result.actions.length > 0) {
    rawActions = result.actions;
  } else if (result.action && result.action.type) {
    rawActions = [result.action];
  }
  const actions = rawActions.map(a => ({
    ...a,
    type: ACTION_ALIASES[a.type] || a.type,
  }));

  // Check if AI wants to read the page
  if (actions.length === 1 && actions[0].type === 'read_page') {
    res.json({
      response: result.response,
      action: actions[0],
      actionResult: null,
      refreshNeeded: false,
      needsPageContent: true,
    });
    return;
  }

  const actionResults: string[] = [];
  let refreshNeeded = false;

  // Dispatch all actions in sequence
  for (const a of actions) {
    let actionResult: string | null = null;
    try {

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

      if (a.type === 'edit_priorities' && ctx.audienceId && a.params.edits) {
        const audience = await prisma.audience.findFirst({
          where: { id: ctx.audienceId, userId },
          include: { priorities: { orderBy: { sortOrder: 'asc' } } },
        });
        if (audience) {
          let editCount = 0;
          for (const edit of a.params.edits) {
            const idx = edit.position - 1;
            if (idx >= 0 && idx < audience.priorities.length) {
              const updateData: Record<string, any> = {};
              if (edit.text !== undefined) updateData.text = edit.text;
              if (edit.motivatingFactor !== undefined) updateData.motivatingFactor = edit.motivatingFactor;
              await prisma.priority.update({
                where: { id: audience.priorities[idx].id },
                data: updateData,
              });
              editCount++;
            }
          }
          actionResult = `Updated ${editCount} priorit${editCount === 1 ? 'y' : 'ies'}`;
          refreshNeeded = true;
        }
      }

      if (a.type === 'delete_priorities' && ctx.audienceId && a.params.positions) {
        const audience = await prisma.audience.findFirst({
          where: { id: ctx.audienceId, userId },
          include: { priorities: { orderBy: { sortOrder: 'asc' } } },
        });
        if (audience) {
          // Collect IDs to delete (positions are 1-based)
          const idsToDelete: string[] = [];
          for (const pos of a.params.positions) {
            const idx = pos - 1;
            if (idx >= 0 && idx < audience.priorities.length) {
              idsToDelete.push(audience.priorities[idx].id);
            }
          }
          if (idsToDelete.length > 0) {
            await prisma.priority.deleteMany({
              where: { id: { in: idsToDelete } },
            });
            // Re-normalize sortOrder and rank for remaining priorities
            const remaining = await prisma.priority.findMany({
              where: { audienceId: ctx.audienceId },
              orderBy: { sortOrder: 'asc' },
            });
            for (let i = 0; i < remaining.length; i++) {
              await prisma.priority.update({
                where: { id: remaining[i].id },
                data: { sortOrder: i, rank: i + 1 },
              });
            }
          }
          actionResult = `Deleted ${idsToDelete.length} priorit${idsToDelete.length === 1 ? 'y' : 'ies'}`;
          refreshNeeded = true;
        }
      }

      if (a.type === 'reorder_priorities' && ctx.audienceId && a.params.order) {
        const audience = await prisma.audience.findFirst({
          where: { id: ctx.audienceId, userId },
          include: { priorities: { orderBy: { sortOrder: 'asc' } } },
        });
        if (audience) {
          const order: number[] = a.params.order; // [4, 1, 3, 2] means current #4 becomes new #1
          // Validate: every position should be valid
          const valid = order.every((pos: number) => pos >= 1 && pos <= audience.priorities.length);
          if (valid && order.length === audience.priorities.length) {
            for (let newIdx = 0; newIdx < order.length; newIdx++) {
              const oldIdx = order[newIdx] - 1; // 1-based → 0-based
              await prisma.priority.update({
                where: { id: audience.priorities[oldIdx].id },
                data: { sortOrder: newIdx, rank: newIdx + 1 },
              });
            }
            actionResult = `Reordered ${order.length} priorities`;
            refreshNeeded = true;
          } else {
            actionResult = 'Could not reorder — positions don\'t match the number of priorities';
          }
        }
      }

      // ─── Audience CRUD ───────────────────────────────────
      if (a.type === 'edit_audience' && ctx.audienceId) {
        const updateData: Record<string, string> = {};
        if (a.params.name) updateData.name = a.params.name;
        if (a.params.description !== undefined) updateData.description = a.params.description;
        if (Object.keys(updateData).length > 0) {
          await prisma.audience.update({
            where: { id: ctx.audienceId },
            data: updateData,
          });
          actionResult = 'Updated audience';
          refreshNeeded = true;
        }
      }

      if (a.type === 'create_audience' && a.params.name) {
        const audience = await prisma.audience.create({
          data: {
            userId,
            name: a.params.name,
            description: a.params.description || '',
          },
        });
        // Optionally add priorities if provided
        if (a.params.priorities && Array.isArray(a.params.priorities)) {
          for (let i = 0; i < a.params.priorities.length; i++) {
            const pText = typeof a.params.priorities[i] === 'string'
              ? a.params.priorities[i]
              : a.params.priorities[i].text || a.params.priorities[i];
            await prisma.priority.create({
              data: {
                audienceId: audience.id,
                text: String(pText),
                rank: i + 1,
                sortOrder: i,
              },
            });
          }
          actionResult = `Created audience "${audience.name}" with ${a.params.priorities.length} priorities`;
        } else {
          actionResult = `Created audience "${audience.name}"`;
        }
        refreshNeeded = true;
      }

      // ─── Offering CRUD ──────────────────────────────────
      if (a.type === 'edit_offering' && ctx.offeringId) {
        const updateData: Record<string, string> = {};
        if (a.params.name) updateData.name = a.params.name;
        if (a.params.description !== undefined) updateData.description = a.params.description;
        if (Object.keys(updateData).length > 0) {
          await prisma.offering.update({
            where: { id: ctx.offeringId },
            data: updateData,
          });
          actionResult = 'Updated offering';
          refreshNeeded = true;
        }
      }

      if (a.type === 'create_offering' && a.params.name) {
        const offering = await prisma.offering.create({
          data: {
            userId,
            name: a.params.name,
            description: a.params.description || '',
          },
        });
        if (a.params.capabilities && Array.isArray(a.params.capabilities)) {
          for (let i = 0; i < a.params.capabilities.length; i++) {
            await prisma.offeringElement.create({
              data: {
                offeringId: offering.id,
                text: String(a.params.capabilities[i]),
                sortOrder: i,
              },
            });
          }
          actionResult = `Created offering "${offering.name}" with ${a.params.capabilities.length} capabilities`;
        } else {
          actionResult = `Created offering "${offering.name}"`;
        }
        refreshNeeded = true;
      }

      if (a.type === 'add_capabilities' && ctx.offeringId && a.params.texts) {
        const offering = await prisma.offering.findFirst({
          where: { id: ctx.offeringId, userId },
          include: { elements: true },
        });
        if (offering) {
          const maxSort = offering.elements.reduce((max: number, e: any) => Math.max(max, e.sortOrder), 0);
          for (let i = 0; i < a.params.texts.length; i++) {
            await prisma.offeringElement.create({
              data: {
                offeringId: ctx.offeringId,
                text: a.params.texts[i],
                sortOrder: maxSort + i + 1,
              },
            });
          }
          actionResult = `Added ${a.params.texts.length} capabilit${a.params.texts.length === 1 ? 'y' : 'ies'}`;
          refreshNeeded = true;
        }
      }

      if (a.type === 'edit_capabilities' && ctx.offeringId && a.params.edits) {
        const offering = await prisma.offering.findFirst({
          where: { id: ctx.offeringId, userId },
          include: { elements: { orderBy: { sortOrder: 'asc' } } },
        });
        if (offering) {
          let editCount = 0;
          for (const edit of a.params.edits) {
            const idx = edit.position - 1;
            if (idx >= 0 && idx < offering.elements.length) {
              await prisma.offeringElement.update({
                where: { id: offering.elements[idx].id },
                data: { text: edit.text },
              });
              editCount++;
            }
          }
          actionResult = `Updated ${editCount} capabilit${editCount === 1 ? 'y' : 'ies'}`;
          refreshNeeded = true;
        }
      }

      if (a.type === 'delete_capabilities' && ctx.offeringId && a.params.positions) {
        const offering = await prisma.offering.findFirst({
          where: { id: ctx.offeringId, userId },
          include: { elements: { orderBy: { sortOrder: 'asc' } } },
        });
        if (offering) {
          const idsToDelete: string[] = [];
          for (const pos of a.params.positions) {
            const idx = pos - 1;
            if (idx >= 0 && idx < offering.elements.length) {
              idsToDelete.push(offering.elements[idx].id);
            }
          }
          if (idsToDelete.length > 0) {
            await prisma.offeringElement.deleteMany({
              where: { id: { in: idsToDelete } },
            });
          }
          actionResult = `Deleted ${idsToDelete.length} capabilit${idsToDelete.length === 1 ? 'y' : 'ies'}`;
          refreshNeeded = true;
        }
      }

      // ─── Five Chapter Story: refine, blend, create ──────
      if (a.type === 'refine_chapter' && ctx.storyId && a.params.chapterNum && a.params.feedback) {
        const story = await prisma.fiveChapterStory.findFirst({
          where: { id: ctx.storyId, draft: { offering: { userId } } },
          include: { chapters: true },
        });
        if (story) {
          const chapter = story.chapters.find((c: any) => c.chapterNum === a.params.chapterNum);
          if (chapter) {
            const ch = CHAPTER_CRITERIA[a.params.chapterNum - 1];
            const userMsg = `CHAPTER ${a.params.chapterNum}: "${ch.name}"\nCURRENT CONTENT:\n${chapter.content}\n\nUSER FEEDBACK: ${a.params.feedback}\n\nPlease revise this chapter based on the feedback.`;
            const revised = await callAI(REFINE_CHAPTER_SYSTEM, userMsg, 'fast');
            await prisma.chapterContent.update({
              where: { id: chapter.id },
              data: { content: revised },
            });
            // Create version
            const maxVer = await prisma.chapterVersion.aggregate({
              where: { chapterContentId: chapter.id },
              _max: { versionNum: true },
            });
            await prisma.chapterVersion.create({
              data: {
                chapterContentId: chapter.id,
                title: chapter.title,
                content: revised,
                versionNum: (maxVer._max?.versionNum ?? 0) + 1,
                changeSource: 'ai_refine',
              },
            });
            actionResult = `Refined Chapter ${a.params.chapterNum}`;
            refreshNeeded = true;
          }
        }
      }

      if (a.type === 'blend_story' && ctx.storyId) {
        const story = await prisma.fiveChapterStory.findFirst({
          where: { id: ctx.storyId, draft: { offering: { userId } } },
          include: { chapters: { orderBy: { chapterNum: 'asc' } } },
        });
        if (story && story.chapters.length >= 5) {
          // Snapshot before blend
          const maxSnapVer = await prisma.storyVersion.aggregate({
            where: { storyId: ctx.storyId },
            _max: { versionNum: true },
          });
          await prisma.storyVersion.create({
            data: {
              storyId: ctx.storyId,
              snapshot: {
                medium: story.medium, cta: story.cta, emphasis: story.emphasis,
                stage: story.stage, joinedText: story.joinedText, blendedText: story.blendedText,
                chapters: story.chapters.map((c: any) => ({ chapterNum: c.chapterNum, title: c.title, content: c.content })),
              },
              label: 'Before blend (via Maria)',
              versionNum: (maxSnapVer._max?.versionNum ?? 0) + 1,
            },
          });

          const sourceText = story.joinedText || story.chapters.map((ch: any) => `${ch.title}\n${ch.content}`).join('\n\n');
          const spec = getMediumSpec(story.medium);
          const userMsg = `CONTENT FORMAT: ${spec.label} (${spec.wordRange[0]}-${spec.wordRange[1]} words)\nFORMAT RULES: ${spec.format}\nTONE: ${spec.tone}\n\n${sourceText}\n\nPolish this into a final, cohesive ${spec.label.toLowerCase()}.`;
          const blendedText = await callAI(BLEND_SYSTEM, userMsg, 'deep');

          await prisma.fiveChapterStory.update({
            where: { id: ctx.storyId },
            data: { blendedText, stage: 'blended', version: { increment: 1 } },
          });
          actionResult = 'Blended story into final narrative';
          refreshNeeded = true;
        } else {
          actionResult = 'Cannot blend — all 5 chapters must be generated first';
        }
      }

      if (a.type === 'create_story' && ctx.draftId && a.params.medium && a.params.cta) {
        // Create the story record
        const newStory = await prisma.fiveChapterStory.create({
          data: {
            draftId: ctx.draftId,
            medium: a.params.medium,
            cta: a.params.cta,
            emphasis: a.params.emphasis || '',
          },
        });

        // Generate all 5 chapters
        const story = await prisma.fiveChapterStory.findFirst({
          where: { id: newStory.id },
          include: {
            draft: {
              include: {
                tier1Statement: true,
                tier2Statements: { orderBy: { sortOrder: 'asc' }, include: { tier3Bullets: { orderBy: { sortOrder: 'asc' } }, priority: true } },
                offering: { include: { elements: true } },
                audience: { include: { priorities: { orderBy: { sortOrder: 'asc' } } } },
              },
            },
          },
        });

        if (story) {
          const spec = getMediumSpec(story.medium);
          const emphasisMatch = story.emphasis?.match(/^ch(\d)$/i);
          const emphasisChapter = emphasisMatch ? parseInt(emphasisMatch[1]) : undefined;

          for (let chNum = 1; chNum <= 5; chNum++) {
            const systemPrompt = buildChapterPrompt(chNum, story.medium, emphasisChapter);
            const ch = CHAPTER_CRITERIA[chNum - 1];
            const prevChapters = await prisma.chapterContent.findMany({
              where: { storyId: newStory.id, chapterNum: { lt: chNum } },
              orderBy: { chapterNum: 'asc' },
            });

            const userMsg = `OFFERING: ${story.draft.offering.name}
AUDIENCE: ${story.draft.audience.name}
CONTENT FORMAT: ${spec.label} (${spec.wordRange[0]}-${spec.wordRange[1]} words total)
CTA: ${story.cta}
${story.emphasis ? `EMPHASIS: ${story.emphasis}` : ''}

THREE TIER MESSAGE:
Tier 1: "${story.draft.tier1Statement?.text || ''}"
${story.draft.tier2Statements.map((t2: any, i: number) => `Tier 2 #${i + 1}: "${t2.text}" (Priority: "${t2.priority?.text || 'unlinked'}", Motivating factor: "${t2.priority?.motivatingFactor || ''}")
  Proof: ${t2.tier3Bullets.map((t3: any) => t3.text).join(', ')}`).join('\n')}

AUDIENCE PRIORITIES:
${story.draft.audience.priorities.map((p: any) => `[Rank ${p.rank}] "${p.text}" — Why important: "${p.motivatingFactor}" — Audience thinks: "${p.whatAudienceThinks}"`).join('\n')}

${prevChapters.map((c: any) => `CHAPTER ${c.chapterNum} (already written): ${c.content.substring(0, 200)}...`).join('\n')}

Write Chapter ${chNum}: "${ch.name}"`;

            const content = await callAI(systemPrompt, userMsg, 'deep');
            const chapter = await prisma.chapterContent.upsert({
              where: { storyId_chapterNum: { storyId: newStory.id, chapterNum: chNum } },
              update: { title: ch.name, content },
              create: { storyId: newStory.id, chapterNum: chNum, title: ch.name, content },
            });

            // Create version
            await prisma.chapterVersion.create({
              data: {
                chapterContentId: chapter.id,
                title: ch.name,
                content,
                versionNum: 1,
                changeSource: 'ai_generate',
              },
            });
          }

          // Auto-blend
          const fullStory = await prisma.fiveChapterStory.findFirst({
            where: { id: newStory.id },
            include: { chapters: { orderBy: { chapterNum: 'asc' } } },
          });
          if (fullStory) {
            const sourceText = fullStory.chapters.map((ch: any) => `${ch.title}\n${ch.content}`).join('\n\n');
            const blendMsg = `CONTENT FORMAT: ${spec.label} (${spec.wordRange[0]}-${spec.wordRange[1]} words)\nFORMAT RULES: ${spec.format}\nTONE: ${spec.tone}\n\n${sourceText}\n\nPolish this into a final, cohesive ${spec.label.toLowerCase()}.`;
            const blendedText = await callAI(BLEND_SYSTEM, blendMsg, 'deep');
            await prisma.fiveChapterStory.update({
              where: { id: newStory.id },
              data: { blendedText, stage: 'blended', version: { increment: 1 } },
            });
          }
        }

        actionResult = `Created ${getMediumSpec(a.params.medium).label} story — all chapters generated and blended`;
        refreshNeeded = true;
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
        const story = await prisma.fiveChapterStory.findFirst({
          where: { id: ctx.storyId, draft: { offering: { userId } } },
          include: {
            chapters: { orderBy: { chapterNum: 'asc' } },
            draft: {
              include: {
                tier1Statement: true,
                tier2Statements: { orderBy: { sortOrder: 'asc' }, include: { tier3Bullets: { orderBy: { sortOrder: 'asc' } }, priority: true } },
                offering: { include: { elements: true } },
                audience: { include: { priorities: { orderBy: { sortOrder: 'asc' } } } },
              },
            },
          },
        });
        if (story) {
          // Snapshot before regeneration
          const maxSnapVer = await prisma.storyVersion.aggregate({
            where: { storyId: ctx.storyId },
            _max: { versionNum: true },
          });
          await prisma.storyVersion.create({
            data: {
              storyId: ctx.storyId,
              snapshot: {
                medium: story.medium, cta: story.cta, emphasis: story.emphasis,
                stage: story.stage, joinedText: story.joinedText, blendedText: story.blendedText,
                chapters: story.chapters.map((c: any) => ({ chapterNum: c.chapterNum, title: c.title, content: c.content })),
              },
              label: 'Before regeneration (via Maria)',
              versionNum: (maxSnapVer._max?.versionNum ?? 0) + 1,
            },
          });

          const spec = getMediumSpec(story.medium);
          const emphasisMatch = story.emphasis?.match(/^ch(\d)$/i);
          const emphasisChapter = emphasisMatch ? parseInt(emphasisMatch[1]) : undefined;

          for (let chNum = 1; chNum <= 5; chNum++) {
            const systemPrompt = buildChapterPrompt(chNum, story.medium, emphasisChapter);
            const ch = CHAPTER_CRITERIA[chNum - 1];
            const prevChapters = await prisma.chapterContent.findMany({
              where: { storyId: ctx.storyId, chapterNum: { lt: chNum } },
              orderBy: { chapterNum: 'asc' },
            });

            const userMsg = `OFFERING: ${story.draft.offering.name}
AUDIENCE: ${story.draft.audience.name}
CONTENT FORMAT: ${spec.label} (${spec.wordRange[0]}-${spec.wordRange[1]} words total)
CTA: ${story.cta}
${story.emphasis ? `EMPHASIS: ${story.emphasis}` : ''}

THREE TIER MESSAGE:
Tier 1: "${story.draft.tier1Statement?.text || ''}"
${story.draft.tier2Statements.map((t2: any, i: number) => `Tier 2 #${i + 1}: "${t2.text}" (Priority: "${t2.priority?.text || 'unlinked'}", Motivating factor: "${t2.priority?.motivatingFactor || ''}")
  Proof: ${t2.tier3Bullets.map((t3: any) => t3.text).join(', ')}`).join('\n')}

AUDIENCE PRIORITIES:
${story.draft.audience.priorities.map((p: any) => `[Rank ${p.rank}] "${p.text}" — Why important: "${p.motivatingFactor}" — Audience thinks: "${p.whatAudienceThinks}"`).join('\n')}

${prevChapters.map((c: any) => `CHAPTER ${c.chapterNum} (already written): ${c.content.substring(0, 200)}...`).join('\n')}

Write Chapter ${chNum}: "${ch.name}"`;

            const content = await callAI(systemPrompt, userMsg, 'deep');
            const chapter = await prisma.chapterContent.upsert({
              where: { storyId_chapterNum: { storyId: ctx.storyId, chapterNum: chNum } },
              update: { title: ch.name, content },
              create: { storyId: ctx.storyId, chapterNum: chNum, title: ch.name, content },
            });

            await prisma.chapterVersion.create({
              data: {
                chapterContentId: chapter.id,
                title: ch.name,
                content,
                versionNum: (await prisma.chapterVersion.aggregate({
                  where: { chapterContentId: chapter.id },
                  _max: { versionNum: true },
                }))._max?.versionNum ?? 0 + 1,
                changeSource: 'ai_regenerate',
              },
            });
          }

          // Auto-blend after regeneration
          const fullStory = await prisma.fiveChapterStory.findFirst({
            where: { id: ctx.storyId },
            include: { chapters: { orderBy: { chapterNum: 'asc' } } },
          });
          if (fullStory) {
            const sourceText = fullStory.chapters.map((ch: any) => `${ch.title}\n${ch.content}`).join('\n\n');
            const blendMsg = `CONTENT FORMAT: ${spec.label} (${spec.wordRange[0]}-${spec.wordRange[1]} words)\nFORMAT RULES: ${spec.format}\nTONE: ${spec.tone}\n\n${sourceText}\n\nPolish this into a final, cohesive ${spec.label.toLowerCase()}.`;
            const blendedText = await callAI(BLEND_SYSTEM, blendMsg, 'deep');
            await prisma.fiveChapterStory.update({
              where: { id: ctx.storyId },
              data: { blendedText, stage: 'blended', version: { increment: 1 } },
            });
          }

          actionResult = 'Regenerated all chapters and blended';
          refreshNeeded = true;
        }
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

      // Catch silent failures: action dispatched but no handler ran
      if (!actionResult) {
        const missing: string[] = [];
        if (['edit_priorities', 'delete_priorities', 'reorder_priorities', 'add_priorities', 'edit_audience'].includes(a.type) && !ctx.audienceId) {
          missing.push('audienceId');
        }
        if (['edit_offering', 'add_capabilities', 'edit_capabilities', 'delete_capabilities'].includes(a.type) && !ctx.offeringId) {
          missing.push('offeringId');
        }
        if (['refine_chapter', 'blend_story', 'copy_edit', 'update_story_params', 'regenerate_story'].includes(a.type) && !ctx.storyId) {
          missing.push('storyId');
        }
        if (['create_story', 'edit_tier'].includes(a.type) && !ctx.draftId) {
          missing.push('draftId');
        }
        actionResult = missing.length > 0
          ? `Could not execute ${a.type} — missing context: ${missing.join(', ')}. Try navigating to the specific item first.`
          : `Action ${a.type} was not recognized or could not execute.`;
      }
    } catch (err: any) {
      actionResult = `Action failed: ${err.message}`;
    }
    if (actionResult) actionResults.push(actionResult);
  }

  res.json({
    response: result.response,
    action: actions[0] || null,
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
