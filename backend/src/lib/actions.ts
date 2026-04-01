import { prisma } from './prisma.js';
import { callAI } from '../services/ai.js';
import {
  buildChapterPrompt,
  CHAPTER_CRITERIA,
  REFINE_CHAPTER_SYSTEM,
  BLEND_SYSTEM,
  COPY_EDIT_SYSTEM,
} from '../prompts/fiveChapter.js';
import { getMediumSpec } from '../prompts/mediums.js';

// ─── Alias map for AI-generated action names ──────────────────
export const ACTION_ALIASES: Record<string, string> = {
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
  'start_draft': 'start_three_tier',
  'create_draft': 'start_three_tier',
  'new_draft': 'start_three_tier',
  'begin_three_tier': 'start_three_tier',
};

// ─── Audience resolver ─────────────────────────────────────────
export async function resolveAudienceId(
  params: Record<string, any>,
  userId: string,
  fallbackAudienceId?: string | null,
  workspaceId?: string,
): Promise<string | null> {
  // Use workspaceId for scoping if available, fall back to userId
  const scopeFilter = workspaceId ? { workspaceId } : { userId };
  if (params.audienceName) {
    // Try exact match first (case insensitive)
    const exact = await prisma.audience.findFirst({
      where: { ...scopeFilter, name: { equals: params.audienceName, mode: 'insensitive' as const } },
    });
    if (exact) return exact.id;

    // Fall back to contains match, shortest name first (most specific)
    const fuzzy = await prisma.audience.findFirst({
      where: { ...scopeFilter, name: { contains: params.audienceName, mode: 'insensitive' as const } },
      orderBy: { name: 'asc' },
    });
    return fuzzy?.id || null;
  }
  return fallbackAudienceId || null;
}

// ─── Context type used by dispatch and page-content ────────────
export interface ActionContext {
  page?: string;
  storyId?: string;
  draftId?: string;
  audienceId?: string;
  offeringId?: string;
}

