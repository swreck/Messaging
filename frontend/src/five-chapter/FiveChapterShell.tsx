import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { Spinner } from '../shared/Spinner';
import { InfoTooltip } from '../shared/InfoTooltip';
import { ChapterVersionNav } from '../shared/ChapterVersionNav';
import { BlendedVersionNav } from '../shared/BlendedVersionNav';
import { useMaria } from '../shared/MariaContext';
import type { ThreeTierDraft, FiveChapterStory, ChapterContent, StoryMedium } from '../types';
import { CHAPTER_CRITERIA, MEDIUM_OPTIONS } from '../types';

export function FiveChapterShell() {
  const { draftId } = useParams<{ draftId: string }>();
  const navigate = useNavigate();
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

  // Generation
  const [generatingChapter, setGeneratingChapter] = useState<number | null>(null);
  const [generating, setGenerating] = useState(false);

  // Blending
  const [blending, setBlending] = useState(false);

  // Inline editing
  const [editingChapter, setEditingChapter] = useState<number | null>(null);
  const [editText, setEditText] = useState('');
  const [editingBlended, setEditingBlended] = useState(false);
  const [editContent, setEditContent] = useState('');

  // Copy edit
  const [copyEditInput, setCopyEditInput] = useState('');
  const [copyEditing, setCopyEditing] = useState(false);

  // Missing MF panel
  const [showMFPanel, setShowMFPanel] = useState(false);
  const [derivingMF, setDerivingMF] = useState(false);
  const [bypassMF, setBypassMF] = useState(false);
  // Track AI-derived MFs for future display markers
  const [, setAiDerivedMFs] = useState<Set<string>>(new Set());

  // Share
  const [shareUrl, setShareUrl] = useState<string | null>(null);

  // Post-generation orientation messages
  const [chaptersJustGenerated, setChaptersJustGenerated] = useState(false);
  const [blendJustGenerated, setBlendJustGenerated] = useState(false);

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
      const { stories: s } = await api.get<{ stories: FiveChapterStory[] }>(`/stories?draftId=${draftId}`);
      setStories(s);
      if (s.length > 0 && !story) setStory(s[0]);
    } catch {
      navigate('/');
    } finally {
      setLoading(false);
    }
  }

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
      });
      setStories(prev => [s, ...prev]);
      setStory(s);
      setShowCreateForm(false);
      setCta('');
      setEmphasis('');
    } catch (err: any) {
      alert(err.message);
    } finally {
      setCreating(false);
    }
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
        const { chapter } = await api.post<{ chapter: ChapterContent }>('/ai/generate-chapter', {
          storyId: story.id,
          chapterNum: i,
        });
        setStory(prev => {
          if (!prev) return prev;
          const chapters = prev.chapters.filter(c => c.chapterNum !== i);
          chapters.push(chapter);
          chapters.sort((a, b) => a.chapterNum - b.chapterNum);
          return { ...prev, chapters };
        });
        // Scroll to the chapter that just generated
        setTimeout(() => {
          chapterRefs.current[i - 1]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 100);
      }
    } catch (err: any) {
      alert(err.message);
    } finally {
      setGenerating(false);
      setGeneratingChapter(null);
      setChaptersJustGenerated(true);
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
      alert(err.message);
    } finally {
      setGeneratingChapter(null);
    }
  }

  async function blendStory() {
    if (!story) return;
    if (story.blendedText && story.blendedText.trim()) {
      if (!window.confirm('This will replace your current final draft. Continue?')) return;
    }
    setBlending(true);
    try {
      const { story: updated } = await api.post<{ story: FiveChapterStory }>('/ai/blend-story', {
        storyId: story.id,
      });
      setStory(updated);
      setBlendJustGenerated(true);
      setChaptersJustGenerated(false);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setBlending(false);
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
        const discard = window.confirm('This story was edited by someone else. Click OK to reload with their changes, or Cancel to keep editing your version.');
        if (discard) {
          setEditingChapter(null);
          loadData();
        }
      } else {
        alert(err.message);
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
        const discard = window.confirm('This story was edited by someone else. Click OK to reload with their changes, or Cancel to keep editing your version.');
        if (discard) {
          setEditingBlended(false);
          loadData();
        }
      } else {
        alert(err.message);
      }
    }
  }

  async function copyEdit() {
    if (!story || !copyEditInput.trim()) return;
    setCopyEditing(true);
    try {
      const content = story.blendedText || story.chapters.map(c => c.content).join('\n\n');
      const { content: revised } = await api.post<{ content: string }>('/ai/copy-edit', {
        storyId: story.id,
        content,
        request: copyEditInput.trim(),
      });
      if (story.blendedText) {
        const { story: updated } = await api.put<{ story: FiveChapterStory }>(`/stories/${story.id}`, { blendedText: revised, version: story.version });
        setStory(updated);
      }
      setCopyEditInput('');
    } catch (err: any) {
      alert(err.message);
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
      alert(err.message);
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
        alert('This story was edited elsewhere. Refreshing to show the latest version.');
        setEditingParam(null);
        loadData();
      } else {
        alert(err.message);
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
      alert('Could not create share link.');
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
  @media print { body { margin: 0; } }
</style></head><body>
<h1>${escHtml(title)}</h1>
<div class="meta">${escHtml(draft?.audience.name || '')} &middot; CTA: ${escHtml(story.cta)}</div>
<div style="font-size:13px;color:#aeaeb2;margin-bottom:16px;">Exported ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</div>
<div class="content">${escHtml(content)}</div>
</body></html>`;

    const win = window.open('', '_blank');
    if (!win) { alert('Export blocked — please allow popups for this site.'); return; }
    win.document.write(html); win.document.close();
  }

  if (loading) return <div className="loading-screen"><Spinner size={32} /></div>;
  if (!draft) return null;

  const allChaptersGenerated = story ? story.chapters.length === 5 : false;
  const mediumLabel = MEDIUM_OPTIONS.find(m => m.id === story?.medium)?.label || story?.medium;

  return (
    <div className="five-chapter-shell">
      <h1 style={{ marginBottom: 4 }}>Five Chapter Story</h1>
      <p className="page-description" style={{ marginBottom: 20 }}>
        {draft.offering.name} &rarr; {draft.audience.name}
      </p>

      {/* Story selector — only if multiple stories */}
      {stories.length > 1 && !showCreateForm && (
        <div className="fcs-story-selector">
          {stories.map(s => {
            const label = MEDIUM_OPTIONS.find(m => m.id === s.medium)?.label || s.medium;
            return (
              <button
                key={s.id}
                className={`btn btn-sm ${story?.id === s.id ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setStory(s)}
              >
                {label}
              </button>
            );
          })}
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
          <h2>{stories.length > 0 ? 'New Deliverable' : 'Turn Your Three Tier Into Something'}</h2>
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
              <input value={cta} onChange={e => setCta(e.target.value)} placeholder="e.g. Schedule a demo, Start a free trial, Visit our website" required />
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

      {/* Missing motivating factor panel */}
      {showMFPanel && (
        <div className="mf-panel">
          <p className="mf-panel-intro">
            A motivating factor is <strong>why</strong> something matters to your audience. It helps make messages more compelling.
          </p>
          <p className="mf-panel-offer">
            Your top priority — <strong>{draft.audience.priorities[0]?.text}</strong> — doesn't have one yet.
          </p>
          <div className="mf-panel-actions">
            <button
              className="btn btn-primary"
              onClick={deriveMotivation}
              disabled={derivingMF}
            >
              {derivingMF ? <><Spinner size={14} /> Thinking...</> : 'Go ahead and guess'}
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => { setShowMFPanel(false); setBypassMF(true); }}
            >
              Continue without it
            </button>
          </div>
          <p className="mf-panel-note">
            Maria can make her best guess, but she might miss something important. You can always refine it later.
          </p>
        </div>
      )}

      {/* All 5 chapters */}
      {story && !showCreateForm && (
        <div className="fcs-chapters">
          <div className="fcs-chapters-header">
            <button
              className="btn btn-primary btn-sm"
              onClick={() => generateAllChapters()}
              disabled={generating}
            >
              {generating ? <><Spinner size={12} /> Generating...</> : allChaptersGenerated ? 'Regenerate All' : 'Generate All Chapters'}
            </button>
          </div>

          {CHAPTER_CRITERIA.map((ch, idx) => {
            const chapterContent = story.chapters.find(c => c.chapterNum === ch.num);
            const isGenerating = generatingChapter === ch.num;
            const isEditing = editingChapter === ch.num;

            return (
              <div
                key={ch.num}
                className={`fcs-chapter-card ${chapterContent ? 'has-content' : ''} ${isGenerating ? 'generating' : ''}`}
                ref={el => { chapterRefs.current[idx] = el; }}
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
                      disabled={!!generatingChapter}
                    >
                      Regenerate
                    </button>
                  )}
                </div>

                {isGenerating && !chapterContent && (
                  <div className="fcs-chapter-loading">
                    <Spinner size={16} />
                    <span>Writing chapter {ch.num}...</span>
                  </div>
                )}

                {chapterContent && isEditing ? (
                  <div className="fcs-chapter-edit">
                    <textarea
                      value={editText}
                      onChange={e => setEditText(e.target.value)}
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
                  >
                    {chapterContent.content}
                  </div>
                ) : !isGenerating ? (
                  <div className="fcs-chapter-empty">
                    Not yet generated
                  </div>
                ) : null}
              </div>
            );
          })}

          {/* Post-generation orientation: chapters */}
          {chaptersJustGenerated && allChaptersGenerated && !story.blendedText && (
            <div style={{
              padding: '14px 18px',
              marginBottom: 12,
              background: 'var(--bg-secondary, #f8f8fa)',
              borderRadius: 'var(--radius-sm, 6px)',
              border: '1px solid var(--border-light, #e5e5ea)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              gap: 12,
            }}>
              <p style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-secondary)', margin: 0 }}>
                All five chapters are drafted. Click any to edit. <strong>Create Final Draft</strong> blends them into one piece with transitions.
              </p>
              <button onClick={() => setChaptersJustGenerated(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', fontSize: 16, padding: '0 4px', flexShrink: 0 }}>&times;</button>
            </div>
          )}

          {/* Blend section */}
          {allChaptersGenerated && !generating && (
            <div className="fcs-blend-section">
              {!story.blendedText ? (
                <button
                  className="btn btn-primary"
                  onClick={blendStory}
                  disabled={blending}
                  style={{ width: '100%' }}
                  title="Combine all chapters into one polished narrative with transitions"
                >
                  {blending ? <><Spinner size={14} /> Creating final draft...</> : 'Create Final Draft'}
                </button>
              ) : (
                <div className="fcs-blended">
                  <div className="fcs-blended-header">
                    <h3>Final Draft</h3>
                    <BlendedVersionNav storyId={story.id} onRestore={loadData} />
                    <button className="copy-btn" onClick={() => copyToClipboard(story.blendedText)}>Copy</button>
                    <button className="copy-btn" onClick={exportStory} title="Open printable version">Export</button>
                    <button className="copy-btn" onClick={shareStory} title="Create shareable read-only link">Share</button>
                  </div>
                  {blendJustGenerated && (
                    <div style={{
                      padding: '12px 16px',
                      marginBottom: 8,
                      background: 'var(--bg-secondary, #f8f8fa)',
                      borderRadius: 'var(--radius-sm, 6px)',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                      gap: 12,
                    }}>
                      <p style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-secondary)', margin: 0 }}>
                        Blended into one {mediumLabel?.toLowerCase() || 'piece'}. Click to edit directly, or use the box below to tell Maria what to change.
                      </p>
                      <button onClick={() => setBlendJustGenerated(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', fontSize: 16, padding: '0 4px', flexShrink: 0 }}>&times;</button>
                    </div>
                  )}
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
                        value={editContent}
                        onChange={e => setEditContent(e.target.value)}
                        onBlur={saveBlendedEdit}
                        style={{ minHeight: 300 }}
                      />
                      <div className="fcs-chapter-edit-actions">
                        <button className="btn btn-ghost btn-sm" onClick={() => setEditingBlended(false)}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div
                      className="fcs-blended-content"
                      onClick={() => { setEditingBlended(true); setEditContent(story.blendedText); }}
                    >
                      {story.blendedText}
                    </div>
                  )}

                  {/* Copy edit */}
                  <div className="fcs-copy-edit">
                    <input
                      value={copyEditInput}
                      onChange={e => setCopyEditInput(e.target.value)}
                      placeholder="Ask Maria to edit... e.g. 'Make it shorter' or 'More emphasis on security'"
                      onKeyDown={e => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && copyEdit()}
                    />
                    <button className="btn btn-secondary btn-sm" onClick={copyEdit} disabled={copyEditing || !copyEditInput.trim()}>
                      {copyEditing ? <Spinner size={12} /> : 'Edit'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {story && !showCreateForm && (
        <>
          {/* What's next — only show when story has been blended */}
          {story.blendedText && (
            <div style={{
              marginTop: 24,
              padding: '16px 20px',
              background: 'var(--bg-secondary, #f8f8fa)',
              borderRadius: 'var(--radius-md, 10px)',
              border: '1px solid var(--border-light, #e5e5ea)',
            }}>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 10px', lineHeight: 1.6 }}>
                Your {mediumLabel?.toLowerCase()} is done, but you're still in the flow. If your next deliverable is related — say, the landing page that email links to — you can draft it now and it'll stay tightly unified with what you just built.
              </p>
              <button className="btn btn-secondary btn-sm" onClick={() => setShowCreateForm(true)}>
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
    </div>
  );
}
