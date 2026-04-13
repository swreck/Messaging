import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { Spinner } from '../shared/Spinner';
import { InfoTooltip } from '../shared/InfoTooltip';
import { ChapterVersionNav } from '../shared/ChapterVersionNav';
import { BlendedVersionNav } from '../shared/BlendedVersionNav';
import { ConfirmModal } from '../shared/ConfirmModal';
import { useMaria } from '../shared/MariaContext';
import { useToast } from '../shared/ToastContext';
import type { ThreeTierDraft, FiveChapterStory, ChapterContent, StoryMedium, PersonalizeProfile } from '../types';
import { CHAPTER_CRITERIA, MEDIUM_OPTIONS } from '../types';

/** Light markdown: **bold** → <strong>, *italic* → <em>, HTML-escaped. Strips markdown headers. */
function renderLightMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '')  // strip markdown headers
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
}

export function FiveChapterShell() {
  const { draftId } = useParams<{ draftId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { showToast } = useToast();
  const [draft, setDraft] = useState<ThreeTierDraft | null>(null);
  const [stories, setStories] = useState<FiveChapterStory[]>([]);
  const [story, setStory] = useState<FiveChapterStory | null>(null);
  const [loading, setLoading] = useState(true);

  // Create form
  const [medium, setMedium] = useState<StoryMedium>('email');
  const [cta, setCta] = useState('');
  const [emphasis, setEmphasis] = useState('');
  const [creating, setCreating] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [sourceStoryIdForCreate, setSourceStoryIdForCreate] = useState<string | null>(null);
  const [renamingStoryId, setRenamingStoryId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDeleteStory, setConfirmDeleteStory] = useState<string | null>(null);

  // Generation
  const [generatingChapter, setGeneratingChapter] = useState<number | null>(null);
  const [generating, setGenerating] = useState(false);

  // Blending
  const [blending, setBlending] = useState(false);

  // Polish
  const [polishing, setPolishing] = useState(false);
  const [polishImproved, setPolishImproved] = useState(false);

  // Track the refinement stage of the blended text for heading display
  const [blendedStage, setBlendedStage] = useState<'blended' | 'polished' | 'personalized'>('blended');
  // Previous stage snapshots — ordered list of user actions, each collapsible
  const [stageSnapshots, setStageSnapshots] = useState<{ label: string; text: string; collapsed: boolean }[]>([]);

  // Personalize
  const [personalizing, setPersonalizing] = useState(false);
  const [personalizeResults, setPersonalizeResults] = useState<{ chapters: { chapter: number; passed: boolean; attempts: number }[] } | null>(null);
  const [, setPersonalizeProfile] = useState<PersonalizeProfile | null>(null);

  // Inline editing
  const [editingChapter, setEditingChapter] = useState<number | null>(null);
  const [editText, setEditText] = useState('');
  const [showCompleteDraft, setShowCompleteDraft] = useState(false);
  const [chaptersCollapsed, setChaptersCollapsed] = useState(false);
  const [combinedCollapsed, setCombinedCollapsed] = useState(false);
  // Auto-show complete draft and collapse chapters/combined if blended text already exists
  useEffect(() => { if (story?.blendedText) { setShowCompleteDraft(true); setChaptersCollapsed(true); setCombinedCollapsed(true); } }, [story?.id]);
  const [editingBlended, setEditingBlended] = useState(false);
  const [editContent, setEditContent] = useState('');

  // Copy edit
  const [copyEditInput, setCopyEditInput] = useState('');
  const [copyEditing, setCopyEditing] = useState(false);

  // Missing MF panel
  const [showMFPanel, setShowMFPanel] = useState(false);
  const [derivingMF, setDerivingMF] = useState(false);
  const [bypassMF] = useState(false);
  // Track AI-derived MFs for future display markers
  const [, setAiDerivedMFs] = useState<Set<string>>(new Set());

  // Share
  const [shareUrl, setShareUrl] = useState<string | null>(null);

  // Confirm modals
  const [confirmBlendReplace, setConfirmBlendReplace] = useState(false);
  const [confirmRegenerateAll, setConfirmRegenerateAll] = useState(false);
  const [conflictConfirm, setConflictConfirm] = useState<{ onDiscard: () => void } | null>(null);

  // Post-generation orientation messages
  const [, setChaptersJustGenerated] = useState(false);
  const [, setCombineJustCompleted] = useState(false);
  const [, setBlendJustGenerated] = useState(false);

  // All completed drafts for audience/offering pickers on create form
  const [allDrafts, setAllDrafts] = useState<{ id: string; audienceId: string; audienceName: string; offeringId: string; offeringName: string }[]>([]);

  // Editable params
  const [editingParam, setEditingParam] = useState<'medium' | 'cta' | 'emphasis' | null>(null);
  const [editCta, setEditCta] = useState('');
  const [paramsChanged, setParamsChanged] = useState(false);

  const chapterRefs = useRef<(HTMLDivElement | null)[]>([]);
  const { setPageContext, registerRefresh } = useMaria();

  useEffect(() => {
    if (draftId) loadData();
  }, [draftId]);

  // Register page context for Maria assistant
  useEffect(() => {
    setPageContext({
      page: 'five-chapter',
      draftId: draftId || undefined,
      storyId: story?.id,
    });
    registerRefresh(loadData);
  }, [draftId, story?.id]);

  async function loadData() {
    setLoading(true);
    try {
      const { draft: d } = await api.get<{ draft: ThreeTierDraft }>(`/drafts/${draftId}`);
      setDraft(d);
      // Fetch all completed drafts for audience/offering pickers
      try {
        const { drafts: fetchedDrafts } = await api.get<{ drafts: { id: string; offeringId: string; audienceId: string; currentStep: number; status: string; offering: { name: string }; audience: { id: string; name: string } }[] }>('/drafts');
        setAllDrafts(
          fetchedDrafts
            .filter(dr => dr.status === 'complete' || dr.currentStep === 5)
            .map(dr => ({ id: dr.id, audienceId: dr.audienceId, audienceName: dr.audience.name, offeringId: dr.offeringId, offeringName: dr.offering.name }))
        );
      } catch {}
      const { stories: s } = await api.get<{ stories: FiveChapterStory[] }>(`/stories?draftId=${draftId}`);
      setStories(s);
      if (s.length > 0 && !story) {
        const requestedId = searchParams.get('story');
        if (requestedId) {
          // User clicked on a specific existing story — open it
          const match = s.find(st => st.id === requestedId);
          const selected = match || s[0];
          setStory(selected);
          // Check version history to determine blended stage and populate snapshots
          if (selected.blendedText) {
            try {
              const { versions } = await api.get<{ versions: { label: string; snapshot: any }[] }>(`/versions/story/${selected.id}`);
              if (versions.length > 0) {
                const latestLabel = versions[0].label.toLowerCase();
                if (latestLabel.includes('personalize')) {
                  setBlendedStage('personalized');
                } else if (latestLabel.includes('polish')) {
                  setBlendedStage('polished');
                } else {
                  setBlendedStage('blended');
                }
                // Build stage snapshots from version history for disclosure rows
                // Keep only the LATEST snapshot per stage label (dedup)
                const stageMap = new Map<string, string>();
                for (const v of versions) { // newest-first from API
                  const lbl = v.label.toLowerCase();
                  if (lbl.includes('before blend') && v.snapshot?.blendedText && !stageMap.has('Blended')) {
                    stageMap.set('Blended', v.snapshot.blendedText);
                  } else if (lbl.includes('polish') && v.snapshot?.blendedText && !stageMap.has('Polished')) {
                    stageMap.set('Polished', v.snapshot.blendedText);
                  } else if (lbl.includes('personalize') && v.snapshot?.blendedText && !stageMap.has('Personalized')) {
                    stageMap.set('Personalized', v.snapshot.blendedText);
                  }
                }
                // Order: Blended first, then Polished, then Personalized
                // Only include stages BEFORE the current active stage — the active stage is the live view, not a disclosure row
                const currentStage = latestLabel.includes('personalize') ? 'Personalized'
                  : latestLabel.includes('polish') ? 'Polished' : 'Blended';
                const snapshots: { label: string; text: string; collapsed: boolean }[] = [];
                if (stageMap.has('Blended') && currentStage !== 'Blended') snapshots.push({ label: 'Blended', text: stageMap.get('Blended')!, collapsed: true });
                if (stageMap.has('Polished') && currentStage !== 'Polished') snapshots.push({ label: 'Polished', text: stageMap.get('Polished')!, collapsed: true });
                if (stageMap.has('Personalized') && currentStage !== 'Personalized') snapshots.push({ label: 'Personalized', text: stageMap.get('Personalized')!, collapsed: true });
                if (snapshots.length > 0) setStageSnapshots(snapshots);
              }
            } catch {}
          }
        } else if (s.length > 0) {
          // No story param — user clicked "+ New Deliverable"
          // Show create form instead of auto-selecting existing story
          setShowCreateForm(true);
        }
      }
    } catch {
      navigate('/');
    } finally {
      setLoading(false);
    }
  }

  // Load personalization profile
  useEffect(() => {
    api.get<{ profile: PersonalizeProfile }>('/personalize/profile')
      .then(({ profile }) => setPersonalizeProfile(profile))
      .catch(() => {});
  }, []);

  function topPriorityHasMF(): boolean {
    if (!draft) return false;
    const top = draft.audience.priorities[0];
    return !!top?.motivatingFactor;
  }

  async function createStory(e: React.FormEvent) {
    e.preventDefault();
    if (!cta) return;
    setCreating(true);
    try {
      const { story: s } = await api.post<{ story: FiveChapterStory }>('/stories', {
        draftId,
        medium,
        cta,
        emphasis,
        sourceStoryId: sourceStoryIdForCreate || undefined,
      });
      setStories(prev => [s, ...prev]);
      setStory(s);
      setShowCreateForm(false);
      setSourceStoryIdForCreate(null);
      setCta('');
      setEmphasis('');

      // Auto-generate chapters if this was created from "Draft the Next Piece"
      if (sourceStoryIdForCreate) {
        setGenerating(true);
        for (let i = 1; i <= 5; i++) {
          setGeneratingChapter(i);
          const { chapter } = await api.post<{ chapter: ChapterContent }>('/ai/generate-chapter', {
            storyId: s.id,
            chapterNum: i,
          });
          setStory(prev => {
            if (!prev) return prev;
            const existing = prev.chapters.findIndex(c => c.chapterNum === i);
            const chapters = [...prev.chapters];
            if (existing >= 0) chapters[existing] = chapter;
            else chapters.push(chapter);
            return { ...prev, chapters };
          });
        }
        setGenerating(false);
        setGeneratingChapter(null);
      }
    } catch (err: any) {
      showToast(err.message);
      setGenerating(false);
      setGeneratingChapter(null);
    } finally {
      setCreating(false);
    }
  }

  async function renameStory(storyId: string, newName: string) {
    try {
      await api.patch(`/stories/${storyId}/rename`, { customName: newName });
      setStories(prev => prev.map(s => s.id === storyId ? { ...s, customName: newName } : s));
      if (story?.id === storyId) setStory(prev => prev ? { ...prev, customName: newName } : prev);
    } catch { showToast('Could not rename'); }
    setRenamingStoryId(null);
  }

  async function deleteStory(storyId: string) {
    try {
      await api.delete(`/stories/${storyId}`);
      setStories(prev => prev.filter(s => s.id !== storyId));
      if (story?.id === storyId) setStory(stories.find(s => s.id !== storyId) || null);
    } catch { showToast('Could not delete'); }
    setConfirmDeleteStory(null);
  }

  async function polishStory() {
    if (!story) return;
    // Capture current text as snapshot of whatever stage we're leaving
    if (story.blendedText) {
      const label = blendedStage === 'personalized' ? 'Personalized'
        : blendedStage === 'polished' ? 'Polished'
        : 'Blended';
      setStageSnapshots(prev => [...prev, { label, text: story.blendedText, collapsed: true }]);
    }
    setPolishing(true);
    setPolishImproved(false);
    try {
      const result = await api.post<{ story: FiveChapterStory; improved: boolean }>('/ai/polish-story', { storyId: story.id });
      setStory(result.story);
      setPolishImproved(result.improved);
      if (result.improved) setBlendedStage('polished');
      if (result.story.blendedText) {
        setShowCompleteDraft(true);
        setChaptersCollapsed(true);
        setCombinedCollapsed(true);
      }
    } catch (err: any) {
      showToast(err?.message || 'Polish failed');
    } finally {
      setPolishing(false);
    }
  }

  async function handlePersonalize() {
    // Re-fetch profile in case interview was completed during this session
    try {
      const { profile } = await api.get<{ profile: PersonalizeProfile }>('/personalize/profile');
      setPersonalizeProfile(profile);
      if (!profile || profile.observations.length === 0) {
        document.dispatchEvent(new CustomEvent('maria-toggle', {
          detail: { open: true, message: "I'd like to set up my personal writing style. Ask me the first question." },
        }));
        return;
      }
    } catch {
      document.dispatchEvent(new CustomEvent('maria-toggle', {
        detail: { open: true, message: "I'd like to set up my personal writing style. Ask me the first question." },
      }));
      return;
    }
    if (!story?.blendedText) {
      showToast('Blend into a story first, then personalize.');
      return;
    }
    personalizeStory();
  }

  async function personalizeStory() {
    if (!story?.blendedText) return;
    // Capture current text as snapshot of whatever stage we're leaving
    const label = blendedStage === 'polished' ? 'Polished'
      : blendedStage === 'personalized' ? 'Personalized'
      : 'Blended';
    setStageSnapshots(prev => [...prev, { label, text: story.blendedText, collapsed: true }]);
    setPersonalizing(true);
    setPersonalizeResults(null);
    try {
      const resp = await api.post<{ story: FiveChapterStory; passed: boolean; attempts: number }>(
        '/personalize/apply-all', { storyId: story.id }
      );
      setStory(resp.story);
      setPersonalizeResults({ chapters: [{ chapter: 0, passed: resp.passed, attempts: resp.attempts }] });
      setBlendedStage('personalized');
      // Ensure blended view stays visible
      setShowCompleteDraft(true);
      setChaptersCollapsed(true);
      setCombinedCollapsed(true);
    } catch (err: any) {
      showToast(err?.message || 'Personalization failed');
    } finally {
      setPersonalizing(false);
    }
  }

  // Maria guidance — opens Maria with contextual message the first time through each stage.
  // After the first time, checks a global opt-in flag. If the user has chosen to turn off
  // proactive help, Maria stays in the bubble. Mobile users default to a gentler "glow only"
  // hint so the help doesn't occlude the chapter they're looking at.
  function mariaGuide(stage: string, message: string) {
    const key = `maria-guided-${stage}`;
    if (localStorage.getItem(key)) return; // Already guided for this stage
    localStorage.setItem(key, 'true');

    // Global off-switch — user dismissed proactive help in a previous guide
    if (localStorage.getItem('maria-proactive-help-off') === '1') return;

    const isNarrow = typeof window !== 'undefined' && window.innerWidth <= 600;
    // On phone: glow the bubble + stash the message as a HINT (injected as assistant line
    //   when the user opens the panel — no backend call, no user message in history).
    // On larger screens: open the panel and show the hint.
    // Either way, the hint has an opt-out line so the user can turn this off.
    const augmented = `${message}\n\nIf you'd rather I stay quiet, say "stop jumping in" and I won't pop up unless you open me.`;
    setTimeout(() => {
      document.dispatchEvent(new CustomEvent('maria-toggle', {
        detail: {
          open: !isNarrow,
          message: augmented,
          hint: true,
          glow: isNarrow,
        },
      }));
    }, 500);
  }

  async function generateAllChapters(skipMFCheck = false) {
    if (!story) return;

    // Check MF first (skip if we just derived it, or if user chose to continue without)
    if (!skipMFCheck && !bypassMF && !topPriorityHasMF()) {
      setShowMFPanel(true);
      return;
    }

    setGenerating(true);
    try {
      for (let i = 1; i <= 5; i++) {
        setGeneratingChapter(i);
        const resp = await api.post<{ chapter: ChapterContent; dedupApplied?: boolean; allChapters?: ChapterContent[] }>('/ai/generate-chapter', {
          storyId: story.id,
          chapterNum: i,
        });
        // If dedup ran after Ch5, update ALL chapters with deduped versions
        if (resp.dedupApplied && resp.allChapters) {
          setStory(prev => {
            if (!prev) return prev;
            return { ...prev, chapters: resp.allChapters!.sort((a, b) => a.chapterNum - b.chapterNum) };
          });
        } else {
          setStory(prev => {
            if (!prev) return prev;
            const chapters = prev.chapters.filter(c => c.chapterNum !== i);
            chapters.push(resp.chapter);
            chapters.sort((a, b) => a.chapterNum - b.chapterNum);
            return { ...prev, chapters };
          });
        }
        // Scroll to the chapter that just generated
        setTimeout(() => {
          chapterRefs.current[i - 1]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 100);
      }
      setChaptersJustGenerated(true);
      mariaGuide('chapters-generated', 'All five chapters are drafted. You can edit any of them by tapping the text. When you\'re ready, Combine Chapters puts them together as-is, or Blend into Story rewrites them as one flowing piece.');
    } catch (err: any) {
      showToast(err.message);
    } finally {
      setGenerating(false);
      setGeneratingChapter(null);
    }
  }

  async function regenerateChapter(num: number) {
    if (!story) return;
    setGeneratingChapter(num);
    try {
      const { chapter } = await api.post<{ chapter: ChapterContent }>('/ai/generate-chapter', {
        storyId: story.id,
        chapterNum: num,
      });
      setStory(prev => {
        if (!prev) return prev;
        const chapters = prev.chapters.map(c => c.chapterNum === num ? chapter : c);
        return { ...prev, chapters };
      });
    } catch (err: any) {
      showToast(err.message);
    } finally {
      setGeneratingChapter(null);
    }
  }

  async function blendStory() {
    if (!story) return;
    if (story.blendedText && story.blendedText.trim()) {
      setConfirmBlendReplace(true);
      return;
    }
    doBlendStory();
  }

  async function doBlendStory() {
    if (!story) return;
    setBlending(true);
    try {
      const { story: updated } = await api.post<{ story: FiveChapterStory }>('/ai/blend-story', {
        storyId: story.id,
      });
      setStory(updated);
      setBlendJustGenerated(true);
      mariaGuide('story-blended', 'Your story is blended into one piece. You can tap the text to edit directly, or type a change instruction at the bottom. When you\'re happy with it, Polish improves the tone, and Personalize adjusts it to sound like you.');
      setChaptersJustGenerated(false);
      setShowCompleteDraft(true);
      setChaptersCollapsed(true);
      setCombinedCollapsed(true);
    } catch (err: any) {
      showToast(err.message);
    } finally {
      setBlending(false);
    }
  }

  async function combineChapters() {
    if (!story) return;
    // Concatenate chapters in order — no AI, no titles, no dividers, just the copy
    const combined = story.chapters
      .sort((a, b) => a.chapterNum - b.chapterNum)
      .map(ch => ch.content)
      .join('\n\n');

    // Save to joinedText via API
    try {
      const { story: updated } = await api.put<{ story: FiveChapterStory }>(`/stories/${story.id}`, {
        joinedText: combined,
        stage: 'joined',
        version: story.version,
      });
      setStory(updated);
      setShowCompleteDraft(true);
      setChaptersCollapsed(true);
      setChaptersJustGenerated(false);
      setCombineJustCompleted(true);
    } catch (err: any) {
      showToast(err?.message || 'Could not combine chapters');
    }
  }

  async function saveChapterEdit(chapterNum: number) {
    if (!story) return;
    try {
      const { story: updated } = await api.put<{ story: FiveChapterStory }>(`/stories/${story.id}/chapters/${chapterNum}`, { content: editText, version: story.version });
      setStory(prev => {
        if (!prev) return prev;
        const chapters = prev.chapters.map(c =>
          c.chapterNum === chapterNum ? { ...c, content: editText } : c
        );
        return { ...prev, version: updated.version, chapters };
      });
      setEditingChapter(null);
    } catch (err: any) {
      if (err?.status === 409) {
        setConflictConfirm({
          onDiscard: () => { setEditingChapter(null); loadData(); },
        });
      } else {
        showToast(err.message);
      }
    }
  }

  async function saveBlendedEdit() {
    if (!story) return;
    try {
      const { story: updated } = await api.put<{ story: FiveChapterStory }>(`/stories/${story.id}`, { blendedText: editContent, version: story.version });
      setStory(updated);
      setEditingBlended(false);
    } catch (err: any) {
      if (err?.status === 409) {
        setConflictConfirm({
          onDiscard: () => { setEditingBlended(false); loadData(); },
        });
      } else {
        showToast(err.message);
      }
    }
  }

  async function copyEdit() {
    if (!story || !copyEditInput.trim()) return;
    setCopyEditing(true);
    try {
      const content = story.blendedText || story.chapters.map(c => c.content).join('\n\n');
      const { content: revised, unchanged } = await api.post<{ content: string; unchanged?: boolean }>('/ai/copy-edit', {
        storyId: story.id,
        content,
        request: copyEditInput.trim(),
      });
      if (unchanged) {
        showToast("Maria tried but the text came back unchanged. Try phrasing your request differently.", 'info');
        // Keep the input so the user can adjust it
      } else if (story.blendedText) {
        const { story: updated } = await api.put<{ story: FiveChapterStory }>(`/stories/${story.id}`, { blendedText: revised, version: story.version });
        setStory(updated);
        setCopyEditInput('');
      }
    } catch (err: any) {
      showToast(err.message);
    } finally {
      setCopyEditing(false);
    }
  }

  async function deriveMotivation() {
    if (!draft) return;
    const top = draft.audience.priorities[0];
    if (!top) return;
    setDerivingMF(true);
    try {
      await api.post('/ai/derive-motivation', {
        priorityId: top.id,
        audienceId: draft.audience.id,
        offeringId: draft.offering.id,
      });
      // Reload draft to get updated MF
      const { draft: d } = await api.get<{ draft: ThreeTierDraft }>(`/drafts/${draftId}`);
      setDraft(d);
      setAiDerivedMFs(prev => new Set(prev).add(top.id));
      setShowMFPanel(false);
      // Now generate — skip MF check since we just derived it
      generateAllChapters(true);
    } catch (err: any) {
      showToast(err.message);
    } finally {
      setDerivingMF(false);
    }
  }

  async function updateStoryParam(field: string, value: string) {
    if (!story) return;
    try {
      const { story: updated } = await api.put<{ story: FiveChapterStory }>(`/stories/${story.id}`, { [field]: value, version: story.version });
      setStory(updated);
      // Update in stories list too
      setStories(prev => prev.map(s => s.id === updated.id ? updated : s));
      setEditingParam(null);
      setParamsChanged(true);
    } catch (err: any) {
      if (err?.status === 409) {
        showToast('This story was edited elsewhere. Refreshing to show the latest version.', 'info');
        setEditingParam(null);
        loadData();
      } else {
        showToast(err.message);
      }
    }
  }

  async function regenerateAfterParamChange() {
    if (!story) return;
    // Snapshot first
    await api.post(`/versions/story/${story.id}`, { label: 'Before param change' });
    setParamsChanged(false);
    generateAllChapters();
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
  }

  async function shareStory() {
    if (!story) return;
    try {
      const result = await api.post<{ token: string; url: string }>('/share', { storyId: story.id });
      const fullUrl = `${window.location.origin}${result.url}`;
      setShareUrl(fullUrl);
      navigator.clipboard.writeText(fullUrl);
    } catch {
      showToast('Could not create share link.');
    }
  }

  function escHtml(s: string) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function exportStory() {
    if (!story) return;
    const content = story.blendedText || story.chapters.map(c => c.content).join('\n\n');
    const title = `${draft?.offering.name || 'Story'} — ${mediumLabel}`;

    const html = `<!DOCTYPE html>
<html><head><title>${escHtml(title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 700px; margin: 40px auto; padding: 20px; color: #1d1d1f; }
  h1 { font-size: 18px; color: #6e6e73; margin-bottom: 8px; }
  .meta { font-size: 14px; color: #6e6e73; margin-bottom: 24px; }
  .content { font-size: 16px; line-height: 1.7; white-space: pre-wrap; }
  .export-bar { background: #f5f5f7; border-radius: 8px; padding: 12px 20px; margin-bottom: 20px; font-size: 13px; color: #6e6e73; display: flex; justify-content: space-between; align-items: center; gap: 16px; }
  .export-bar span { color: #1d1d1f; font-weight: 500; }
  .save-pdf-btn { background: #007aff; color: #fff; border: none; border-radius: 6px; padding: 8px 18px; font-size: 14px; font-weight: 500; cursor: pointer; white-space: nowrap; }
  .save-pdf-btn:hover { background: #0066d6; }
  @media print { body { margin: 0; } .export-bar { display: none; } }
</style></head><body>
<div class="export-bar">
  <div>
    <button class="save-pdf-btn" onclick="window.print()">Save as PDF</button>
  </div>
  <div style="text-align:right;">
    <div>If the button doesn\u2019t work: <span>Mac</span> \u2318P \u2192 Save as PDF &nbsp; <span>iPad</span> Share \u2192 Print</div>
    <button onclick="this.closest('.export-bar').style.display='none'" style="background:none;border:none;cursor:pointer;font-size:14px;color:#aeaeb2;margin-top:2px;">Dismiss</button>
  </div>
</div>
<h1>${escHtml(title)}</h1>
<div class="meta">${escHtml(draft?.audience.name || '')} &middot; CTA: ${escHtml(story.cta)}</div>
<div style="font-size:13px;color:#aeaeb2;margin-bottom:16px;">Exported ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</div>
<div class="content">${renderLightMarkdown(content)}</div>
</body></html>`;

    const win = window.open('', '_blank');
    if (!win) { showToast('Export blocked — please allow popups for this site.'); return; }
    win.document.write(html); win.document.close();
  }

  if (loading) return <div className="loading-screen"><Spinner size={32} /></div>;
  if (!draft) return null;

  const allChaptersGenerated = story ? story.chapters.length === 5 : false;
  const mediumLabel = (() => {
    const std = MEDIUM_OPTIONS.find(m => m.id === story?.medium);
    if (std) return std.label;
    const raw = story?.medium || '';
    const short = raw.split(/\s*[—.]\s*/)[0].trim();
    return short.length > 35 ? short.substring(0, 32) + '...' : short;
  })();

  return (
    <div className="five-chapter-shell">
      <h1 style={{ marginBottom: 4 }}>Five Chapter Story</h1>
      <p className="page-description" style={{ marginBottom: 20 }}>
        {draft.offering.name} &rarr; {draft.audience.name}
      </p>

      {/* Story selector — only if multiple stories */}
      {stories.length > 1 && !showCreateForm && (
        <div className="fcs-story-selector">
          {(() => {
            const mediumCounts = new Map<string, number>();
            const mediumTotals = new Map<string, number>();
            for (const st of stories) {
              mediumTotals.set(st.medium, (mediumTotals.get(st.medium) || 0) + 1);
            }
            return stories.map(s => {
              const count = (mediumCounts.get(s.medium) || 0) + 1;
              mediumCounts.set(s.medium, count);
              const total = mediumTotals.get(s.medium) || 1;
              const stdLabel = MEDIUM_OPTIONS.find(m => m.id === s.medium);
              const baseLabel = stdLabel ? stdLabel.label : (() => { const sh = s.medium.split(/\s*[—.]\s*/)[0].trim(); return sh.length > 35 ? sh.substring(0, 32) + '...' : sh; })();
              const label = total > 1 ? `${baseLabel} #${count}` : baseLabel;
              return (
                <div key={s.id} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
                  {renamingStoryId === s.id ? (
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={e => setRenameValue(e.target.value)}
                      onBlur={() => renameStory(s.id, renameValue)}
                      onKeyDown={e => { if (e.key === 'Enter') renameStory(s.id, renameValue); if (e.key === 'Escape') setRenamingStoryId(null); }}
                      style={{ fontSize: 13, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--accent)', width: 140 }}
                    />
                  ) : (
                    <button
                      className={`btn btn-sm ${story?.id === s.id ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => setStory(s)}
                      onDoubleClick={() => { setRenamingStoryId(s.id); setRenameValue(s.customName || label); }}
                      onTouchStart={(e) => { const t = setTimeout(() => { e.preventDefault(); setRenamingStoryId(s.id); setRenameValue(s.customName || label); }, 600); (e.target as any)._lp = t; }}
                      onTouchEnd={(e) => { if ((e.target as any)._lp) clearTimeout((e.target as any)._lp); }}
                      onTouchMove={(e) => { if ((e.target as any)._lp) clearTimeout((e.target as any)._lp); }}
                      title="Double-click or long-press to rename"
                      style={s.customName && s.customName !== label ? { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: 1.2, padding: '6px 12px' } : undefined}
                    >
                      {s.customName && s.customName !== label ? (
                        <>
                          <span>{s.customName}</span>
                          <span style={{ fontSize: 10, opacity: 0.7, fontWeight: 400 }}>{baseLabel}</span>
                        </>
                      ) : (
                        s.customName || label
                      )}
                    </button>
                  )}
                  {stories.length > 1 && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setConfirmDeleteStory(s.id); }}
                      style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 14, padding: '0 4px', marginLeft: 2 }}
                      title="Delete deliverable"
                    >&times;</button>
                  )}
                </div>
              );
            });
          })()}
          <button className="btn btn-ghost btn-sm" onClick={() => setShowCreateForm(true)}>
            + New Deliverable
          </button>
        </div>
      )}

      {/* Parameters bar — editable controls */}
      {story && !showCreateForm && (
        <div className="fcs-params-bar">
          {/* Medium — clickable dropdown */}
          <div className="fcs-param-editable" style={{ position: 'relative' }}>
            {editingParam === 'medium' ? (
              <div className="fcs-param-dropdown">
                {MEDIUM_OPTIONS.map(opt => (
                  <button
                    key={opt.id}
                    className={`fcs-param-dropdown-item ${story.medium === opt.id ? 'active' : ''}`}
                    onClick={() => updateStoryParam('medium', opt.id)}
                  >
                    {opt.label}
                  </button>
                ))}
                <button className="fcs-param-dropdown-item dismiss" onClick={() => setEditingParam(null)}>Cancel</button>
              </div>
            ) : (
              <span className="fcs-param-clickable" onClick={() => setEditingParam('medium')}>
                <strong>{mediumLabel}</strong>
              </span>
            )}
          </div>

          <span className="fcs-param-sep">&middot;</span>

          {/* CTA — inline edit */}
          <div className="fcs-param-editable">
            {editingParam === 'cta' ? (
              <input
                className="fcs-param-input"
                value={editCta}
                onChange={e => setEditCta(e.target.value)}
                onBlur={() => { if (editCta.trim()) updateStoryParam('cta', editCta.trim()); else setEditingParam(null); }}
                onKeyDown={e => {
                  if (e.key === 'Enter' && editCta.trim()) updateStoryParam('cta', editCta.trim());
                  if (e.key === 'Escape') setEditingParam(null);
                }}
                autoFocus
              />
            ) : (
              <span className="fcs-param-clickable" onClick={() => { setEditCta(story.cta); setEditingParam('cta'); }}>
                CTA: {story.cta}
              </span>
            )}
          </div>

          <span className="fcs-param-sep">&middot;</span>

          {/* Emphasis — clickable dropdown */}
          <div className="fcs-param-editable" style={{ position: 'relative' }}>
            {editingParam === 'emphasis' ? (
              <div className="fcs-param-dropdown">
                <button className={`fcs-param-dropdown-item ${!story.emphasis ? 'active' : ''}`} onClick={() => updateStoryParam('emphasis', '')}>None</button>
                {[1, 2, 3, 4, 5].map(n => (
                  <button key={n} className={`fcs-param-dropdown-item ${story.emphasis === `ch${n}` ? 'active' : ''}`} onClick={() => updateStoryParam('emphasis', `ch${n}`)}>
                    Ch {n}
                  </button>
                ))}
                <button className="fcs-param-dropdown-item dismiss" onClick={() => setEditingParam(null)}>Cancel</button>
              </div>
            ) : (
              <span className="fcs-param-clickable" onClick={() => setEditingParam('emphasis')}>
                Emphasis: {story.emphasis ? story.emphasis.replace('ch', 'Ch ') : 'None'}
              </span>
            )}
          </div>

          <div style={{ flex: 1 }} />
          {stories.length <= 1 && (
            <button className="btn btn-ghost btn-sm" onClick={() => setShowCreateForm(true)}>
              + New Deliverable
            </button>
          )}
        </div>
      )}

      {/* Regenerate prompt after param change */}
      {paramsChanged && story && !showCreateForm && (
        <div className="fcs-params-changed">
          <span>Parameters changed</span>
          <button className="btn btn-primary btn-sm" onClick={regenerateAfterParamChange}>Regenerate?</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setParamsChanged(false)}>&times;</button>
        </div>
      )}

      {/* Create form — inline, not modal */}
      {(!story || showCreateForm) && (
        <div className="story-input-form">
          <h2>New Deliverable</h2>
          {draft && allDrafts.length > 0 && (() => {
            // Unique audiences that have completed Three Tiers
            const audiences = [...new Map(allDrafts.map(d => [d.audienceId, { id: d.audienceId, name: d.audienceName }])).values()];
            // Offerings available for the current audience
            const offeringsForAudience = allDrafts.filter(d => d.audienceId === draft.audienceId);
            return (
              <div style={{ marginBottom: 20 }}>
                <div className="form-group" style={{ marginBottom: 12 }}>
                  <label>Audience</label>
                  <select
                    value={draft.audienceId}
                    onChange={e => {
                      const firstDraft = allDrafts.find(d => d.audienceId === e.target.value);
                      if (firstDraft) navigate(`/five-chapter/${firstDraft.id}`);
                    }}
                  >
                    {audiences.map(a => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group" style={{ marginBottom: 12 }}>
                  <label>Offering</label>
                  <select
                    value={draftId}
                    onChange={e => navigate(`/five-chapter/${e.target.value}`)}
                  >
                    {offeringsForAudience.map(o => (
                      <option key={o.id} value={o.id}>{o.offeringName}</option>
                    ))}
                  </select>
                </div>
              </div>
            );
          })()}
          <p className="step-description">Pick a format. Maria writes the Five Chapter story to fit.</p>
          <form onSubmit={createStory}>
            <div className="form-group">
              <label>Content Format</label>
              <div className="medium-grid">
                {MEDIUM_OPTIONS.map(opt => (
                  <button
                    key={opt.id}
                    type="button"
                    className={`medium-option ${medium === opt.id ? 'medium-selected' : ''}`}
                    onClick={() => setMedium(opt.id)}
                  >
                    <strong>{opt.label}</strong>
                    <span className="medium-desc">{opt.description}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="form-group">
              <label>Call to Action <InfoTooltip text="What you want your audience to do after reading — like scheduling a demo or starting a trial." /></label>
              <textarea
                value={cta}
                onChange={e => setCta(e.target.value)}
                placeholder="e.g. Schedule a demo, Start a free trial, Visit our website"
                required
                rows={1}
                ref={el => { if (el) { el.style.height = 'auto'; el.style.height = Math.max(44, el.scrollHeight) + 'px'; } }}
                onInput={e => { const t = e.currentTarget; t.style.height = 'auto'; t.style.height = Math.max(44, t.scrollHeight) + 'px'; }}
                style={{ resize: 'none', minHeight: 44, lineHeight: 1.4, fontFamily: 'inherit' }}
              />
            </div>
            <div className="form-group">
              <label>Chapter Emphasis (optional)</label>
              <p style={{ fontSize: 13, color: 'var(--text-tertiary)', margin: '0 0 6px' }}>
                Shifts weight toward one chapter. Most people leave this on None.
              </p>
              <select value={emphasis} onChange={e => setEmphasis(e.target.value)}>
                <option value="">None — balanced across all chapters</option>
                <option value="ch1">Ch 1: The Need — emphasize urgency</option>
                <option value="ch2">Ch 2: Our Value — emphasize differentiation</option>
                <option value="ch3">Ch 3: Support — emphasize trust</option>
                <option value="ch4">Ch 4: Proof — emphasize evidence</option>
                <option value="ch5">Ch 5: Action — emphasize CTA</option>
              </select>
            </div>
            <div className="modal-actions">
              {stories.length > 0 && (
                <button type="button" className="btn btn-ghost" onClick={() => setShowCreateForm(false)}>Cancel</button>
              )}
              {!stories.length && (
                <button type="button" className="btn btn-ghost" onClick={() => navigate(`/three-tier/${draftId}`)}>Back to Three Tier</button>
              )}
              <button type="submit" className="btn btn-primary" disabled={creating || !cta}>
                {creating ? 'Creating...' : 'Create Deliverable'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Missing driver panel */}
      {showMFPanel && (
        <div className="mf-panel">
          <p className="mf-panel-intro">
            Maria needs one more thing before writing: why does <strong>{draft.audience.priorities[0]?.text}</strong> matter so much to this person? That context shapes the story.
          </p>
          <p className="mf-panel-offer">
            You can explain it yourself, or let Maria take her best informed guess from what she knows about this kind of audience. You can always change it later.
          </p>
          <div className="mf-panel-actions">
            <button
              className="btn btn-primary"
              onClick={() => {
                setShowMFPanel(false);
                document.dispatchEvent(new CustomEvent('maria-toggle', {
                  detail: { open: true, message: `Let's talk about why "${draft.audience.priorities[0]?.text}" matters so much to ${draft.audience.name}. I'll add what I learn to the motivating factor.` },
                }));
              }}
              disabled={derivingMF}
            >
              I'll explain it
            </button>
            <button
              className="btn btn-secondary"
              onClick={deriveMotivation}
              disabled={derivingMF}
            >
              {derivingMF ? <><Spinner size={14} /> Researching...</> : 'Let Maria take an informed guess'}
            </button>
          </div>
          <p className="mf-panel-note">
            Maria's guess is based on what she knows about this kind of audience and offering. If she misses the mark, you can refine it.
          </p>
        </div>
      )}

      {/* All 5 chapters */}
      {story && !showCreateForm && (
        <div className="fcs-chapters">
          {/* Progressive toolbar — buttons appear based on story stage */}
          <div className="fcs-chapters-header">
            {/* Stage 1: Generate / Regenerate */}
            <button
              className="btn btn-primary btn-sm"
              onClick={() => {
                if (allChaptersGenerated) { setConfirmRegenerateAll(true); return; }
                generateAllChapters();
              }}
              disabled={generating || blending || polishing || personalizing}
            >
              {generating ? <><Spinner size={12} /> Generating...</> : allChaptersGenerated ? 'Regenerate All' : 'Generate All Chapters'}
            </button>

            {/* Combine Chapters — instant, no AI. Available once chapters exist, hidden once blended */}
            {allChaptersGenerated && !story.blendedText && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={combineChapters}
                disabled={generating || blending || polishing || personalizing}
              >
                {story.joinedText
                  ? <>View Combined <InfoTooltip text="The five chapters joined together as-is. Nothing rewritten." /></>
                  : <>Combine Chapters <InfoTooltip text="Joins your five chapters into one document so you can read them together. Nothing is rewritten." /></>
                }
              </button>
            )}

            {/* Blend into Story — AI rewrite with transitions. Available once chapters exist */}
            {allChaptersGenerated && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => { if (story.blendedText) { setShowCompleteDraft(true); setChaptersCollapsed(true); } else { blendStory(); } }}
                disabled={generating || blending || polishing || personalizing}
              >
                {blending
                  ? <><Spinner size={12} /> Blending...</>
                  : story.blendedText
                    ? <>View Blended Story <InfoTooltip text="Shows the blended version of your story — chapters rewritten as one flowing piece." /></>
                    : <>Blend into Story <InfoTooltip text="Rewrites your chapters into one flowing piece with transitions between ideas. This is your draft to edit. Takes a moment." /></>
                }
              </button>
            )}

            {/* Polish — available after blending */}
            {story.blendedText && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={polishStory}
                disabled={generating || blending || polishing || personalizing}
              >
                {polishing ? <><Spinner size={12} /> Polishing...</> : <>Polish <InfoTooltip text="Takes the time to improve flow and tone. A little longer, but usually results in a better deliverable." /></>}
              </button>
            )}

            {/* Stage 4: Personalize — available after blending */}
            {story.blendedText && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={handlePersonalize}
                disabled={generating || blending || polishing || personalizing}
              >
                {personalizing
                  ? <><Spinner size={12} /> Personalizing...</>
                  : <>Personalize <InfoTooltip text="Revises the text, including applying your personal style." /></>
                }
              </button>
            )}
          </div>

          {/* Result banners — brief, dismissable */}
          {polishImproved && (
            <div style={{ padding: '10px 16px', marginBottom: 12, background: 'var(--success-light, #e8f5e9)', borderRadius: 'var(--radius)', fontSize: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Polished. Use the version history to compare before and after.</span>
              <button className="btn btn-ghost btn-sm" onClick={() => setPolishImproved(false)} style={{ flexShrink: 0 }}>&times;</button>
            </div>
          )}

          {personalizeResults && (
            <div style={{ padding: '10px 16px', marginBottom: 12, background: 'var(--info-light, #e3f2fd)', borderRadius: 'var(--radius)', fontSize: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Personalized. Use the version history to compare before and after.</span>
              <button className="btn btn-ghost btn-sm" onClick={() => setPersonalizeResults(null)} style={{ flexShrink: 0 }}>&times;</button>
            </div>
          )}

          {/* Chapter disclosure — one thin row when collapsed, full cards when expanded */}
          {chaptersCollapsed && allChaptersGenerated && (
            <button
              onClick={() => setChaptersCollapsed(false)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '10px 16px',
                marginBottom: 16,
                background: 'var(--bg-secondary, #f8f8fa)',
                borderRadius: 'var(--radius-sm, 6px)',
                border: '1px solid var(--border-light, #e5e5ea)',
                cursor: 'pointer',
                fontSize: 14,
                color: 'var(--text-primary)',
                textAlign: 'left',
              }}
            >
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)', transition: 'transform 0.15s' }}>▶</span>
              <span style={{ fontWeight: 500 }}>Chapters</span>
            </button>
          )}

          {!chaptersCollapsed && (story.joinedText || story.blendedText) && allChaptersGenerated && (
            <button
              onClick={() => setChaptersCollapsed(true)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '10px 16px',
                marginBottom: 12,
                background: 'var(--bg-secondary, #f8f8fa)',
                borderRadius: 'var(--radius-sm, 6px)',
                border: '1px solid var(--border-light, #e5e5ea)',
                cursor: 'pointer',
                fontSize: 14,
                color: 'var(--text-primary)',
                textAlign: 'left',
              }}
            >
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>▼</span>
              <span style={{ fontWeight: 500 }}>Chapters</span>
            </button>
          )}

          {!chaptersCollapsed && CHAPTER_CRITERIA.map((ch, idx) => {
            const chapterContent = story.chapters.find(c => c.chapterNum === ch.num);
            const isGenerating = generatingChapter === ch.num;
            const isEditing = editingChapter === ch.num;

            return (
              <div
                key={ch.num}
                className={`fcs-chapter-card ${chapterContent ? 'has-content' : ''} ${isGenerating ? 'generating' : ''}`}
                ref={el => { chapterRefs.current[idx] = el; }}
                style={isGenerating ? { position: 'relative' } : undefined}
              >
                <div className="fcs-chapter-header">
                  <span className="fcs-chapter-num">{ch.num}</span>
                  <h3 className="fcs-chapter-name">{ch.name}</h3>
                  <InfoTooltip text={`Audience should think: "${ch.audienceThinks}"`} />
                  <div style={{ flex: 1 }} />
                  {chapterContent && (
                    <ChapterVersionNav
                      chapterContentId={chapterContent.id}
                      onRestore={(content) => {
                        setStory(prev => {
                          if (!prev) return prev;
                          const chapters = prev.chapters.map(c =>
                            c.chapterNum === ch.num ? { ...c, content } : c
                          );
                          return { ...prev, chapters };
                        });
                      }}
                    />
                  )}
                  {chapterContent && !isEditing && !generating && (
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => regenerateChapter(ch.num)}
                      disabled={isGenerating}
                      title={`Rewrite chapter ${ch.num} only`}
                    >
                      {isGenerating ? <><Spinner size={12} /> Rewriting chapter {ch.num}...</> : `Regenerate Ch ${ch.num}`}
                    </button>
                  )}
                </div>

                {isGenerating && chapterContent && (
                  <div style={{
                    position: 'absolute',
                    inset: 0,
                    background: 'rgba(255,255,255,0.6)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    fontSize: 13,
                    color: 'var(--text-secondary)',
                    zIndex: 2,
                    borderRadius: 'var(--radius-md)',
                    pointerEvents: 'none',
                  }}>
                    <Spinner size={16} />
                    <span>Rewriting chapter {ch.num} only — other chapters unchanged</span>
                  </div>
                )}

                {isGenerating && !chapterContent && (
                  <div className="fcs-chapter-loading">
                    <Spinner size={16} />
                    <span>Writing chapter {ch.num}...</span>
                  </div>
                )}

                {chapterContent && isEditing ? (
                  <div className="fcs-chapter-edit">
                    <textarea
                      ref={el => { if (el) { el.style.height = 'auto'; el.style.height = Math.max(48, el.scrollHeight) + 'px'; } }}
                      value={editText}
                      onChange={e => { setEditText(e.target.value); const t = e.target; t.style.height = 'auto'; t.style.height = Math.max(48, t.scrollHeight) + 'px'; }}
                      onBlur={() => saveChapterEdit(ch.num)}
                    />
                    <div className="fcs-chapter-edit-actions">
                      <button className="btn btn-ghost btn-sm" onClick={() => setEditingChapter(null)}>Cancel</button>
                    </div>
                  </div>
                ) : chapterContent ? (
                  <div
                    className="fcs-chapter-content"
                    onClick={() => { setEditingChapter(ch.num); setEditText(chapterContent.content); }}
                    dangerouslySetInnerHTML={{ __html: renderLightMarkdown(chapterContent.content) }}
                  />
                ) : !isGenerating ? (
                  <div className="fcs-chapter-empty">
                    Not yet generated
                  </div>
                ) : null}
              </div>
            );
          })}

          {/* Combined text — full view when no blend yet, collapsible disclosure after blend */}
          {story.joinedText && story.blendedText && (
            <button
              onClick={() => setCombinedCollapsed(!combinedCollapsed)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '10px 16px',
                marginBottom: 12,
                background: 'var(--bg-secondary, #f8f8fa)',
                borderRadius: 'var(--radius-sm, 6px)',
                border: '1px solid var(--border-light, #e5e5ea)',
                cursor: 'pointer',
                fontSize: 14,
                color: 'var(--text-primary)',
                textAlign: 'left',
              }}
            >
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{combinedCollapsed ? '▶' : '▼'}</span>
              <span style={{ fontWeight: 500 }}>Combined</span>
            </button>
          )}

          {story.joinedText && !combinedCollapsed && (
            <div className="fcs-blended" style={{ marginBottom: 16 }}>
              {!story.blendedText && (
                <div className="fcs-blended-header">
                  <h3>Combined Chapters</h3>
                  <button className="copy-btn" onClick={() => copyToClipboard(story.joinedText)}>Copy</button>
                </div>
              )}
              <div
                className="fcs-blended-content"
                style={{ cursor: 'default' }}
                dangerouslySetInnerHTML={{ __html: renderLightMarkdown(story.joinedText) }}
              />
            </div>
          )}

          {/* Stage snapshot disclosure rows — one for each user action (Blended, Polished, Personalized) */}
          {stageSnapshots.map((snap, idx) => (
            <div key={`${snap.label}-${idx}`}>
              <button
                onClick={() => setStageSnapshots(prev => prev.map((s, i) => i === idx ? { ...s, collapsed: !s.collapsed } : s))}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                  padding: '10px 16px', marginBottom: snap.collapsed ? 12 : 0,
                  background: 'var(--bg-secondary, #f8f8fa)', borderRadius: 'var(--radius-sm, 6px)',
                  border: '1px solid var(--border-light, #e5e5ea)', cursor: 'pointer',
                  fontSize: 14, color: 'var(--text-primary)', textAlign: 'left',
                }}
              >
                <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{snap.collapsed ? '▶' : '▼'}</span>
                <span style={{ fontWeight: 500 }}>{snap.label}</span>
              </button>
              {!snap.collapsed && (
                <div className="fcs-blended" style={{ marginBottom: 16, marginTop: 4 }}>
                  <div className="fcs-blended-content" style={{ cursor: 'default' }}
                    dangerouslySetInnerHTML={{ __html: renderLightMarkdown(snap.text) }}
                  />
                </div>
              )}
            </div>
          ))}

          {/* Active story text */}
          {showCompleteDraft && story.blendedText && (
            <div className="fcs-blended">
              <div className="fcs-blended-header">
                <h3>{blendedStage === 'personalized' ? 'Personalized Story' : blendedStage === 'polished' ? 'Polished Story' : 'Blended Story'}</h3>
                <BlendedVersionNav storyId={story.id} storyVersion={story.version} onRestore={loadData} />
                <button className="copy-btn" onClick={() => copyToClipboard(story.blendedText)}>Copy</button>
                <button className="copy-btn" onClick={exportStory} title="Open printable version">Export</button>
                <button className="copy-btn" onClick={shareStory} title="Create shareable read-only link">Share</button>
              </div>
                  {shareUrl && (
                    <div style={{ padding: '6px 12px', fontSize: 14, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span>Link copied!</span>
                      <code style={{ fontSize: 13, background: 'var(--bg-secondary, #f5f5f7)', padding: '4px 8px', borderRadius: 4 }}>{shareUrl}</code>
                      <button className="btn btn-ghost btn-sm" onClick={() => setShareUrl(null)} style={{ minWidth: 32, minHeight: 32 }}>&times;</button>
                    </div>
                  )}
                  {editingBlended ? (
                    <div className="fcs-chapter-edit">
                      <textarea
                        ref={el => { if (el) { el.style.height = 'auto'; el.style.height = Math.max(200, el.scrollHeight) + 'px'; } }}
                        value={editContent}
                        onChange={e => { setEditContent(e.target.value); const t = e.target; t.style.height = 'auto'; t.style.height = Math.max(200, t.scrollHeight) + 'px'; }}
                        onBlur={saveBlendedEdit}
                      />
                      <div className="fcs-chapter-edit-actions">
                        <button className="btn btn-ghost btn-sm" onClick={() => setEditingBlended(false)}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div
                      className="fcs-blended-content"
                      onClick={() => { setEditingBlended(true); setEditContent(story.blendedText); }}
                      dangerouslySetInnerHTML={{ __html: renderLightMarkdown(story.blendedText) }}
                    />
                  )}

                  {/* Copy edit */}
                  <div className="fcs-copy-edit">
                    <textarea
                      value={copyEditInput}
                      onChange={e => {
                        setCopyEditInput(e.target.value);
                        const t = e.currentTarget;
                        t.style.height = 'auto';
                        t.style.height = Math.min(Math.max(44, t.scrollHeight), 160) + 'px';
                      }}
                      placeholder="Tell Maria what to change — e.g. 'Make it shorter' or 'More emphasis on security'"
                      onKeyDown={e => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          copyEdit();
                        }
                      }}
                      rows={1}
                      style={{ resize: 'none', minHeight: 44, fontFamily: 'inherit', lineHeight: 1.4 }}
                    />
                    <button className="btn btn-secondary btn-sm" onClick={copyEdit} disabled={copyEditing || !copyEditInput.trim()}>
                      {copyEditing ? <Spinner size={12} /> : 'Edit'}
                    </button>
                  </div>
                </div>
          )}
        </div>
      )}

      {story && !showCreateForm && (
        <>
          {/* What's next — only show when user has viewed complete draft */}
          {story.blendedText && showCompleteDraft && (
            <div style={{
              marginTop: 24,
              padding: '16px 20px',
              background: 'var(--bg-secondary, #f8f8fa)',
              borderRadius: 'var(--radius-md, 10px)',
              border: '1px solid var(--border-light, #e5e5ea)',
            }}>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 10px', lineHeight: 1.6 }}>
                Your new {mediumLabel?.toLowerCase()} draft is done. If your next deliverable is related, e.g., a landing page for that {mediumLabel?.toLowerCase()}, you can build on your work and go straight to a new deliverable format.
              </p>
              <button className="btn btn-secondary btn-sm" onClick={() => { setSourceStoryIdForCreate(story.id); setShowCreateForm(true); }}>
                Draft the Next Piece
              </button>
            </div>
          )}

          <div style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between' }}>
            <button className="btn btn-ghost" onClick={() => navigate(`/three-tier/${draftId}`)}>Back to Three Tier</button>
            <button className="btn btn-ghost" onClick={() => navigate('/')}>Dashboard</button>
          </div>
        </>
      )}

      <ConfirmModal
        open={confirmBlendReplace}
        onClose={() => setConfirmBlendReplace(false)}
        onConfirm={doBlendStory}
        title="Replace complete draft?"
        message="This will replace your current complete draft."
        confirmLabel="Replace"
        confirmDanger
      />

      <ConfirmModal
        open={confirmRegenerateAll}
        onClose={() => setConfirmRegenerateAll(false)}
        onConfirm={() => generateAllChapters()}
        title="Regenerate all chapters?"
        message="This will replace the current content of all 5 chapters."
        confirmLabel="Regenerate"
        confirmDanger
      />

      <ConfirmModal
        open={!!conflictConfirm}
        onClose={() => setConflictConfirm(null)}
        onConfirm={() => { conflictConfirm?.onDiscard(); setConflictConfirm(null); }}
        title="Editing conflict"
        message="This story was edited by someone else. Reload with their changes, or cancel to keep editing your version."
        confirmLabel="Reload"
        confirmDanger={false}
      />
      <ConfirmModal
        open={!!confirmDeleteStory}
        onClose={() => setConfirmDeleteStory(null)}
        onConfirm={() => confirmDeleteStory && deleteStory(confirmDeleteStory)}
        title="Delete this deliverable?"
        message="This will permanently delete this deliverable and all its chapters. This cannot be undone."
        confirmLabel="Delete"
        confirmDanger
      />
    </div>
  );
}