// ─── Action dispatch chain ─────────────────────────────────────
export async function dispatchActions(
  rawActions: { type: string; params: Record<string, any> }[],
  userId: string,
  ctx: ActionContext,
  workspaceId?: string,
): Promise<{ results: string[]; refreshNeeded: boolean }> {
  // Normalize aliases
  const actions = rawActions.map(a => ({
    ...a,
    type: ACTION_ALIASES[a.type] || a.type,
  }));

  const results: string[] = [];
  let refreshNeeded = false;

  for (const a of actions) {
    let actionResult: string | null = null;
    try {

      if (a.type === 'add_priorities' && a.params.texts) {
        const targetAudienceId = await resolveAudienceId(a.params, userId, ctx.audienceId, workspaceId);
        if (!targetAudienceId) {
          actionResult = 'Could not add priorities — no audience specified or found. Try including the audience name.';
        } else {
          const audience = await prisma.audience.findFirst({
            where: { id: targetAudienceId, ...(workspaceId ? { workspaceId } : { userId }) },
            include: { priorities: true },
          });
          if (audience) {
            const maxSort = audience.priorities.reduce((max: number, p: any) => Math.max(max, p.sortOrder), 0);
            for (let i = 0; i < a.params.texts.length; i++) {
              await prisma.priority.create({
                data: {
                  audienceId: targetAudienceId,
                  text: a.params.texts[i],
                  rank: audience.priorities.length + i + 1,
                  sortOrder: maxSort + i + 1,
                },
              });
            }
            const targetLabel = targetAudienceId !== ctx.audienceId ? ` to "${audience.name}"` : '';
            actionResult = `Added ${a.params.texts.length} priorities${targetLabel}`;
            refreshNeeded = true;
          }
        }
      }

      if (a.type === 'edit_priorities' && a.params.edits) {
        const targetAudienceId = await resolveAudienceId(a.params, userId, ctx.audienceId, workspaceId);
        if (!targetAudienceId) {
          actionResult = 'Could not edit priorities — no audience specified or found. Try including the audience name.';
        } else {
          const audience = await prisma.audience.findFirst({
            where: { id: targetAudienceId, ...(workspaceId ? { workspaceId } : { userId }) },
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
            const targetLabel = targetAudienceId !== ctx.audienceId ? ` in "${audience.name}"` : '';
            actionResult = `Updated ${editCount} priorit${editCount === 1 ? 'y' : 'ies'}${targetLabel}`;
            refreshNeeded = true;
          }
        }
      }

      if (a.type === 'delete_priorities' && a.params.positions) {
        const targetAudienceId = await resolveAudienceId(a.params, userId, ctx.audienceId, workspaceId);
        if (!targetAudienceId) {
          actionResult = 'Could not delete priorities — no audience specified or found. Try including the audience name.';
        } else {
          const audience = await prisma.audience.findFirst({
            where: { id: targetAudienceId, ...(workspaceId ? { workspaceId } : { userId }) },
            include: { priorities: { orderBy: { sortOrder: 'asc' } } },
          });
          if (audience) {
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
              const remaining = await prisma.priority.findMany({
                where: { audienceId: targetAudienceId },
                orderBy: { sortOrder: 'asc' },
              });
              for (let i = 0; i < remaining.length; i++) {
                await prisma.priority.update({
                  where: { id: remaining[i].id },
                  data: { sortOrder: i, rank: i + 1 },
                });
              }
            }
            const targetLabel = targetAudienceId !== ctx.audienceId ? ` from "${audience.name}"` : '';
            actionResult = `Deleted ${idsToDelete.length} priorit${idsToDelete.length === 1 ? 'y' : 'ies'}${targetLabel}`;
            refreshNeeded = true;
          }
        }
      }

      if (a.type === 'reorder_priorities' && a.params.order) {
        const targetAudienceId = await resolveAudienceId(a.params, userId, ctx.audienceId, workspaceId);
        if (!targetAudienceId) {
          actionResult = 'Could not reorder priorities — no audience specified or found. Try including the audience name.';
        } else {
          const audience = await prisma.audience.findFirst({
            where: { id: targetAudienceId, ...(workspaceId ? { workspaceId } : { userId }) },
            include: { priorities: { orderBy: { sortOrder: 'asc' } } },
          });
          if (audience) {
            const order: number[] = a.params.order;
            const valid = order.every((pos: number) => pos >= 1 && pos <= audience.priorities.length);
            if (valid) {
              const mentionedSet = new Set(order);
              const unmentioned = audience.priorities
                .map((_: any, i: number) => i + 1)
                .filter((pos: number) => !mentionedSet.has(pos));
              const fullOrder = [...order, ...unmentioned];

              for (let newIdx = 0; newIdx < fullOrder.length; newIdx++) {
                const oldIdx = fullOrder[newIdx] - 1;
                await prisma.priority.update({
                  where: { id: audience.priorities[oldIdx].id },
                  data: { sortOrder: newIdx, rank: newIdx + 1 },
                });
              }
              const targetLabel = targetAudienceId !== ctx.audienceId ? ` in "${audience.name}"` : '';
              actionResult = `Reordered priorities${targetLabel}`;
              refreshNeeded = true;
            } else {
              actionResult = 'Could not reorder — some positions are out of range';
            }
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
            ...(workspaceId ? { workspaceId } : {}),
          },
        });
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
            ...(workspaceId ? { workspaceId } : {}),
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
          where: { id: ctx.offeringId, ...(workspaceId ? { workspaceId } : { userId }) },
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
          where: { id: ctx.offeringId, ...(workspaceId ? { workspaceId } : { userId }) },
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
          where: { id: ctx.offeringId, ...(workspaceId ? { workspaceId } : { userId }) },
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
          where: { id: ctx.storyId, draft: { offering: workspaceId ? { workspaceId } : { userId } } },
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
          where: { id: ctx.storyId, draft: { offering: workspaceId ? { workspaceId } : { userId } } },
          include: { chapters: { orderBy: { chapterNum: 'asc' } } },
        });
        if (story && story.chapters.length >= 5) {
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
          const blendedText = await callAI(BLEND_SYSTEM, userMsg, 'elite');

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
        const newStory = await prisma.fiveChapterStory.create({
          data: {
            draftId: ctx.draftId,
            medium: a.params.medium,
            cta: a.params.cta,
            emphasis: a.params.emphasis || '',
          },
        });

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

            const content = await callAI(systemPrompt, userMsg, 'elite');
            const chapter = await prisma.chapterContent.upsert({
              where: { storyId_chapterNum: { storyId: newStory.id, chapterNum: chNum } },
              update: { title: ch.name, content },
              create: { storyId: newStory.id, chapterNum: chNum, title: ch.name, content },
            });

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
            const blendedText = await callAI(BLEND_SYSTEM, blendMsg, 'elite');
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
          where: { id: ctx.storyId, draft: { offering: workspaceId ? { workspaceId } : { userId } } },
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

            const content = await callAI(systemPrompt, userMsg, 'elite');
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
            const blendedText = await callAI(BLEND_SYSTEM, blendMsg, 'elite');
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

      // ─── Start Three Tier (create draft from offering + audience names) ─────
      if (a.type === 'start_three_tier' && a.params.offeringName && a.params.audienceName) {
        const scopeFilter = workspaceId ? { workspaceId } : { userId };
        const offering = await prisma.offering.findFirst({
          where: { ...scopeFilter, name: { contains: a.params.offeringName, mode: 'insensitive' as const } },
        });
        const audience = await prisma.audience.findFirst({
          where: { ...scopeFilter, name: { contains: a.params.audienceName, mode: 'insensitive' as const } },
        });
        if (!offering) {
          actionResult = `Could not find an offering called "${a.params.offeringName}"`;
        } else if (!audience) {
          actionResult = `Could not find an audience called "${a.params.audienceName}"`;
        } else {
          // Check for existing non-archived draft
          const existing = await prisma.threeTierDraft.findFirst({
            where: { offeringId: offering.id, audienceId: audience.id, archived: false },
          });
          if (existing) {
            actionResult = `[NAVIGATE:/three-tier/${existing.id}] A Three Tier for ${offering.name} → ${audience.name} already exists`;
          } else {
            const draft = await prisma.threeTierDraft.create({
              data: { offeringId: offering.id, audienceId: audience.id },
            });
            actionResult = `[NAVIGATE:/three-tier/${draft.id}] Started a Three Tier for ${offering.name} → ${audience.name}`;
          }
          refreshNeeded = true;
        }
      }

      // ─── Cross-workspace copy ─────────────────────────
      if (a.type === 'copy_audience_to_workspace' && a.params.audienceName && a.params.targetWorkspaceName) {
        // Find audience in current workspace
        const scopeFilter = workspaceId ? { workspaceId } : { userId };
        const audience = await prisma.audience.findFirst({
          where: { ...scopeFilter, name: { contains: a.params.audienceName, mode: 'insensitive' as const } },
          include: { priorities: { orderBy: { sortOrder: 'asc' } } },
        });
        if (!audience) {
          actionResult = `Could not find audience "${a.params.audienceName}" in this workspace`;
        } else {
          // Find target workspace by name (fuzzy)
          const userWorkspaces = await prisma.workspaceMember.findMany({
            where: { userId },
            include: { workspace: true },
          });
          const targetWs = userWorkspaces.find(m =>
            m.workspace.name.toLowerCase().includes(a.params.targetWorkspaceName.toLowerCase())
          );
          if (!targetWs) {
            actionResult = `Could not find a workspace named "${a.params.targetWorkspaceName}" that you have access to`;
          } else if (targetWs.workspaceId === workspaceId) {
            actionResult = `"${audience.name}" is already in that workspace`;
          } else {
            await prisma.audience.create({
              data: {
                userId,
                workspaceId: targetWs.workspaceId,
                name: audience.name,
                description: audience.description,
                priorities: {
                  create: audience.priorities.map(p => ({
                    text: p.text,
                    rank: p.rank,
                    isSpoken: p.isSpoken,
                    motivatingFactor: p.motivatingFactor,
                    whatAudienceThinks: p.whatAudienceThinks,
                    sortOrder: p.sortOrder,
                  })),
                },
              },
            });
            actionResult = `Copied "${audience.name}" audience (with ${audience.priorities.length} priorities) to "${targetWs.workspace.name}"`;
          }
        }
      }

      if (a.type === 'copy_offering_to_workspace' && a.params.offeringName && a.params.targetWorkspaceName) {
        const scopeFilter = workspaceId ? { workspaceId } : { userId };
        const offering = await prisma.offering.findFirst({
          where: { ...scopeFilter, name: { contains: a.params.offeringName, mode: 'insensitive' as const } },
          include: { elements: { orderBy: { sortOrder: 'asc' } } },
        });
        if (!offering) {
          actionResult = `Could not find offering "${a.params.offeringName}" in this workspace`;
        } else {
          const userWorkspaces = await prisma.workspaceMember.findMany({
            where: { userId },
            include: { workspace: true },
          });
          const targetWs = userWorkspaces.find(m =>
            m.workspace.name.toLowerCase().includes(a.params.targetWorkspaceName.toLowerCase())
          );
          if (!targetWs) {
            actionResult = `Could not find a workspace named "${a.params.targetWorkspaceName}" that you have access to`;
          } else if (targetWs.workspaceId === workspaceId) {
            actionResult = `"${offering.name}" is already in that workspace`;
          } else {
            await prisma.offering.create({
              data: {
                userId,
                workspaceId: targetWs.workspaceId,
                name: offering.name,
                smeRole: offering.smeRole,
                description: offering.description,
                elements: {
                  create: offering.elements.map(e => ({
                    text: e.text,
                    source: e.source,
                    sortOrder: e.sortOrder,
                  })),
                },
              },
            });
            actionResult = `Copied "${offering.name}" offering (with ${offering.elements.length} capabilities) to "${targetWs.workspace.name}"`;
          }
        }
      }

      // Catch silent failures: action dispatched but no handler ran
      if (!actionResult) {
        const missing: string[] = [];
        if (['edit_audience'].includes(a.type) && !ctx.audienceId) {
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
    if (actionResult) results.push(actionResult);
  }

  return { results, refreshNeeded };
}

// ─── Read page content ─────────────────────────────────────────
export async function readPageContent(
  workspaceIdOrUserId: string,
  ctx: ActionContext,
): Promise<string> {
  // This parameter now receives workspaceId for workspace-scoped queries
  const workspaceId = workspaceIdOrUserId;
  const lines: string[] = [];

  try {
    // Audiences page — always include ALL audiences so Maria can compare across them
    if (ctx.page === 'audiences') {
      const audiences = await prisma.audience.findMany({
        where: { workspaceId },
        include: { priorities: { orderBy: { sortOrder: 'asc' } } },
      });
      for (const a of audiences) {
        const isActive = a.id === ctx.audienceId;
        lines.push(`\nAudience: ${a.name}${isActive ? ' [SELECTED]' : ''}`);
        if (a.description) lines.push(`  Description: ${a.description}`);
        lines.push(`  Priorities (${a.priorities.length}):`);
        for (const p of a.priorities) {
          lines.push(`    ${p.sortOrder + 1}. "${p.text}" (rank ${p.rank})${p.motivatingFactor ? ` — Why: "${p.motivatingFactor}"` : ''}`);
        }
      }
    }

    // Active audience on non-audiences pages
    if (ctx.audienceId && ctx.page !== 'audiences') {
      const audience = await prisma.audience.findFirst({
        where: { id: ctx.audienceId, workspaceId },
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

    // Offerings page
    if (ctx.page === 'offerings' && !ctx.offeringId) {
      const offerings = await prisma.offering.findMany({
        where: { workspaceId },
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
        where: { id: ctx.offeringId, workspaceId },
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
        where: { id: ctx.draftId, offering: { workspaceId } },
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
        where: { id: ctx.storyId, draft: { offering: { workspaceId } } },
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
        prisma.audience.findMany({ where: { workspaceId }, include: { _count: { select: { priorities: true } } } }),
        prisma.offering.findMany({ where: { workspaceId }, include: { _count: { select: { elements: true } } } }),
        prisma.threeTierDraft.findMany({
          where: { offering: { workspaceId } },
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

  return lines.join('\n') || 'No content available for this page.';
}

// ─── Build action list for system prompt ───────────────────────
export function buildActionList(context: ActionContext): string {
  const actions: string[] = [];

  // read_page is always available
  actions.push('- read_page: Request to see the content currently visible on the page. Use this when the user references specific items on the page ("the 2nd priority," "chapter 3," "that first column") and you need to see what they see. Params: {}');

  // Audience actions
  if (context.audienceId) {
    actions.push('- edit_audience: Update the current audience name or description. Params: { name?: string, description?: string }');
  }

  // Priority actions — on audiences page, all can target ANY audience by name
  if (context.page === 'audiences') {
    actions.push('- add_priorities: Add new priorities to an audience. Params: { texts: string[], audienceName?: string } — audienceName targets a specific audience by name (partial match OK). If omitted, adds to the currently selected audience.');
    actions.push('- edit_priorities: Rename, rewrite, or update the text/motivatingFactor of existing priorities. Params: { edits: [{ position: number, text?: string, motivatingFactor?: string }], audienceName?: string } — position is 1-based. audienceName targets a specific audience by name. If omitted, edits the currently selected audience.');
    actions.push('- delete_priorities: Remove priorities by their position. Params: { positions: number[], audienceName?: string } — 1-based positions. audienceName targets a specific audience.');
    actions.push('- reorder_priorities: Set the full ranked order of priorities. Params: { order: number[], audienceName?: string } — array of current positions in the desired new order, e.g. [4, 1, 3, 2] means current #4 becomes #1. audienceName targets a specific audience.');
  } else if (context.audienceId) {
    actions.push('- add_priorities: Add new priorities to the current audience. Params: { texts: string[] }');
    actions.push('- edit_priorities: Rename, rewrite, or update the text/motivatingFactor of existing priorities. Params: { edits: [{ position: number, text?: string, motivatingFactor?: string }] } — position is 1-based');
    actions.push('- delete_priorities: Remove priorities by their position on the page. Params: { positions: number[] } — 1-based positions');
    actions.push('- reorder_priorities: Set the full ranked order of priorities. Params: { order: number[] } — array of current positions in the desired new order, e.g. [4, 1, 3, 2] means current #4 becomes #1');
  }

  // Offering actions
  if (context.offeringId) {
    actions.push('- edit_offering: Update the current offering name or description. Params: { name?: string, description?: string }');
    actions.push('- add_capabilities: Add new capabilities to the current offering. Params: { texts: string[] }');
    actions.push('- edit_capabilities: Rename/rewrite capabilities. Params: { edits: [{ position: number, text: string }] } — position is 1-based');
    actions.push('- delete_capabilities: Remove capabilities by position. Params: { positions: number[] } — 1-based positions');
  }

  // Create offering — available from any page (for quick-start and flexibility)
  actions.push('- create_offering: Create a new offering, optionally with initial capabilities. Params: { name: string, description?: string, capabilities?: string[] }');

  // Create audience — available from any page (for quick-start and flexibility)
  actions.push('- create_audience: Create a new audience, optionally with initial priorities. Params: { name: string, description?: string, priorities?: string[] } — priorities is an ordered array of priority texts, rank follows array order');

  // Start a Three Tier — available from any page (for quick-start)
  actions.push('- start_three_tier: Create a new Three Tier draft and navigate to coaching. Params: { offeringName: string, audienceName: string } — names are matched by partial, case-insensitive match');

  // Five Chapter Story actions
  if (context.storyId) {
    actions.push('- update_story_params: Change story parameters. Params: { medium?, cta?, emphasis? }');
    actions.push('- regenerate_story: Regenerate all chapters from scratch. Params: {}');
    actions.push('- refine_chapter: Give feedback on a specific chapter to improve it. Params: { chapterNum: number, feedback: string }');
    actions.push('- blend_story: Blend all chapters into a single polished narrative. Params: {}');
    actions.push('- copy_edit: Apply an edit to the blended story. Params: { instruction: string }');
  }

  // When on a draft but no story yet, allow creating one
  if (context.draftId && !context.storyId) {
    actions.push('- create_story: Generate a new Five Chapter Story from this Three Tier draft. Params: { medium: string, cta: string, emphasis?: string } — medium options: email, blog, social, landing_page, in_person, press_release, newsletter, report');
  }

  // When a story exists, allow creating a new version in a different medium
  if (context.storyId && context.draftId) {
    actions.push('- create_story: Generate a NEW Five Chapter Story in a different medium from the same Three Tier draft. Params: { medium: string, cta: string, emphasis?: string } — e.g. "that email is good, now give me a newsletter version"');
  }

  // Three Tier actions
  if (context.draftId) {
    actions.push('- edit_tier: Apply direction to the Three Tier table. Params: { instruction: string }');
  }

  // Cross-workspace copy — always included, dispatch handles errors if user has only 1 workspace
  actions.push('- copy_audience_to_workspace: Copy an audience and its priorities to another workspace. Params: { audienceName: string, targetWorkspaceName: string }');
  actions.push('- copy_offering_to_workspace: Copy an offering and its capabilities to another workspace. Params: { offeringName: string, targetWorkspaceName: string }');

  return `\nACTIONS YOU CAN TAKE (only if the user's request clearly calls for one):\n${actions.join('\n')}\n`;
}
