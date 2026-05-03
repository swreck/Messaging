import { prisma } from './prisma.js';
import { callAI } from '../services/ai.js';
import {
  commitExistingForPipeline,
  runPipeline,
  rebuildFoundationFromDraft,
} from './expressPipeline.js';
import {
  buildChapterPrompt,
  CHAPTER_CRITERIA,
  REFINE_CHAPTER_SYSTEM,
  BLEND_SYSTEM,
  COPY_EDIT_SYSTEM,
} from '../prompts/fiveChapter.js';
import { getMediumSpec } from '../prompts/mediums.js';
import {
  buildAutonomousPreBuildExpectation,
  mediumDisplayLabel,
  PITCH_DECK_HONEST_FALLBACK,
  PITCH_DECK_FALLBACK_CHIP_KEEP,
  PITCH_DECK_FALLBACK_CHIP_SWITCH,
  FORMAT_QUESTION,
  FORMAT_CHIPS,
} from '../prompts/milestoneCopy.js';
import {
  getPersonalize,
  updatePersonalize,
} from './personalize.js';
import { INTERVIEW_QUESTIONS } from '../prompts/personalize.js';
import {
  synthesizeInterviewProfile,
  analyzeDocument,
  mergeStyleSignals,
  generateComparativeQuestion,
} from '../services/personalizeService.js';

