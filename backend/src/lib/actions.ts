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
  'go_to': 'navigate',
  'show_page': 'navigate',
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
    // Try exact match first (case insensitive) — check for duplicates
    const exactMatches = await prisma.audience.findMany({
      where: { ...scopeFilter, name: { equals: params.audienceName, mode: 'insensitive' as const } },
      take: 2,
    });
    if (exactMatches.length > 1) {
      console.warn(`[resolveAudienceId] Multiple audiences named "${params.audienceName}" — using first match`);
    }
    if (exactMatches.length > 0) return exactMatches[0].id;

    // Fall back to contains match, shortest name first (most specific)
    const fuzzy = await prisma.audience.findFirst({
      where: { ...scopeFilter, name: { contains: params.audienceName, mode: 'insensitive' as const } },
      orderBy: { name: 'asc' },
    });
    return fuzzy?.id || null;
  }
  return fallbackAudienceId || null;
}

// ─── Offering resolver ────────────────────────────────────────
export async function resolveOfferingId(
  params: Record<string, any>,
  userId: string,
  fallbackOfferingId?: string | null,
  workspaceId?: string,
): Promise<string | null> {
  const scopeFilter = workspaceId ? { workspaceId } : { userId };
  if (params.offeringName) {
    const exact = await prisma.offering.findFirst({
      where: { ...scopeFilter, name: { equals: params.offeringName, mode: 'insensitive' as const } },
    });
    if (exact) return exact.id;

    const fuzzy = await prisma.offering.findFirst({
      where: { ...scopeFilter, name: { contains: params.offeringName, mode: 'insensitive' as const } },
      orderBy: { name: 'asc' },
    });
    return fuzzy?.id || null;
  }
  return fallbackOfferingId || null;
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

      if (a.type === 'add_capabilities' && a.params.texts) {
        const targetOfferingId = await resolveOfferingId(a.params, userId, ctx.offeringId, workspaceId);
        if (!targetOfferingId) {
          actionResult = 'Could not add capabilities — no offering specified or found. Try including the offering name.';
        } else {
          const offering = await prisma.offering.findFirst({
            where: { id: targetOfferingId, ...(workspaceId ? { workspaceId } : { userId }) },
            include: { elements: true },
          });
          if (offering) {
            const maxSort = offering.elements.reduce((max: number, e: any) => Math.max(max, e.sortOrder), 0);
            for (let i = 0; i < a.params.texts.length; i++) {
              await prisma.offeringElement.create({
                data: {
                  offeringId: targetOfferingId,
                  text: a.params.texts[i],
                  sortOrder: maxSort + i + 1,
                },
              });
            }
            const targetLabel = targetOfferingId !== ctx.offeringId ? ` to "${offering.name}"` : '';
            actionResult = `Added ${a.params.texts.length} capabilit${a.params.texts.length === 1 ? 'y' : 'ies'}${targetLabel}`;
            refreshNeeded = true;
          }
        }
      }

      if (a.type === 'edit_capabilities' && a.params.edits) {
        const targetOfferingId = await resolveOfferingId(a.params, userId, ctx.offeringId, workspaceId);
        if (!targetOfferingId) {
          actionResult = 'Could not edit capabilities — no offering specified or found.';
        } else {
          const offering = await prisma.offering.findFirst({
            where: { id: targetOfferingId, ...(workspaceId ? { workspaceId } : { userId }) },
            include: { elements: { orderBy: { sortOrder: 'asc' } } },
          });
          if (offering) {
            let editCount = 0;
            for (const edit of a.params.edits) {
              const idx = edit.position - 1;
              if (idx >= 0 && idx < offering.elements.length) {
                const updateData: Record<string, any> = {};
                if (edit.text !== undefined) updateData.text = edit.text;
                if (edit.motivatingFactor !== undefined) updateData.motivatingFactor = edit.motivatingFactor;
                if (Object.keys(updateData).length > 0) {
                  await prisma.offeringElement.update({
                    where: { id: offering.elements[idx].id },
                    data: updateData,
                  });
                }
                editCount++;
              }
            }
            actionResult = `Updated ${editCount} capabilit${editCount === 1 ? 'y' : 'ies'}`;
            refreshNeeded = true;
          }
        }
      }

      if (a.type === 'delete_capabilities' && a.params.positions) {
        const targetOfferingId = await resolveOfferingId(a.params, userId, ctx.offeringId, workspaceId);
        if (!targetOfferingId) {
          actionResult = 'Could not delete capabilities — no offering specified or found.';
        } else {
          const offering = await prisma.offering.findFirst({
            where: { id: targetOfferingId, ...(workspaceId ? { workspaceId } : { userId }) },
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

      if (a.type === 'create_story' && a.params.medium && a.params.cta) {
        // Resolve draftId from context or by offering/audience name
        let storyDraftId = ctx.draftId;
        if (!storyDraftId && (a.params.offeringName || a.params.audienceName)) {
          const draftWhere: any = {
            offering: { ...(workspaceId ? { workspaceId } : { userId }) },
            archived: false,
          };
          if (a.params.offeringName) {
            draftWhere.offering.name = { contains: a.params.offeringName, mode: 'insensitive' };
          }
          if (a.params.audienceName) {
            draftWhere.audience = { name: { contains: a.params.audienceName, mode: 'insensitive' } };
          }
          const found = await prisma.threeTierDraft.findFirst({ where: draftWhere, orderBy: { updatedAt: 'desc' } });
          if (found && found.currentStep >= 5) storyDraftId = found.id;
          else if (found) {
            actionResult = `Found a Three Tier but it's not complete yet (Step ${found.currentStep}). Finish the Three Tier first, then create a story from it.`;
          }
        }
        if (!storyDraftId && !actionResult) {
          actionResult = 'Could not create story — no Three Tier draft found. Navigate to the Three Tier first, or specify the offering and audience names.';
        } else if (storyDraftId) {
          const newStory = await prisma.fiveChapterStory.create({
            data: {
              draftId: storyDraftId,
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
${story.draft.tier2Statements.map((t2: any, i: number) => `Tier 2 #${i + 1}: "${t2.text}" (Priority: "${t2.priority?.text || 'unlinked'}", ${t2.priority?.motivatingFactor ? `Driver: "${t2.priority.motivatingFactor}"` : ''})
  Proof: ${t2.tier3Bullets.map((t3: any) => t3.text).join(', ')}`).join('\n')}

AUDIENCE PRIORITIES:
${story.draft.audience.priorities.map((p: any) => `[Rank ${p.rank}] "${p.text}" — ${p.motivatingFactor ? `Driver: "${p.motivatingFactor}"` : ''}${p.whatAudienceThinks ? ` — Audience thinks: "${p.whatAudienceThinks}"` : ''}`).join('\n')}

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
${story.draft.tier2Statements.map((t2: any, i: number) => `Tier 2 #${i + 1}: "${t2.text}" (Priority: "${t2.priority?.text || 'unlinked'}", ${t2.priority?.motivatingFactor ? `Driver: "${t2.priority.motivatingFactor}"` : ''})
  Proof: ${t2.tier3Bullets.map((t3: any) => t3.text).join(', ')}`).join('\n')}

AUDIENCE PRIORITIES:
${story.draft.audience.priorities.map((p: any) => `[Rank ${p.rank}] "${p.text}" — ${p.motivatingFactor ? `Driver: "${p.motivatingFactor}"` : ''}${p.whatAudienceThinks ? ` — Audience thinks: "${p.whatAudienceThinks}"` : ''}`).join('\n')}

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
                versionNum: ((await prisma.chapterVersion.aggregate({
                  where: { chapterContentId: chapter.id },
                  _max: { versionNum: true },
                }))._max?.versionNum ?? 0) + 1,
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
          include: { chapters: { orderBy: { chapterNum: 'asc' } } },
        });
        if (story && story.blendedText) {
          // Snapshot before edit so user can undo
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
              label: 'Before copy edit (via Maria)',
              versionNum: (maxSnapVer._max?.versionNum ?? 0) + 1,
            },
          });

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
        try {
          const editDraft = await prisma.threeTierDraft.findFirst({
            where: { id: ctx.draftId },
            include: {
              tier1Statement: true,
              tier2Statements: { orderBy: { sortOrder: 'asc' }, include: { tier3Bullets: { orderBy: { sortOrder: 'asc' } } } },
              audience: { include: { priorities: { orderBy: { sortOrder: 'asc' } } } },
              offering: { include: { elements: true } },
              mappings: true,
            },
          });
          if (editDraft) {
            const instruction = a.params.instruction.toLowerCase();
            const isStructural = /restructur|add.*column|remove.*column|delete.*column|\d+\s*column|fewer column|more column/i.test(instruction);

            if (isStructural && editDraft.mappings.length === 0) {
              actionResult = 'Cannot restructure without confirmed mappings. Complete the mapping step first (Step 4), then try again.';
              refreshNeeded = false;
            } else if (isStructural) {
              // Structural change: snapshot current state, then regenerate with direction
              await prisma.$transaction(async (tx: any) => {
                // Save snapshot
                const maxVer = await tx.tableVersion.aggregate({ where: { draftId: ctx.draftId }, _max: { versionNum: true } });
                await tx.tableVersion.create({
                  data: {
                    draftId: ctx.draftId!,
                    snapshot: {
                      tier1: editDraft.tier1Statement?.text || '',
                      tier2: editDraft.tier2Statements.map((t2: any) => ({
                        text: t2.text, priorityId: t2.priorityId, categoryLabel: t2.categoryLabel || '',
                        tier3: t2.tier3Bullets.map((t3: any) => t3.text),
                      })),
                    },
                    label: 'Before restructure (via Maria)',
                    versionNum: (maxVer._max?.versionNum ?? 0) + 1,
                  },
                });

                // Delete existing tiers
                await tx.tier2Statement.deleteMany({ where: { draftId: ctx.draftId } });
                await tx.tier1Statement.deleteMany({ where: { draftId: ctx.draftId } });
              });

              // Regenerate with direction as context
              const { callAIWithJSON: callAI2 } = await import('../services/ai.js');
              const { CONVERT_LINES_SYSTEM } = await import('../prompts/generation.js');

              const mappedPriorities = editDraft.mappings.reduce((acc: any, m: any) => {
                if (!acc[m.priorityId]) acc[m.priorityId] = [];
                acc[m.priorityId].push(m.elementId);
                return acc;
              }, {});

              const convertMsg = `CONFIRMED MAPPINGS:
${editDraft.audience.priorities.map((p: any) => {
  const elementIds = mappedPriorities[p.id] || [];
  const elements = editDraft.offering.elements.filter((e: any) => elementIds.includes(e.id));
  return `Priority [Rank ${p.rank}]: "${p.text}"
  Mapped capabilities: ${elements.map((e: any) => `"${e.text}"`).join(', ') || '(none)'}`;
}).join('\n')}

ORPHAN CAPABILITIES (not mapped to any priority):
${editDraft.offering.elements.filter((e: any) => !editDraft.mappings.some((m: any) => m.elementId === e.id)).map((e: any) => `"${e.text}"`).join(', ') || '(none)'}

ADDITIONAL DIRECTION FROM USER: ${a.params.instruction}`;

              const rank1 = editDraft.audience.priorities.find((p: any) => p.rank === 1);
              const reminder = rank1 ? `\n\n══ CRITICAL ══\nYour Tier 1 MUST begin with the Rank 1 priority text: "${rank1.text}"` : '';

              const result = await callAI2<{
                tier1: { text: string; priorityId: string };
                tier2: { text: string; priorityId: string; categoryLabel: string; tier3: string[] }[];
              }>(CONVERT_LINES_SYSTEM, convertMsg + reminder, 'elite');

              // Apply new tiers (with version entries so version nav works)
              const newT1 = await prisma.tier1Statement.create({ data: { draftId: ctx.draftId!, text: result.tier1.text } });
              await prisma.cellVersion.create({
                data: { tier1Id: newT1.id, text: result.tier1.text, versionNum: 1, changeSource: 'ai_generate' },
              });
              for (let i = 0; i < result.tier2.length; i++) {
                const t2 = await prisma.tier2Statement.create({
                  data: {
                    draftId: ctx.draftId!,
                    text: result.tier2[i].text,
                    sortOrder: i,
                    priorityId: result.tier2[i].priorityId || null,
                    categoryLabel: result.tier2[i].categoryLabel || '',
                  },
                });
                await prisma.cellVersion.create({
                  data: { tier2Id: t2.id, text: result.tier2[i].text, versionNum: 1, changeSource: 'ai_generate' },
                });
                for (let j = 0; j < (result.tier2[i].tier3 || []).length; j++) {
                  const t3 = await prisma.tier3Bullet.create({
                    data: { tier2Id: t2.id, text: result.tier2[i].tier3[j], sortOrder: j },
                  });
                  await prisma.cellVersion.create({
                    data: { tier3Id: t3.id, text: result.tier2[i].tier3[j], versionNum: 1, changeSource: 'ai_generate' },
                  });
                }
              }

              actionResult = `Restructured Three Tier — ${result.tier2.length} columns generated. A checkpoint was saved automatically.`;
              refreshNeeded = true;

            } else {
              // Text-only change: use direction system
              const { callAIWithJSON } = await import('../services/ai.js');
              const { DIRECTION_SYSTEM } = await import('../prompts/generation.js');

              const dirMessage = `USER'S DIRECTION: ${a.params.instruction}

CURRENT THREE TIER TABLE:
Tier 1: "${editDraft.tier1Statement?.text || '(empty)'}"

Tier 2 statements:
${editDraft.tier2Statements.map((t2: any, i: number) => `${i + 1}. [${t2.categoryLabel || 'unlabeled'}] "${t2.text}"
   Tier 3 bullets: ${t2.tier3Bullets.map((t3: any) => `"${t3.text}"`).join(', ') || '(none)'}`).join('\n')}

AUDIENCE PRIORITIES:
${editDraft.audience.priorities.map((p: any) => `[Rank ${p.rank}] "${p.text}"`).join('\n')}

OFFERING CAPABILITIES:
${editDraft.offering.elements.map((e: any) => `"${e.text}"`).join('\n')}`;

              const dirResult = await callAIWithJSON<{ suggestions: { cell: string; suggested: string }[] }>(DIRECTION_SYSTEM, dirMessage, 'elite');

              // Helper to create version entry (skips if text unchanged)
              async function createVersion(cellId: string, cellType: 'tier1' | 'tier2' | 'tier3', text: string) {
                const where = cellType === 'tier1' ? { tier1Id: cellId } : cellType === 'tier2' ? { tier2Id: cellId } : { tier3Id: cellId };
                const latest = await prisma.cellVersion.findFirst({ where, orderBy: { versionNum: 'desc' }, select: { text: true, versionNum: true } });
                if (latest && latest.text === text) return;
                await prisma.cellVersion.create({
                  data: { ...where, text, versionNum: (latest?.versionNum ?? 0) + 1, changeSource: 'direction' },
                });
              }

              let applied = 0;
              for (const s of dirResult.suggestions || []) {
                if (s.cell === 'tier1' && editDraft.tier1Statement) {
                  await prisma.tier1Statement.update({ where: { id: editDraft.tier1Statement.id }, data: { text: s.suggested } });
                  await createVersion(editDraft.tier1Statement.id, 'tier1', s.suggested);
                  applied++;
                } else if (s.cell.startsWith('tier2-')) {
                  const idx = parseInt(s.cell.split('-')[1]);
                  if (editDraft.tier2Statements[idx]) {
                    await prisma.tier2Statement.update({ where: { id: editDraft.tier2Statements[idx].id }, data: { text: s.suggested } });
                    await createVersion(editDraft.tier2Statements[idx].id, 'tier2', s.suggested);
                    applied++;
                  }
                } else if (s.cell.match(/^tier3-\d+-add$/)) {
                  // Add new Tier 3 bullet
                  const t2Idx = parseInt(s.cell.split('-')[1]);
                  const t2 = editDraft.tier2Statements[t2Idx];
                  if (t2) {
                    const maxSort = t2.tier3Bullets.reduce((max: number, b: any) => Math.max(max, b.sortOrder), -1);
                    await prisma.tier3Bullet.create({
                      data: { tier2Id: t2.id, text: s.suggested, sortOrder: maxSort + 1 },
                    });
                    applied++;
                  }
                } else if (s.cell.startsWith('tier3-')) {
                  const parts = s.cell.split('-');
                  const t2Idx = parseInt(parts[1]);
                  const t3Idx = parseInt(parts[2]);
                  const t2 = editDraft.tier2Statements[t2Idx];
                  if (t2 && t2.tier3Bullets[t3Idx]) {
                    await prisma.tier3Bullet.update({ where: { id: t2.tier3Bullets[t3Idx].id }, data: { text: s.suggested } });
                    await createVersion(t2.tier3Bullets[t3Idx].id, 'tier3', s.suggested);
                    applied++;
                  }
                }
              }
              actionResult = applied > 0 ? `Updated ${applied} cell${applied !== 1 ? 's' : ''} based on your direction` : 'Direction processed but no changes were needed';
              refreshNeeded = true;
            }
          }
        } catch (err: any) {
          actionResult = `Could not apply direction: ${err.message || 'unknown error'}`;
        }
      }

      // ─── Navigate (whitelist valid app routes) ──────────
      if (a.type === 'navigate' && a.params.path) {
        const path = String(a.params.path);
        const validRoutes = /^\/(audiences|offerings|three-tiers?|five-chapters?|settings|workspaces)?(\/.+)?$/;
        if (path === '/' || validRoutes.test(path)) {
          actionResult = `[NAVIGATE:${path}]`;
        } else {
          actionResult = `Could not navigate — invalid path`;
        }
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
        if (missing.length > 0) {
          const friendlyActions: Record<string, string> = {
            refine_chapter: 'refine that chapter',
            blend_story: 'create the complete draft',
            copy_edit: 'copy-edit',
            update_story_params: 'update the story settings',
            regenerate_story: 'regenerate',
            edit_tier: 'edit the Three Tier',
            create_story: 'create a story',
            edit_offering: 'edit the offering',
            add_capabilities: 'add capabilities',
            edit_capabilities: 'edit capabilities',
            delete_capabilities: 'delete capabilities',
          };
          const friendly = friendlyActions[a.type] || 'do that';
          actionResult = `I can't ${friendly} from here. Try navigating to the specific item first.`;
        } else {
          actionResult = `I wasn't able to do that. Try telling me more about what you'd like.`;
        }
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

  // read_page and navigate are always available
  actions.push('- read_page: Request to see the content currently visible on the page. Use this when the user references specific items on the page ("the 2nd priority," "chapter 3," "that first column") and you need to see what they see. Params: {}');
  actions.push('- navigate: Take the user to a different page. Params: { path: string } — e.g. "/audiences", "/offerings", "/three-tier/{draftId}". Use when the user asks to see something on another page.');

  // Audience actions — always available (Maria can interview from any page)
  if (context.audienceId) {
    actions.push('- edit_audience: Update the current audience name or description. Params: { name?: string, description?: string }');
  }
  actions.push('- add_priorities: Add priorities to an audience. Params: { texts: string[], audienceName?: string } — audienceName targets a specific audience by name (partial match OK). Required if not on an audience page.');
  actions.push('- edit_priorities: Update priority text or motivatingFactor. Params: { edits: [{ position: number, text?: string, motivatingFactor?: string }], audienceName?: string } — position is 1-based.');
  actions.push('- delete_priorities: Remove priorities by position. Params: { positions: number[], audienceName?: string } — 1-based positions.');
  actions.push('- reorder_priorities: Reorder priorities. Params: { order: number[], audienceName?: string } — array of current positions in desired new order.');

  // Offering actions — always available (Maria can interview from any page)
  if (context.offeringId) {
    actions.push('- edit_offering: Update the current offering name or description. Params: { name?: string, description?: string }');
  }
  actions.push('- add_capabilities: Add capabilities to an offering. Params: { texts: string[], offeringName?: string } — offeringName targets a specific offering by name (partial match OK). Required if not on an offering page.');
  actions.push('- edit_capabilities: Update capabilities — rename text or set motivating factor. Params: { edits: [{ position: number, text?: string, motivatingFactor?: string }], offeringName?: string } — position is 1-based.');
  actions.push('- delete_capabilities: Remove capabilities by position. Params: { positions: number[], offeringName?: string } — 1-based positions.');

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
    actions.push('- create_story: Generate a new Five Chapter Story. Params: { medium: string, cta: string, emphasis?: string, offeringName?: string, audienceName?: string } — can resolve draft by offering/audience name if not on a draft page. Medium options: email, blog, social, landing_page, in_person, press_release, newsletter, report');
  }

  // When a story exists, allow creating a new version in a different medium
  if (context.storyId && context.draftId) {
    actions.push('- create_story: Generate a NEW Five Chapter Story in a different medium from the same Three Tier draft. Params: { medium: string, cta: string, emphasis?: string } — e.g. "that email is good, now give me a newsletter version"');
  }

  // Three Tier actions
  if (context.draftId) {
    actions.push('- edit_tier: Change the TEXT of existing Three Tier cells based on a direction. Params: { instruction: string } — Can rewrite text, shift emphasis, change wording. CANNOT add or remove Tier 2 columns — for structural changes (adding/removing columns), suggest the user uses Regenerate.');
  }

  // Cross-workspace copy — always included, dispatch handles errors if user has only 1 workspace
  actions.push('- copy_audience_to_workspace: Copy an audience and its priorities to another workspace. Params: { audienceName: string, targetWorkspaceName: string }');
  actions.push('- copy_offering_to_workspace: Copy an offering and its capabilities to another workspace. Params: { offeringName: string, targetWorkspaceName: string }');

  return `\nACTIONS YOU CAN TAKE (only if the user's request clearly calls for one):\n${actions.join('\n')}\n`;
}