// ─── Cross-chapter repetition detection ───────────────────────
// After generating all 5 chapters, find phrases repeated across chapters.
// Returns phrases that appear in 2+ chapters (4-6 word sequences).
function findCrossChapterRepetition(chapters: { chapterNum: number; content: string }[]): { phrase: string; laterChapter: number }[] {
  const chapterPhrases = new Map<number, Set<string>>();
  for (const ch of chapters) {
    const words = ch.content.toLowerCase().replace(/[^a-z0-9\s']/g, '').split(/\s+/).filter(w => w.length > 0);
    const phrases = new Set<string>();
    for (let len = 4; len <= 6; len++) {
      for (let i = 0; i <= words.length - len; i++) {
        phrases.add(words.slice(i, i + len).join(' '));
      }
    }
    chapterPhrases.set(ch.chapterNum, phrases);
  }

  const repeated: { phrase: string; laterChapter: number }[] = [];
  const sortedNums = [...chapterPhrases.keys()].sort();
  for (let i = 1; i < sortedNums.length; i++) {
    const laterNum = sortedNums[i];
    const laterPhrases = chapterPhrases.get(laterNum)!;
    for (let j = 0; j < i; j++) {
      const earlierPhrases = chapterPhrases.get(sortedNums[j])!;
      for (const p of laterPhrases) {
        if (earlierPhrases.has(p)) {
          repeated.push({ phrase: p, laterChapter: laterNum });
        }
      }
    }
  }

  // Keep only the longest overlapping phrases per chapter
  const byChapter = new Map<number, string[]>();
  for (const r of repeated) {
    const existing = byChapter.get(r.laterChapter) || [];
    if (!existing.some(e => e.includes(r.phrase))) {
      // Remove shorter phrases subsumed by this one
      const filtered = existing.filter(e => !r.phrase.includes(e));
      filtered.push(r.phrase);
      byChapter.set(r.laterChapter, filtered);
    }
  }

  const result: { phrase: string; laterChapter: number }[] = [];
  for (const [ch, phrases] of byChapter) {
    for (const p of phrases) result.push({ phrase: p, laterChapter: ch });
  }
  return result;
}

// Format previous chapters as context (full text for short, truncated at sentence boundary for long)
function formatPrevChapterContext(chapters: { chapterNum: number; content: string }[]): string {
  return chapters.map((c) => {
    const text = c.content;
    const maxLen = 500;
    if (text.length <= maxLen) return `Ch ${c.chapterNum} (context — do not repeat these facts): ${text}`;
    const t = text.substring(0, maxLen);
    const e = Math.max(t.lastIndexOf('. '), t.lastIndexOf('? '), t.lastIndexOf('! '));
    return `Ch ${c.chapterNum} (context — do not repeat these facts): ${e > 100 ? t.substring(0, e + 1) : t.substring(0, t.lastIndexOf(' '))}`;
  }).join('\n');
}

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
  'analyze_style': 'analyze_personalization_doc',
  'style_doc': 'analyze_personalization_doc',
  'personalize_doc': 'analyze_personalization_doc',
  'make_deliverable': 'build_deliverable',
  'generate_deliverable': 'build_deliverable',
  'build_draft': 'build_deliverable',
  'make_draft': 'build_deliverable',
  'build_story': 'build_deliverable',
  'check_build': 'check_deliverable',
  'check_status': 'check_deliverable',
  'build_status': 'check_deliverable',
  'start_style_interview': 'start_personalize_interview',
  'start_interview': 'start_personalize_interview',
  'interview_answer': 'personalize_interview_answer',
  'style_answer': 'personalize_interview_answer',
  'complete_interview': 'personalize_interview_synthesize',
  'finish_interview': 'personalize_interview_synthesize',
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
            // Conversational echo (same pattern as add_capabilities — Topic 13
            // in the cycle handoff). User verifies exactly what landed in chat
            // and can edit by ordinal or content without navigating away.
            const audienceLabel = `"${audience.name}"`;
            const lines = (a.params.texts as string[]).map(t => `— ${t}`).join('\n');
            const headline = a.params.texts.length === 1
              ? `Added this priority to ${audienceLabel}:`
              : `Added these ${a.params.texts.length} priorities to ${audienceLabel}:`;
            actionResult = `${headline}\n${lines}\nAnything off? I can edit any of them in place — just tell me which.`;
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
                if (edit.driver !== undefined) updateData.driver = edit.driver;
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
            // Conversational echo: list each item inline so the user can verify
            // exactly what landed without leaving chat. The user can edit any
            // item by ordinal ("the second one") or by content ("the one about
            // real-time"). Maria's confirmation voice is the consultant who
            // lists what she did, not a software form returning items for sign-off.
            const offeringLabel = `"${offering.name}"`;
            const lines = (a.params.texts as string[]).map(t => `— ${t}`).join('\n');
            const headline = a.params.texts.length === 1
              ? `Added this to ${offeringLabel}:`
              : `Added these ${a.params.texts.length} to ${offeringLabel}:`;
            actionResult = `${headline}\n${lines}\nAnything off? I can edit any of them in place — just tell me which.`;
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

      if (a.type === 'draft_mfs') {
        const targetOfferingId = await resolveOfferingId(a.params, userId, ctx.offeringId, workspaceId);
        if (!targetOfferingId) {
          actionResult = 'Could not draft motivating factors — no offering specified or found. Try mentioning the offering by name.';
        } else {
          const offering = await prisma.offering.findFirst({
            where: { id: targetOfferingId, ...(workspaceId ? { workspaceId } : { userId }) },
            include: { elements: { orderBy: { sortOrder: 'asc' } } },
          });
          if (offering) {
            const targets = offering.elements.filter(e => !e.motivatingFactor);
            if (targets.length === 0) {
              actionResult = `Every differentiator on "${offering.name}" already has a motivating factor — nothing to draft.`;
            } else {
              try {
                const { draftMfsForOffering } = await import('./draftMfs.js');
                const drafted = await draftMfsForOffering(offering, targets);
                for (const d of drafted) {
                  if (d.elementId && d.mf) {
                    await prisma.offeringElement.update({
                      where: { id: d.elementId },
                      data: { motivatingFactor: d.mf },
                    });
                  }
                }
                actionResult = `Drafted motivating factors for ${drafted.length} differentiator${drafted.length === 1 ? '' : 's'} on "${offering.name}". Each one names multiple audience types so the same offering can speak to different audiences.`;
                refreshNeeded = true;
              } catch (err: any) {
                actionResult = `I tried to draft them but ran into an error: ${err.message || 'unknown'}. You can also use the "Ask Maria to draft motivating factors" button on the offering page.`;
              }
            }
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
          include: { chapters: { orderBy: { chapterNum: 'asc' } } },
        });
        if (story) {
          const chapter = story.chapters.find((c: any) => c.chapterNum === a.params.chapterNum);
          if (chapter) {
            const ch = CHAPTER_CRITERIA[a.params.chapterNum - 1];
            const userMsg = `CHAPTER ${a.params.chapterNum}: "${ch.name}"\nCURRENT CONTENT:\n${chapter.content}\n\nUSER FEEDBACK: ${a.params.feedback}\n\nPlease revise this chapter based on the feedback.`;
            // Round C5 — pick the system prompt by the story's effective style.
            const effStyle = await (await import('./styleResolver.js')).resolveStyleForStory(ctx.storyId, userId);
            const refineSystem = (await import('../prompts/fiveChapter.js')).buildRefineChapterSystem(effStyle);
            const revised = await callAI(refineSystem, userMsg, 'elite');
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

            // Keep joinedText and blendedText in sync so the UI reflects the refinement.
            // Without this, the blended view shows stale chapter content while the chapter
            // record holds the new text — user sees nothing change.
            const updatedChapters = story.chapters.map((c: any) =>
              c.chapterNum === a.params.chapterNum ? { ...c, content: revised } : c
            );
            const storyPatch: any = {};
            if (story.joinedText) {
              storyPatch.joinedText = updatedChapters
                .map((c: any) => `${c.title}\n${c.content}`)
                .join('\n\n');
            }
            if (story.blendedText) {
              const spec = getMediumSpec(story.medium);
              const sourceText = updatedChapters.map((c: any) => `${c.title}\n${c.content}`).join('\n\n');
              const blendMsg = `CONTENT FORMAT: ${spec.label} (${spec.wordRange[0]}-${spec.wordRange[1]} words)\nFORMAT RULES: ${spec.format}\nTONE: ${spec.tone}\n\n${sourceText}\n\nPolish this into a final, cohesive ${spec.label.toLowerCase()}.`;
              storyPatch.blendedText = await callAI(BLEND_SYSTEM, blendMsg, 'elite');
            }
            if (Object.keys(storyPatch).length > 0) {
              await prisma.fiveChapterStory.update({
                where: { id: ctx.storyId },
                data: { ...storyPatch, version: { increment: 1 } },
              });
            }

            actionResult = `Refined Chapter ${a.params.chapterNum}${story.blendedText ? ' and re-blended' : ''}`;
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
${story.draft.tier2Statements.map((t2: any, i: number) => `Tier 2 #${i + 1}: "${t2.text}" (Priority: "${t2.priority?.text || 'unlinked'}", ${t2.priority?.driver ? `Driver: "${t2.priority.driver}"` : ''})
  Proof: ${t2.tier3Bullets.map((t3: any) => t3.text).join(', ')}`).join('\n')}

AUDIENCE PRIORITIES:
${story.draft.audience.priorities.map((p: any) => `[Rank ${p.rank}] "${p.text}" — ${p.driver ? `Driver: "${p.driver}"` : ''}${p.whatAudienceThinks ? ` — Audience thinks: "${p.whatAudienceThinks}"` : ''}`).join('\n')}

${prevChapters.length > 0 ? formatPrevChapterContext(prevChapters) : ''}

Write Chapter ${chNum}: "${ch.name}"
IMPORTANT: Start this chapter fresh. Do NOT begin with "..." or continue from a previous chapter.`;

            let content = await callAI(systemPrompt, userMsg, 'elite');
            content = content.replace(/^\s*\.{2,}\s*/g, '').trim();
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

          // Cross-chapter dedup check — regenerate chapters that repeat earlier phrases
          const allChapters = await prisma.chapterContent.findMany({
            where: { storyId: newStory.id },
            orderBy: { chapterNum: 'asc' },
          });
          const repetitions = findCrossChapterRepetition(allChapters);
          if (repetitions.length > 0) {
            const chaptersToFix = [...new Set(repetitions.map(r => r.laterChapter))];
            for (const chNum of chaptersToFix) {
              const avoidPhrases = repetitions.filter(r => r.laterChapter === chNum).map(r => r.phrase);
              const systemPrompt = buildChapterPrompt(chNum, story.medium, emphasisChapter);
              const ch = CHAPTER_CRITERIA[chNum - 1];
              const prevChapters = allChapters.filter(c => c.chapterNum < chNum);
              const avoidInstruction = `\n\nCRITICAL: These phrases already appear in earlier chapters. Do NOT use them — find different words to express the same ideas:\n${avoidPhrases.map(p => `- "${p}"`).join('\n')}`;

              const fixMsg = `OFFERING: ${story.draft.offering.name}
AUDIENCE: ${story.draft.audience.name}
CONTENT FORMAT: ${spec.label}
CTA: ${story.cta}

THREE TIER MESSAGE:
Tier 1: "${story.draft.tier1Statement?.text || ''}"
${story.draft.tier2Statements.map((t2: any, i: number) => `Tier 2 #${i + 1}: "${t2.text}"`).join('\n')}

${formatPrevChapterContext(prevChapters)}

Write Chapter ${chNum}: "${ch.name}"${avoidInstruction}`;

              let content = await callAI(systemPrompt, fixMsg, 'elite');
              content = content.replace(/^\s*\.{2,}\s*/g, '').trim();
              await prisma.chapterContent.update({
                where: { storyId_chapterNum: { storyId: newStory.id, chapterNum: chNum } },
                data: { content },
              });
            }
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
${story.draft.tier2Statements.map((t2: any, i: number) => `Tier 2 #${i + 1}: "${t2.text}" (Priority: "${t2.priority?.text || 'unlinked'}", ${t2.priority?.driver ? `Driver: "${t2.priority.driver}"` : ''})
  Proof: ${t2.tier3Bullets.map((t3: any) => t3.text).join(', ')}`).join('\n')}

AUDIENCE PRIORITIES:
${story.draft.audience.priorities.map((p: any) => `[Rank ${p.rank}] "${p.text}" — ${p.driver ? `Driver: "${p.driver}"` : ''}${p.whatAudienceThinks ? ` — Audience thinks: "${p.whatAudienceThinks}"` : ''}`).join('\n')}

${prevChapters.length > 0 ? formatPrevChapterContext(prevChapters) : ''}

Write Chapter ${chNum}: "${ch.name}"
IMPORTANT: Start this chapter fresh. Do NOT begin with "..." or continue from a previous chapter.`;

            let content = await callAI(systemPrompt, userMsg, 'elite');
            content = content.replace(/^\s*\.{2,}\s*/g, '').trim();
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

          // Cross-chapter dedup check
          const regenAllChapters = await prisma.chapterContent.findMany({
            where: { storyId: ctx.storyId },
            orderBy: { chapterNum: 'asc' },
          });
          const regenRepetitions = findCrossChapterRepetition(regenAllChapters);
          if (regenRepetitions.length > 0) {
            const chaptersToFix = [...new Set(regenRepetitions.map(r => r.laterChapter))];
            for (const chNum of chaptersToFix) {
              const avoidPhrases = regenRepetitions.filter(r => r.laterChapter === chNum).map(r => r.phrase);
              const systemPrompt = buildChapterPrompt(chNum, story.medium, emphasisChapter);
              const ch = CHAPTER_CRITERIA[chNum - 1];
              const prevChapters = regenAllChapters.filter(c => c.chapterNum < chNum);
              const avoidInstruction = `\n\nCRITICAL: These phrases already appear in earlier chapters. Do NOT use them — find different words to express the same ideas:\n${avoidPhrases.map(p => `- "${p}"`).join('\n')}`;

              const fixMsg = `OFFERING: ${story.draft.offering.name}
AUDIENCE: ${story.draft.audience.name}
CONTENT FORMAT: ${spec.label}
CTA: ${story.cta}

THREE TIER MESSAGE:
Tier 1: "${story.draft.tier1Statement?.text || ''}"
${story.draft.tier2Statements.map((t2: any, i: number) => `Tier 2 #${i + 1}: "${t2.text}"`).join('\n')}

${formatPrevChapterContext(prevChapters)}

Write Chapter ${chNum}: "${ch.name}"${avoidInstruction}`;

              let content = await callAI(systemPrompt, fixMsg, 'elite');
              content = content.replace(/^\s*\.{2,}\s*/g, '').trim();
              await prisma.chapterContent.update({
                where: { storyId_chapterNum: { storyId: ctx.storyId, chapterNum: chNum } },
                data: { content },
              });
            }
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
          const normalize = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
          const originalNorm = normalize(story.blendedText);

          const spec = getMediumSpec(story.medium);
          const userMessage = `CONTENT FORMAT: ${spec.label}\nUSER'S REQUEST: ${a.params.instruction}\n\nCURRENT CONTENT:\n${story.blendedText}\n\nApply the requested changes.`;
          // Round C5 — pick the system prompt by the story's effective style.
          const effStyle = await (await import('./styleResolver.js')).resolveStyleForStory(ctx.storyId, userId);
          const copyEditSystem = (await import('../prompts/fiveChapter.js')).buildCopyEditSystem(effStyle);
          let revised = await callAI(copyEditSystem, userMessage, 'elite');

          // Verify the edit actually changed something — AI sometimes returns identical text
          // when the instruction is subtle. Retry once with a stronger nudge if so.
          if (normalize(revised) === originalNorm) {
            const retryMessage = `CONTENT FORMAT: ${spec.label}\nUSER'S REQUEST: ${a.params.instruction}\n\nCURRENT CONTENT:\n${story.blendedText}\n\nCRITICAL: Your previous attempt returned text identical to the original. You MUST actually apply the requested change. If the request is about rewording a specific sentence or opening, rewrite that sentence. Return the FULL content with the change applied.`;
            revised = await callAI(copyEditSystem, retryMessage, 'elite');
          }

          // If it STILL hasn't changed, don't pretend — tell the user honestly
          if (normalize(revised) === originalNorm) {
            actionResult = "I tried but the text came back unchanged — can you tell me more specifically what to change?";
            // refreshNeeded stays false
          } else {
            // Snapshot only after we know we're actually going to write a change
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
            await prisma.fiveChapterStory.update({
              where: { id: ctx.storyId },
              data: { blendedText: revised },
            });
            actionResult = 'Applied copy edit';
            refreshNeeded = true;
          }
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
            // Structural = rebuild the whole table. Only trigger on explicit structural verbs
            // tied to the word "column(s)" — not on cell references like "Tier 2 column 3".
            // False-positive here wipes the draft and tries to regenerate; a bad AI response
            // leaves the user with a gutted table. Be conservative.
            const isStructural = /\b(restructur|reorganiz)/i.test(instruction) ||
              /\b(add|remove|delete|insert|drop)\b[^.]{0,30}\bcolumns?\b/i.test(instruction) ||
              /\b(fewer|more|additional|another)\b[^.]{0,10}\bcolumns?\b/i.test(instruction) ||
              /\b(consolidat|split|merg)\w*[^.]{0,30}\bcolumns?\b/i.test(instruction);

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

              // Validate every priorityId against the audience's real priorities before
              // creating rows. A single bad id used to FK-fail the loop and leave the
              // draft gutted. Coerce unknown ids to null instead.
              const validPriorityIds = new Set(editDraft.audience.priorities.map((p: any) => p.id));
              const safePriorityId = (id: any): string | null =>
                (typeof id === 'string' && validPriorityIds.has(id)) ? id : null;

              // Apply new tiers inside one transaction so a mid-loop failure doesn't
              // leave the draft in a partial state.
              try {
                await prisma.$transaction(async (tx: any) => {
                  const newT1 = await tx.tier1Statement.create({ data: { draftId: ctx.draftId!, text: result.tier1.text } });
                  await tx.cellVersion.create({
                    data: { tier1Id: newT1.id, text: result.tier1.text, versionNum: 1, changeSource: 'ai_generate' },
                  });
                  for (let i = 0; i < result.tier2.length; i++) {
                    const t2 = await tx.tier2Statement.create({
                      data: {
                        draftId: ctx.draftId!,
                        text: result.tier2[i].text,
                        sortOrder: i,
                        priorityId: safePriorityId(result.tier2[i].priorityId),
                        categoryLabel: result.tier2[i].categoryLabel || '',
                      },
                    });
                    await tx.cellVersion.create({
                      data: { tier2Id: t2.id, text: result.tier2[i].text, versionNum: 1, changeSource: 'ai_generate' },
                    });
                    for (let j = 0; j < (result.tier2[i].tier3 || []).length; j++) {
                      const t3 = await tx.tier3Bullet.create({
                        data: { tier2Id: t2.id, text: result.tier2[i].tier3[j], sortOrder: j },
                      });
                      await tx.cellVersion.create({
                        data: { tier3Id: t3.id, text: result.tier2[i].tier3[j], versionNum: 1, changeSource: 'ai_generate' },
                      });
                    }
                  }
                });
                actionResult = `Restructured Three Tier — ${result.tier2.length} columns generated. A checkpoint was saved automatically.`;
                refreshNeeded = true;
              } catch (regenErr: any) {
                // Regenerate failed after the pre-transaction wiped the table.
                // Restore from the snapshot we just saved so the user isn't stranded.
                const latestSnap = await prisma.tableVersion.findFirst({
                  where: { draftId: ctx.draftId!, label: 'Before restructure (via Maria)' },
                  orderBy: { versionNum: 'desc' },
                });
                if (latestSnap) {
                  const snap = latestSnap.snapshot as any;
                  await prisma.$transaction(async (tx: any) => {
                    await tx.tier2Statement.deleteMany({ where: { draftId: ctx.draftId } });
                    await tx.tier1Statement.deleteMany({ where: { draftId: ctx.draftId } });
                    if (snap.tier1) {
                      await tx.tier1Statement.create({ data: { draftId: ctx.draftId!, text: snap.tier1 } });
                    }
                    for (let i = 0; i < (snap.tier2 || []).length; i++) {
                      const row = snap.tier2[i];
                      const t2 = await tx.tier2Statement.create({
                        data: {
                          draftId: ctx.draftId!,
                          text: row.text,
                          sortOrder: i,
                          priorityId: safePriorityId(row.priorityId),
                          categoryLabel: row.categoryLabel || '',
                        },
                      });
                      for (let j = 0; j < (row.tier3 || []).length; j++) {
                        await tx.tier3Bullet.create({ data: { tier2Id: t2.id, text: row.tier3[j], sortOrder: j } });
                      }
                    }
                  });
                }
                actionResult = `Could not restructure: ${regenErr?.message || 'regeneration failed'}. Your previous table has been restored.`;
                refreshNeeded = true;
              }

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

              // Voice guard: drop suggestions that fail syntactic voice rules
              // (contrast clauses, word count for tier1/tier2; comparative-without-
              // anchor for tier3) before they get written to the DB.
              if (dirResult.suggestions) {
                const { checkStatementVoice, checkProofBullet } = await import('./voiceGuard.js');
                dirResult.suggestions = dirResult.suggestions.filter(s => {
                  if (s.cell === 'tier1' || /^tier2-\d+$/.test(s.cell)) {
                    const voiceCheck = checkStatementVoice(s.suggested);
                    if (!voiceCheck.passed) {
                      console.log(`[VoiceGuard:edit_tier] Dropping ${s.cell} suggestion "${s.suggested}" — ${voiceCheck.violations.map(v => v.message).join('; ')}`);
                      return false;
                    }
                    return true;
                  }
                  if (/^tier3-\d+-\d+$/.test(s.cell) || /^tier3-\d+-add$/.test(s.cell)) {
                    const proofCheck = checkProofBullet(s.suggested);
                    if (!proofCheck.passed) {
                      console.log(`[VoiceGuard:edit_tier] Dropping ${s.cell} proof suggestion "${s.suggested}" — ${proofCheck.violations.map(v => v.message).join('; ')}`);
                      return false;
                    }
                  }
                  return true;
                });
              }

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
              if (applied > 0) {
                await prisma.threeTierDraft.update({ where: { id: ctx.draftId }, data: { version: { increment: 1 } } });
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
                    driver: p.driver,
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

      // ─── Build deliverable (full pipeline from existing data) ──
      // Maria triggers this when she has a complete offering + audience and
      // the user wants a deliverable. Creates a draft from existing DB rows,
      // fires the Express pipeline asynchronously, and returns a marker so
      // the frontend/Maria knows a build is in progress.
      if (a.type === 'build_deliverable') {
        const scopeFilter = workspaceId ? { workspaceId } : { userId };
        const offeringId = await resolveOfferingId(a.params, userId, ctx.offeringId, workspaceId);
        const audienceId = await resolveAudienceId(a.params, userId, ctx.audienceId, workspaceId);
        // Round 3.4 Bug 1 — no silent 'email' default. If partner.ts's
        // medium normalizer could not detect a medium from conversation
        // and Opus didn't supply one, refuse to start the build and emit
        // the FORMAT_NEEDED marker. partner.ts replaces Maria's response
        // with the locked format question + chips on this signal.
        const requestedMedium =
          typeof a.params.medium === 'string' && a.params.medium.trim().length > 0
            ? String(a.params.medium).trim().toLowerCase().replace(/[\s-]+/g, '_')
            : null;
        if (!offeringId) {
          actionResult = `Could not find the offering. Try including the offering name.`;
        } else if (!audienceId) {
          actionResult = `Could not find the audience. Try including the audience name.`;
        } else if (!requestedMedium) {
          actionResult = `[FORMAT_NEEDED] Need to ask the format question before building.`;
          refreshNeeded = false;
        } else {
          // Bundle 1A rev7 Pair A — gap-notice-before-build. Detect
          // missing user data the deliverable needs (display-name for
          // email sign-off, Support-category Tier 2 substance for Ch3)
          // BEFORE the pipeline kicks off. When a gap is detected and
          // hasn't been dismissed for this build, return a [GAP_NOTICE:
          // <key>:<question>:<dismissChip>] marker. partner.ts
          // recognizes the marker shape, writes Maria's question into
          // chat with the dismissal chip, and re-fires build_deliverable
          // with gapDismissals populated when the user responds.
          try {
            const medium = requestedMedium;
            const { detectNextGap } = await import('./gapNoticeService.js');
            const userRow = await prisma.user.findUnique({
              where: { id: userId },
              select: { settings: true },
            });
            const draftForGap = await prisma.threeTierDraft.findFirst({
              where: {
                offeringId,
                audienceId,
                ...(workspaceId ? { offering: { workspaceId } } : {}),
              },
              orderBy: { createdAt: 'desc' },
              include: {
                tier2Statements: {
                  orderBy: { sortOrder: 'asc' },
                  include: { tier3Bullets: true },
                },
              },
            });
            const tier2Snapshot = draftForGap
              ? draftForGap.tier2Statements.map(t2 => ({
                  categoryLabel: t2.categoryLabel,
                  text: t2.text,
                  tier3BulletCount: t2.tier3Bullets.length,
                }))
              : [];
            const dismissalsRaw =
              (a.params.gapDismissals && typeof a.params.gapDismissals === 'object')
                ? (a.params.gapDismissals as Record<string, any>)
                : {};
            const dismissals = {
              displayName: dismissalsRaw.displayName === true,
              support: dismissalsRaw.support === true,
            };
            const userSettings = (userRow?.settings as Record<string, any>) || {};
            const userDisplayName = typeof userSettings.displayName === 'string' ? userSettings.displayName : null;
            const gap = detectNextGap({
              userDisplayName,
              medium,
              tier2: tier2Snapshot,
              dismissals,
            });
            if (gap) {
              actionResult = `[GAP_NOTICE:${gap.key}:${gap.question}:${gap.dismissChip}]`;
              refreshNeeded = false;
              continue;
            }
          } catch (gapErr) {
            const errMsg = gapErr instanceof Error ? gapErr.message : String(gapErr);
            console.error(`[build_deliverable] gap detection error (proceeding to build): ${errMsg}`);
          }
          try {
            const medium = requestedMedium;
            const situation = a.params.situation || '';
            // Bundle 1A rev6 Phase 1 — pull verbatimAsk from the Opus
            // tool call params. Opus fills this in per the
            // build_deliverable tool spec (see actionDocs in this file).
            // Forwarded to commitExistingForPipeline →
            // syntheticInterpretation.verbatimAsk, which the pipeline
            // reads for ctaForStory + the metadata-header CTA.
            // Renamed from verbatim_ask (rev5 snake_case) to verbatimAsk
            // for consistency with the canonical ExpressInterpretation
            // interface. Coalesces over the legacy snake_case shape so
            // Opus calls produced by the legacy tool spec still work
            // during the transition.
            const verbatimAsk = typeof a.params.verbatimAsk === 'string'
              ? a.params.verbatimAsk
              : (typeof a.params.verbatim_ask === 'string' ? a.params.verbatim_ask : '');
            // Bundle 1A rev7 Pair A — forward gap dismissals into the
            // pipeline's interpretation so Ch3 (support) and Ch5 (sign-
            // off) generation can read them. The gate already passed
            // by this point; the dismissal flag tells downstream
            // generation which fall-through to use.
            const gapDismissalsForBuild = (a.params.gapDismissals && typeof a.params.gapDismissals === 'object')
              ? {
                  displayName: (a.params.gapDismissals as Record<string, any>).displayName === true,
                  support: (a.params.gapDismissals as Record<string, any>).support === true,
                }
              : undefined;
            const result = await commitExistingForPipeline(
              offeringId,
              audienceId,
              medium,
              situation,
              userId,
              workspaceId || '',
              verbatimAsk,
              gapDismissalsForBuild,
            );
            if (!result || !result.jobId) {
              actionResult = 'Could not start the build — setup returned no job.';
            } else {
              // Round 3.2 Item 1 — write AUTONOMOUS_PRE_BUILD_EXPECTATION
              // verbatim BEFORE the pipeline kicks off, regardless of how
              // build_deliverable fired (Opus interpretation OR direct
              // /partner/autonomous-build endpoint). Cowork observed Opus
              // paraphrasing the locked text into its own conversational
              // frame ("I'll bring you right to it…") when build_deliverable
              // fired via action-call. Direct write here matches the
              // STAGE_CHECKIN_* pattern: locked text is data, not a
              // prompt directive Opus renders.
              try {
                await prisma.assistantMessage.create({
                  data: {
                    userId,
                    role: 'assistant',
                    content: buildAutonomousPreBuildExpectation(medium),
                    context: {
                      channel: 'partner',
                      workspaceId: workspaceId || '',
                      kind: 'autonomous-pre-build',
                    },
                  },
                });
              } catch (writeErr) {
                console.error('[build_deliverable] pre-build expectation write failed (non-fatal):', writeErr);
              }
              setImmediate(() => {
                runPipeline(result.jobId).catch(err => {
                  console.error(`[build_deliverable] Pipeline error for job ${result.jobId}:`, err);
                });
              });
              actionResult = `[BUILD_STARTED:${result.jobId}:${result.draftId}] Building your first draft now. This takes a few minutes.`;
            }
            refreshNeeded = false;
          } catch (err: any) {
            actionResult = `Could not start the build: ${err.message || 'unknown error'}`;
          }
        }
      }

      // ─── Check deliverable status ──────────────────────────
      // Maria calls this to check on a pipeline job she started earlier.
      // When the job is complete, returns a NAVIGATE to the story page.
      if (a.type === 'check_deliverable') {
        try {
          const scopeFilter = workspaceId ? { workspaceId } : { userId };
          let job = null;
          if (a.params?.jobId) {
            job = await prisma.expressJob.findFirst({
              where: { id: a.params.jobId, userId },
            });
          } else {
            job = await prisma.expressJob.findFirst({
              where: { userId, ...scopeFilter },
              orderBy: { createdAt: 'desc' },
            });
          }
          if (!job) {
            actionResult = 'No build in progress right now.';
          } else if (job.status === 'complete' && job.resultStoryId) {
            actionResult = `[NAVIGATE:/five-chapter/${job.draftId}?story=${job.resultStoryId}] Your first draft is ready.`;
            refreshNeeded = true;
          } else if (job.status === 'error') {
            actionResult = `The build ran into a problem: ${job.error || 'unknown error'}. You can try again.`;
          } else {
            actionResult = `Still working — ${job.stage || 'processing'}. ${job.progress || 0}% done.`;
          }
        } catch (err: any) {
          console.error('[check_deliverable] error:', err);
          actionResult = `Could not check status: ${err.message || 'unknown error'}`;
        }
      }

      // ─── Rebuild foundation — parity with the Rebuild button in guided UI ──
      // Called by Maria after she adds a new differentiator in a mapping-gap
      // interview. Regenerates Tier 1/Tier 2 against the current DB state
      // (which now includes the new differentiator). Returns the new Foundation
      // inside a FOUNDATION_REBUILT marker the guided frontend parses to
      // update the foundation card in place.
      if (a.type === 'rebuild_foundation') {
        const draftId = a.params?.draftId || ctx.draftId;
        // leadHint carries positional direction from the user (e.g., "use X as
        // the headline"). Tier 1 generation will use the named element as the
        // because-clause anchor. Optional — undefined means no positional bias.
        const leadHint = typeof a.params?.leadHint === 'string' && a.params.leadHint.trim()
          ? a.params.leadHint.trim()
          : undefined;
        if (!draftId) {
          actionResult = 'Could not rebuild — no draft reference available. Open the foundation first.';
        } else {
          try {
            const result = await rebuildFoundationFromDraft(
              draftId,
              userId,
              workspaceId || '',
              leadHint,
            );
            // Serialize the new Foundation inside the marker so the frontend
            // can update the foundation-card state without a second round trip.
            const payload = JSON.stringify(result);
            actionResult = `[FOUNDATION_REBUILT]${payload}`;
            refreshNeeded = false;
          } catch (err: any) {
            console.error('[rebuild_foundation] error:', err);
            actionResult = `Could not rebuild the foundation: ${err.message || 'unknown error'}`;
          }
        }
      }

      // ─── Acknowledge observation (Change 10) — user reviews and accepts as-is ──
      // Used inside Maria's scoped-to-observation chat. The user has chosen NOT to
      // change the cell after Maria flagged it; this marks the observation
      // RESOLVED_BY_ACKNOWLEDGE so the orange clears and Maria stops re-surfacing.
      if (a.type === 'acknowledge_observation' && a.params?.observationId) {
        try {
          await prisma.observation.update({
            where: { id: String(a.params.observationId) },
            data: { state: 'RESOLVED_BY_ACKNOWLEDGE', resolvedAt: new Date() },
          });
          actionResult = "Got it — I won't re-surface that one.";
          refreshNeeded = true;
        } catch (err: any) {
          console.error('[acknowledge_observation] error:', err);
          actionResult = `Could not acknowledge: ${err.message || 'unknown error'}`;
        }
      }

      // ─── Durable memory: save context Maria just heard (Change 5) ────
      // The user's substantive answer to a why-this-priority-matters or
      // tell-me-about-this-audience question is durable knowledge worth saving
      // so Maria doesn't re-ask next session. Maria offers the save in chat
      // ("OK to save?") and on user-yes calls this with the appropriate target.
      // Targets:
      //   priority_driver: { priorityId, content }
      //   audience_situation: { audienceId, content }
      //   offering_contrarian: { offeringId, content }
      if (a.type === 'save_durable_context' && a.params?.target && a.params?.content) {
        const target = String(a.params.target);
        const content = String(a.params.content).trim();
        if (!content) {
          actionResult = 'Nothing to save — the content was empty.';
          refreshNeeded = false;
        } else {
          try {
            if (target === 'priority_driver' && a.params.priorityId) {
              await prisma.priority.update({
                where: { id: String(a.params.priorityId) },
                data: { driver: content },
              });
              actionResult = 'Saved as the driver.';
              refreshNeeded = true;
            } else if (target === 'audience_situation' && a.params.audienceId) {
              await prisma.audience.update({
                where: { id: String(a.params.audienceId) },
                data: { situation: content },
              });
              actionResult = 'Saved.';
              refreshNeeded = true;
            } else if (target === 'offering_contrarian' && a.params.offeringId) {
              await prisma.offering.update({
                where: { id: String(a.params.offeringId) },
                data: { contrarianScenario: content, contrarianAsked: true },
              });
              actionResult = 'Saved.';
              refreshNeeded = true;
            } else {
              actionResult = `Could not save — missing target ID for "${target}".`;
              refreshNeeded = false;
            }
          } catch (err: any) {
            console.error('[save_durable_context] error:', err);
            actionResult = `Could not save: ${err.message || 'unknown error'}`;
          }
        }
      }

      // ─── Personalization actions ───────────────────────────────
      // Action results for personalization are kept minimal or empty.
      // Maria's system prompt (personalize chat block) guides her response.
      if (a.type === 'start_personalize_interview') {
        await updatePersonalize(userId, { interviewStep: 1 });
        actionResult = '';
        refreshNeeded = false;
      }

      if (a.type === 'personalize_interview_answer' && a.params.answer) {
        const profile = await getPersonalize(userId);
        const step = profile.interviewStep || 1;
        const answers = [...profile.interviewAnswers.filter(ans => ans.question !== step), { question: step, answer: a.params.answer }];

        if (step === 5) {
          // After Q5, generate comparative question for Q6
          // Store comparative data in profile so Maria's system prompt can include it
          const comparative = await generateComparativeQuestion(answers);
          await updatePersonalize(userId, {
            interviewAnswers: answers,
            interviewStep: 6,
            comparativeQ6: comparative,
          } as any);
          actionResult = '';
          refreshNeeded = false;
        } else if (step >= 6) {
          // Q6 answered — interview complete, synthesize profile
          await updatePersonalize(userId, { interviewAnswers: answers, interviewStep: 7 });
          const synthesized = await synthesizeInterviewProfile(answers);
          const merged = mergeStyleSignals(profile, synthesized.observations, synthesized.restrictions);
          await updatePersonalize(userId, {
            observations: merged.observations,
            restrictions: merged.restrictions,
            interviewStep: 7,
          });
          // Empty result — Maria's chat block tells her how to respond post-synthesis
          actionResult = '';
          refreshNeeded = false;
        } else {
          // Steps 1-4: store answer, advance
          await updatePersonalize(userId, { interviewAnswers: answers, interviewStep: step + 1 });
          // No visible result — Maria asks the next question from her system prompt
          actionResult = '';
          refreshNeeded = false;
        }
      }

      if (a.type === 'personalize_interview_synthesize') {
        const profile = await getPersonalize(userId);
        if (profile.interviewAnswers.length >= 5) {
          const synthesized = await synthesizeInterviewProfile(profile.interviewAnswers);
          const merged = mergeStyleSignals(profile, synthesized.observations, synthesized.restrictions);
          await updatePersonalize(userId, {
            observations: merged.observations,
            restrictions: merged.restrictions,
            interviewStep: 7,
          });
          actionResult = '';
          refreshNeeded = false;
        } else {
          actionResult = 'Need at least 5 interview answers to build a style profile.';
          refreshNeeded = false;
        }
      }

      if (a.type === 'analyze_personalization_doc' && a.params.text) {
        const docResult = await analyzeDocument(userId, a.params.text);
        const profile = await getPersonalize(userId);
        const merged = mergeStyleSignals(profile, docResult.observations, docResult.restrictions);
        const documents = [...profile.documents, {
          snippet: a.params.text.substring(0, 200),
          observationsFound: docResult.observations.length,
          analyzedAt: new Date().toISOString(),
        }];
        await updatePersonalize(userId, {
          observations: merged.observations,
          restrictions: merged.restrictions,
          documents,
        });

        if (docResult.diverges && docResult.clarifyingQuestion) {
          actionResult = `Analyzed your writing sample. I noticed some differences from your existing style — ${docResult.clarifyingQuestion}`;
        } else {
          actionResult = `Got it. I picked up ${docResult.observations.length} style pattern${docResult.observations.length === 1 ? '' : 's'} from that sample. ${docResult.snippetSummary}`;
        }
        refreshNeeded = false;
      }

      // ─── Round E1 — Maria-as-researcher actions ─────────────
      // Bug #1 fix: invoke through dispatch (matching the existing pattern
      // used by other Opus-tier actions). The action result is a structured
      // text block Maria reads back to the user inline.
      if (a.type === 'research_website' && a.params?.url) {
        try {
          const cleanUrl = String(a.params.url).startsWith('http')
            ? String(a.params.url)
            : `https://${String(a.params.url)}`;
          const response = await fetch(cleanUrl, {
            headers: { 'User-Agent': 'Maria-Research/1.0' },
            signal: AbortSignal.timeout(15000),
          });
          if (!response.ok) {
            actionResult = `I tried to read ${cleanUrl} but got back status ${response.status}. Want to try a different URL, or paste the content directly?`;
          } else {
            const html = await response.text();
            const pageText = html
              .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
              .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 12000);
            const { researchWebsite } = await import('../services/research.js');
            const result = await researchWebsite({ url: cleanUrl, pageText });
            const lines: string[] = [];
            lines.push(`I read ${cleanUrl}. Here's what I pulled — confirm or correct each piece:`);
            lines.push('');
            if (result.offering?.name || result.offering?.description) {
              lines.push(`OFFERING: ${result.offering.name || ''}${result.offering.description ? ` — ${result.offering.description}` : ''}`);
            }
            if (result.audiences?.length) {
              lines.push(`AUDIENCES: ${result.audiences.map((a: any) => a.name).filter(Boolean).join('; ')}`);
            }
            if (result.differentiators?.length) {
              lines.push('CANDIDATE DIFFERENTIATORS:');
              for (const d of result.differentiators) {
                lines.push(`  • ${d.text}${d.evidence ? ` (page: "${d.evidence.slice(0, 100)}")` : ''}${d.confidence === 'low' ? ' [low confidence — confirm]' : ''}`);
              }
            }
            if (result.uncertainty) {
              lines.push(`UNCERTAIN: ${result.uncertainty}`);
            }
            actionResult = lines.join('\n');
          }
        } catch (err: any) {
          console.error('[research_website] failed:', err);
          actionResult = `I couldn't read that URL: ${err?.message || 'fetch error'}. Want to paste the content directly so I can work from it?`;
        }
        refreshNeeded = false;
      }

      if (a.type === 'research_audience' && a.params?.audienceName) {
        try {
          const { researchAudience } = await import('../services/research.js');
          const result = await researchAudience(
            String(a.params.audienceName),
            typeof a.params.situation === 'string' ? a.params.situation : undefined,
          );
          const lines: string[] = [];
          lines.push(`Sub-segments I see for "${a.params.audienceName}" right now:`);
          for (let i = 0; i < (result.subsegments || []).length; i++) {
            const seg: any = result.subsegments[i];
            lines.push('');
            lines.push(`${i + 1}. ${seg.label}`);
            if (seg.contrast) lines.push(`   What's distinct: ${seg.contrast}`);
            if (Array.isArray(seg.priorities) && seg.priorities.length) {
              lines.push(`   Priorities: ${seg.priorities.join('; ')}`);
            }
            if (Array.isArray(seg.citations) && seg.citations.length) {
              lines.push(`   ${seg.citations.join(' · ')}`);
            }
          }
          if (result.uncertainty) {
            lines.push('');
            lines.push(`To pick: ${result.uncertainty}`);
          }
          actionResult = lines.join('\n');
        } catch (err: any) {
          console.error('[research_audience] failed:', err);
          actionResult = `I couldn't pull research on that audience this round: ${err?.message || 'unknown error'}. Try again, or tell me what you already know about them.`;
        }
        refreshNeeded = false;
      }

      if (a.type === 'test_differentiation' && Array.isArray(a.params?.competitors) && Array.isArray(a.params?.claimedDifferentiators)) {
        try {
          const competitors: { name: string; url: string }[] = a.params.competitors
            .filter((c: any) => c && typeof c.url === 'string')
            .map((c: any) => ({ name: String(c.name || c.url), url: String(c.url) }));
          const claimed: string[] = a.params.claimedDifferentiators
            .filter((d: any) => typeof d === 'string' && d.trim())
            .map((d: any) => String(d));
          if (competitors.length === 0 || claimed.length === 0) {
            actionResult = "I need at least one competitor URL and one claimed differentiator to run the test.";
          } else {
            // Fetch each competitor's page text in parallel; tolerate per-site failures.
            const fetched = await Promise.all(competitors.map(async (c) => {
              try {
                const cleanUrl = c.url.startsWith('http') ? c.url : `https://${c.url}`;
                const r = await fetch(cleanUrl, {
                  headers: { 'User-Agent': 'Maria-Research/1.0' },
                  signal: AbortSignal.timeout(15000),
                });
                if (!r.ok) return { name: c.name, url: cleanUrl, pageText: '' };
                const html = await r.text();
                const pageText = html
                  .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                  .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                  .replace(/<[^>]+>/g, ' ')
                  .replace(/\s+/g, ' ')
                  .trim()
                  .slice(0, 6000);
                return { name: c.name, url: cleanUrl, pageText };
              } catch {
                return { name: c.name, url: c.url, pageText: '' };
              }
            }));
            const reachable = fetched.filter((c) => c.pageText && c.pageText.length > 200);
            if (reachable.length === 0) {
              actionResult = "I couldn't reach any of those competitor sites. Want to paste the relevant pages, or try different URLs?";
            } else {
              const { testDifferentiation } = await import('../services/research.js');
              const result = await testDifferentiation({ competitors: reachable, claimedDifferentiators: claimed });
              const lines: string[] = [];
              lines.push(`Tested ${claimed.length} differentiator${claimed.length === 1 ? '' : 's'} against ${reachable.length} competitor${reachable.length === 1 ? '' : 's'}:`);
              for (const r of result.results || []) {
                lines.push('');
                lines.push(`• "${r.claim}" — ${r.classification}`);
                if (Array.isArray(r.competitorsWithIt) && r.competitorsWithIt.length) {
                  lines.push(`   also at: ${r.competitorsWithIt.join('; ')}`);
                }
                if (r.rationale) lines.push(`   ${r.rationale}`);
              }
              if (result.summary) {
                lines.push('');
                lines.push(result.summary);
              }
              const unreachable = fetched.filter((c) => !c.pageText).map((c) => c.url);
              if (unreachable.length) {
                lines.push('');
                lines.push(`(Couldn't reach: ${unreachable.join(', ')})`);
              }
              actionResult = lines.join('\n');
            }
          }
        } catch (err: any) {
          console.error('[test_differentiation] failed:', err);
          actionResult = `Differentiation test failed: ${err?.message || 'unknown error'}.`;
        }
        refreshNeeded = false;
      }

      // Catch silent failures: action dispatched but no handler ran
      // Note: actionResult === '' means a handler ran but has no visible output (e.g. personalization).
      // Only trigger fallback when actionResult is still null (no handler matched).
      if (actionResult === null) {
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
          lines.push(`    ${p.sortOrder + 1}. "${p.text}" (rank ${p.rank})${p.driver ? ` — Driver: "${p.driver}"` : ''}`);
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
          lines.push(`  ${p.sortOrder + 1}. "${p.text}" (rank ${p.rank})${p.driver ? ` — Driver: "${p.driver}"` : ''}`);
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
          lines.push(`  ${p.sortOrder + 1}. "${p.text}"${p.driver ? ` — Driver: "${p.driver}"` : ''}`);
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
  actions.push('- edit_priorities: Update priority text or driver. Params: { edits: [{ position: number, text?: string, driver?: string }], audienceName?: string } — position is 1-based. "driver" is the persona-specific reason this priority matters to this audience.');
  actions.push('- delete_priorities: Remove priorities by position. Params: { positions: number[], audienceName?: string } — 1-based positions.');
  actions.push('- reorder_priorities: Reorder priorities. Params: { order: number[], audienceName?: string } — array of current positions in desired new order.');

  // Offering actions — always available (Maria can interview from any page)
  if (context.offeringId) {
    actions.push('- edit_offering: Update the current offering name or description. Params: { name?: string, description?: string }');
  }
  actions.push('- add_capabilities: Add capabilities to an offering. Params: { texts: string[], offeringName?: string } — offeringName targets a specific offering by name (partial match OK). Required if not on an offering page.');
  actions.push('- edit_capabilities: Update capabilities — rename text or set motivating factor. Params: { edits: [{ position: number, text?: string, motivatingFactor?: string }], offeringName?: string } — position is 1-based.');
  actions.push('- delete_capabilities: Remove capabilities by position. Params: { positions: number[], offeringName?: string } — 1-based positions.');
  actions.push('- draft_mfs: Have Maria draft motivating factors for ALL differentiators on an offering that lack one, in a single batch. Params: { offeringName?: string } — offeringName targets a specific offering by partial match. If omitted, uses the current page\'s offering. PREFERRED over edit_capabilities one-at-a-time when the user asks "draft motivating factors" or similar — single call, audience-portable standard, mfCheck quality gate built in.');

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

  // Build deliverable — full pipeline from existing offering + audience
  actions.push('- build_deliverable: Build a complete first draft (Three Tier + Five Chapter Story) from an existing offering and audience. Runs the full pipeline autonomously — mapping, message generation, story writing, voice check, polishing. Takes a few minutes. Params: { offeringName: string, audienceName: string, medium: string, situation?: string, verbatimAsk?: string, gapDismissals?: { displayName?: boolean; support?: boolean } }. The build may be gated by a gap-notice when Maria detects user data missing for the deliverable (display name for email sign-off, Support-category Tier 2 substance for Ch3). When the user dismisses a gap-notice via chip, re-fire build_deliverable with gapDismissals.<key>: true (e.g., { gapDismissals: { displayName: true } }). The dismissal lets the build proceed with a graceful default (e.g., "Best regards" close, or the locked Ch3 fall-through line) instead of a placeholder. — medium options: email, blog, landing_page, in_person, press_release, newsletter, one-pager, report, pitch_deck. situation is the specific context or occasion for this deliverable (e.g., "Q3 partnership webinar invitation", "investor meeting next week"). verbatimAsk is the user\'s call-to-action with all signal preserved and only the noise dropped. PRESERVE the signal — every word that carries action meaning: the action verb and its object, real deadlines (a date, "by Friday"), real scope (the audience-org name, possessives that specify what the action is about), modifiers and articles that come with the action. DROP the noise — only these: imperative-marker prefixes ("I want them to", "we want him to", "tell them to", "have them", "the ask is", and close variants); filler words ("like", "kind of", "sort of"); hedges ("or whenever works", "if possible"). Do NOT touch anything outside that list. Possessives stay. Articles stay. Modifiers stay. Worked examples: user said "We want him to confirm Veracore\'s participation in our joint Q3 webinar by May 15." → verbatimAsk = "confirm Veracore\'s participation in our joint Q3 webinar by May 15." (possessive "Veracore\'s" preserved). User said "we want him to like sign up for the demo by friday or whenever works." → verbatimAsk = "sign up for the demo by Friday." (filler and hedge dropped, real deadline preserved). Tone notes ("the tone should be partner-to-partner") are NOT asks — skip them. If the user did not state an ask, omit verbatimAsk entirely (empty is better than fabricated).');
  actions.push('- check_deliverable: Check status of a deliverable build you started with build_deliverable. When complete, navigates to the finished draft. Params: { jobId?: string } — omit jobId to check the most recent build.');
  actions.push('- rebuild_foundation: Regenerate the Tier 1 and Tier 2 of an in-progress guided Foundation against the current offering + audience state. Use AFTER you have added a new differentiator (via add_capabilities) in response to a mapping gap — this rebuilds so the user sees the updated Tier 1 that reflects the new differentiator. Takes about 60 seconds. Params: { draftId: string } — the guided draftId. Your response while this runs: "Let me rebuild with that in." Returns a FOUNDATION_REBUILT marker the frontend uses to update the foundation card in place.');

  // Durable memory — save substantive context Maria just heard so it persists across sessions
  actions.push('- save_durable_context: Persist a substantive answer the user just gave so Maria does not re-ask next session. Use ONLY after the user has confirmed the save (e.g., "yes save that"). Params: { target: "priority_driver" | "audience_situation" | "offering_contrarian", content: string, priorityId?: string, audienceId?: string, offeringId?: string }. Choose target by the kind of knowledge: priority_driver = why a priority matters to this audience (Driver); audience_situation = audience-specific situation/context worth carrying across deliverables; offering_contrarian = scenario where the offering is NOT the right choice. Match the ID to the target.');

  // Acknowledge observation — user accepts cell as-is despite Maria's open suggestion (Change 10)
  actions.push('- acknowledge_observation: Mark a Maria-flagged cell suggestion as resolved-by-acknowledge — the user reviewed it and chose not to act on it. Use only inside the scoped Maria conversation a user opens by tapping a flagged (orange) cell. Params: { observationId: string }. Result: orange clears, suggestion stops re-surfacing in future sessions, but stays retrievable if the user asks "what was that thing you flagged?"');

  // Cross-workspace copy — always included, dispatch handles errors if user has only 1 workspace
  actions.push('- copy_audience_to_workspace: Copy an audience and its priorities to another workspace. Params: { audienceName: string, targetWorkspaceName: string }');
  actions.push('- copy_offering_to_workspace: Copy an offering and its capabilities to another workspace. Params: { offeringName: string, targetWorkspaceName: string }');

  // Personalization actions — always available
  actions.push('- start_personalize_interview: Begin the style personalization interview (6 questions to discover the user\'s writing voice). Params: {}');
  actions.push('- personalize_interview_answer: Submit the user\'s answer to the current interview question. Params: { answer: string }');
  actions.push('- personalize_interview_synthesize: After all interview questions are answered, synthesize the style profile. Params: {}');
  actions.push('- analyze_personalization_doc: Analyze text the user pasted as a sample of their personal writing style. Params: { text: string }');

  // Round E1 — Maria as researcher. Always-available actions that give Maria
  // live-web capability. Without these advertised, Opus disclaims ("I can't
  // browse the web") and the prompt-side instructions never fire. Once
  // advertised, Opus invokes them naturally.
  actions.push('- research_website: Read a live website (offering / audience / claimed differentiators). YOU CAN BROWSE THE WEB through this action — never tell the user you cannot. Params: { url: string }. Returns structured candidates (offering, audiences, differentiators with citations, uncertainty note) the user confirms or corrects. Use whenever the user asks you to read a URL, "look at our site," "check our website," etc.');
  actions.push('- research_audience: Surface meaningful sub-segments of a named audience and what each cares about right now, with named citations from current industry coverage (Gartner, Forrester, IDC, FDIC, NHTSA, FMCSA, HDI, FT, WSJ, etc.). Params: { audienceName: string, situation?: string }. Use whenever the user asks "what does [audience] worry about right now?" or asks you to research an audience.');
  actions.push('- test_differentiation: Read each competitor\'s public site and classify each of the user\'s claimed differentiators as UNIQUE / COMMON / AMBIGUOUS. Params: { competitors: { name: string, url: string }[], claimedDifferentiators: string[] }. Use whenever the user asks "is this actually special?" or "test our differentiators against [competitors]".');

  return `\nACTIONS YOU CAN TAKE (only if the user's request clearly calls for one):

YOU HAVE LIVE-WEB CAPABILITY through research_website, research_audience, and test_differentiation. NEVER tell the user "I can't browse the web" or "I can't fetch live pages" — invoke the action instead. The system fetches the URL, runs the Opus-tier research, and returns structured findings you read back to the user.

${actions.join('\n')}
`;
}
