import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { Spinner } from '../shared/Spinner';
import { InfoTooltip } from '../shared/InfoTooltip';
import type { ThreeTierDraft, FiveChapterStory, ChapterContent, StoryMedium } from '../types';
import { CHAPTER_CRITERIA, MEDIUM_OPTIONS } from '../types';

export function FiveChapterShell() {
  const { draftId } = useParams<{ draftId: string }>();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<ThreeTierDraft | null>(null);
  const [stories, setStories] = useState<FiveChapterStory[]>([]);
  const [story, setStory] = useState<FiveChapterStory | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeChapter, setActiveChapter] = useState(1);

  // Input form
  const [medium, setMedium] = useState<StoryMedium>('email');
  const [cta, setCta] = useState('');
  const [emphasis, setEmphasis] = useState('');
  const [creating, setCreating] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);

  // Generation
  const [generating, setGenerating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [blending, setBlending] = useState(false);

  // Refinement
  const [refineInput, setRefineInput] = useState('');
  const [refining, setRefining] = useState(false);

  // Copy edit
  const [copyEditInput, setCopyEditInput] = useState('');
  const [copyEditing, setCopyEditing] = useState(false);

  // Edit mode
  const [editingChapter, setEditingChapter] = useState<number | null>(null);
  const [editText, setEditText] = useState('');
  const [editingJoined, setEditingJoined] = useState(false);
  const [editingBlended, setEditingBlended] = useState(false);
  const [editContent, setEditContent] = useState('');

  useEffect(() => {
    if (draftId) loadData();
  }, [draftId]);

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

  async function generateChapter(chapterNum: number) {
    if (!story) return;
    setGenerating(true);
    try {
      const { chapter } = await api.post<{ chapter: ChapterContent }>('/ai/generate-chapter', {
        storyId: story.id,
        chapterNum,
      });
      setStory(prev => {
        if (!prev) return prev;
        const chapters = prev.chapters.filter(c => c.chapterNum !== chapterNum);
        chapters.push(chapter);
        chapters.sort((a, b) => a.chapterNum - b.chapterNum);
        return { ...prev, chapters };
      });
    } catch (err: any) {
      alert(err.message);
    } finally {
      setGenerating(false);
    }
  }

  async function generateAllChapters() {
    if (!story) return;
    setGenerating(true);
    try {
      for (let i = 1; i <= 5; i++) {
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
      }
    } catch (err: any) {
      alert(err.message);
    } finally {
      setGenerating(false);
    }
  }

  async function joinChapters() {
    if (!story) return;
    setJoining(true);
    try {
      const { story: updated } = await api.post<{ story: FiveChapterStory }>('/ai/join-chapters', {
        storyId: story.id,
      });
      setStory(updated);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setJoining(false);
    }
  }

  async function blendStory() {
    if (!story) return;
    setBlending(true);
    try {
      const { story: updated } = await api.post<{ story: FiveChapterStory }>('/ai/blend-story', {
        storyId: story.id,
      });
      setStory(updated);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setBlending(false);
    }
  }

  async function refineChapter() {
    if (!story || !refineInput.trim()) return;
    setRefining(true);
    try {
      const { chapter } = await api.post<{ chapter: ChapterContent }>('/ai/refine-chapter', {
        storyId: story.id,
        chapterNum: activeChapter,
        feedback: refineInput.trim(),
      });
      setStory(prev => {
        if (!prev) return prev;
        const chapters = prev.chapters.map(c => c.chapterNum === activeChapter ? chapter : c);
        return { ...prev, chapters };
      });
      setRefineInput('');
    } catch (err: any) {
      alert(err.message);
    } finally {
      setRefining(false);
    }
  }

  async function saveChapterEdit() {
    if (!story || editingChapter === null) return;
    await api.put(`/stories/${story.id}/chapters/${editingChapter}`, { content: editText });
    setStory(prev => {
      if (!prev) return prev;
      const chapters = prev.chapters.map(c =>
        c.chapterNum === editingChapter ? { ...c, content: editText } : c
      );
      return { ...prev, chapters };
    });
    setEditingChapter(null);
  }

  async function saveTextEdit(field: 'joinedText' | 'blendedText') {
    if (!story) return;
    await api.put(`/stories/${story.id}`, { [field]: editContent });
    setStory(prev => prev ? { ...prev, [field]: editContent } : prev);
    setEditingJoined(false);
    setEditingBlended(false);
  }

  async function copyEdit() {
    if (!story || !copyEditInput.trim()) return;
    setCopyEditing(true);
    try {
      // Determine which content to send based on current view
      let currentContent = '';
      if (story.stage === 'blended' && story.blendedText) {
        currentContent = story.blendedText;
      } else if (story.stage === 'joined' && story.joinedText) {
        currentContent = story.joinedText;
      } else {
        const ch = story.chapters.find(c => c.chapterNum === activeChapter);
        currentContent = ch?.content || '';
      }

      const { content: revised } = await api.post<{ content: string }>('/ai/copy-edit', {
        storyId: story.id,
        content: currentContent,
        request: copyEditInput.trim(),
      });

      // Apply the revised content to the right place
      if (story.stage === 'blended' && story.blendedText) {
        await api.put(`/stories/${story.id}`, { blendedText: revised });
        setStory(prev => prev ? { ...prev, blendedText: revised } : prev);
      } else if (story.stage === 'joined' && story.joinedText) {
        await api.put(`/stories/${story.id}`, { joinedText: revised });
        setStory(prev => prev ? { ...prev, joinedText: revised } : prev);
      } else {
        await api.put(`/stories/${story.id}/chapters/${activeChapter}`, { content: revised });
        setStory(prev => {
          if (!prev) return prev;
          const chapters = prev.chapters.map(c =>
            c.chapterNum === activeChapter ? { ...c, content: revised } : c
          );
          return { ...prev, chapters };
        });
      }
      setCopyEditInput('');
    } catch (err: any) {
      alert(err.message);
    } finally {
      setCopyEditing(false);
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
  }

  function goBackStage() {
    if (!story) return;
    if (story.stage === 'blended') {
      setStory(prev => prev ? { ...prev, stage: 'joined' } : prev);
    } else if (story.stage === 'joined') {
      setStory(prev => prev ? { ...prev, stage: 'chapters' } : prev);
    }
  }

  if (loading) return <div className="loading-screen"><Spinner size={32} /></div>;
  if (!draft) return null;

  const currentChapter = story?.chapters.find(c => c.chapterNum === activeChapter);
  const allChaptersGenerated = story ? story.chapters.length === 5 : false;
  const mediumLabel = MEDIUM_OPTIONS.find(m => m.id === story?.medium)?.label || story?.medium;

  return (
    <div className="five-chapter-shell">
      <h1 style={{ marginBottom: 8 }}>Five Chapter Story</h1>
      <p style={{ marginBottom: 16 }}>
        {draft.offering.name} &rarr; {draft.audience.name}
      </p>

      {/* Story selector + create */}
      {stories.length > 0 && !showCreateForm && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          {stories.map(s => {
            const label = MEDIUM_OPTIONS.find(m => m.id === s.medium)?.label || s.medium;
            return (
              <button
                key={s.id}
                className={`btn btn-sm ${story?.id === s.id ? 'btn-primary' : 'btn-ghost'}`}
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

      {/* Story creation form */}
      {(!story || showCreateForm) && (
        <div className="story-input-form">
          <h2>{stories.length > 0 ? 'New Deliverable' : 'Create a Deliverable'}</h2>
          <p className="step-description">Select a content format and configure your Five Chapter Story. The Three Tier table provides the foundation.</p>
          <form onSubmit={createStory}>
            <div className="form-group">
              <label>Content Format</label>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
                {MEDIUM_OPTIONS.map(opt => (
                  <button
                    key={opt.id}
                    type="button"
                    className={`btn btn-sm ${medium === opt.id ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => setMedium(opt.id)}
                    style={{ textAlign: 'left', padding: '10px 14px' }}
                  >
                    <strong>{opt.label}</strong>
                    <div style={{ fontSize: 12, color: medium === opt.id ? 'inherit' : 'var(--text-secondary)', marginTop: 2 }}>
                      {opt.description}
                    </div>
                  </button>
                ))}
              </div>
            </div>
            <div className="form-group">
              <label>Call to Action</label>
              <input value={cta} onChange={e => setCta(e.target.value)} placeholder="e.g. Schedule a demo, Start a free trial, Visit our website" required />
            </div>
            <div className="form-group">
              <label>Chapter Emphasis (optional)</label>
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
              <button type="button" className="btn btn-ghost" onClick={() => navigate(`/three-tier/${draftId}`)}>Back to Three Tier</button>
              <button type="submit" className="btn btn-primary" disabled={creating || !cta}>
                {creating ? 'Creating...' : 'Create Deliverable'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Story viewer */}
      {story && !showCreateForm && (
        <>
          {/* Stage indicator and actions */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              {mediumLabel} &middot; Stage: {story.stage === 'chapters' ? 'Chapters' : story.stage === 'joined' ? 'Joined' : 'Blended'}
            </span>
            <div style={{ flex: 1 }} />
            {story.stage === 'chapters' && (
              <>
                <button className="btn btn-primary btn-sm" onClick={generateAllChapters} disabled={generating}>
                  {generating ? <><Spinner size={12} /> Generating...</> : allChaptersGenerated ? 'Regenerate All' : 'Generate All Chapters'}
                </button>
                {allChaptersGenerated && (
                  <button className="btn btn-secondary btn-sm" onClick={joinChapters} disabled={joining}>
                    {joining ? <><Spinner size={12} /> Joining...</> : 'Join Chapters'}
                  </button>
                )}
              </>
            )}
            {story.stage === 'joined' && (
              <>
                <button className="btn btn-ghost btn-sm" onClick={goBackStage}>Back to Chapters</button>
                <button className="btn btn-primary btn-sm" onClick={blendStory} disabled={blending}>
                  {blending ? <><Spinner size={12} /> Blending...</> : 'Blend into Story'}
                </button>
              </>
            )}
            {story.stage === 'blended' && (
              <>
                <button className="btn btn-ghost btn-sm" onClick={goBackStage}>Back to Joined</button>
                <button className="copy-btn" onClick={() => copyToClipboard(story.blendedText)}>Copy Story</button>
              </>
            )}
          </div>

          {/* STAGE: Chapters */}
          {story.stage === 'chapters' && (
            <>
              {/* Chapter tabs */}
              <div className="chapter-tabs">
                {CHAPTER_CRITERIA.map((ch) => {
                  const hasContent = story.chapters.some(c => c.chapterNum === ch.num);
                  return (
                    <button
                      key={ch.num}
                      className={`chapter-tab${activeChapter === ch.num ? ' active' : ''}${hasContent ? ' has-content' : ''}`}
                      onClick={() => setActiveChapter(ch.num)}
                    >
                      {ch.num}. {ch.name}
                    </button>
                  );
                })}
              </div>

              {/* Chapter panel */}
              <div className="chapter-panel">
                {(() => {
                  const ch = CHAPTER_CRITERIA[activeChapter - 1];
                  return (
                    <>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                        <h3>{ch.name}</h3>
                        <InfoTooltip text={`Goal: ${ch.goal} | Outcome: ${ch.outcome} | Success: "${ch.audienceThinks}"`} />
                      </div>

                      <div className="chapter-info">
                        <div className="chapter-info-item">
                          <div className="chapter-info-label">Goal</div>
                          <div>{ch.goal}</div>
                        </div>
                        <div className="chapter-info-item">
                          <div className="chapter-info-label">Outcome</div>
                          <div>{ch.outcome}</div>
                        </div>
                        <div className="chapter-info-item">
                          <div className="chapter-info-label">Audience should think</div>
                          <div style={{ fontStyle: 'italic' }}>"{ch.audienceThinks}"</div>
                        </div>
                      </div>

                      {currentChapter ? (
                        <div className="chapter-content">
                          {editingChapter === activeChapter ? (
                            <>
                              <textarea
                                value={editText}
                                onChange={e => setEditText(e.target.value)}
                                style={{ minHeight: 300 }}
                              />
                              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                                <button className="btn btn-ghost btn-sm" onClick={() => setEditingChapter(null)}>Cancel</button>
                                <button className="btn btn-primary btn-sm" onClick={saveChapterEdit}>Save</button>
                              </div>
                            </>
                          ) : (
                            <>
                              <div
                                style={{ whiteSpace: 'pre-wrap', cursor: 'text', minHeight: 100, padding: 16 }}
                                onClick={() => { setEditingChapter(activeChapter); setEditText(currentChapter.content); }}
                              >
                                {currentChapter.content}
                              </div>
                              <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
                                <input
                                  value={refineInput}
                                  onChange={e => setRefineInput(e.target.value)}
                                  placeholder="Give feedback to refine this chapter..."
                                  style={{ flex: 1, padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontSize: 14 }}
                                  onKeyDown={e => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && refineChapter()}
                                />
                                <button className="btn btn-secondary btn-sm" onClick={refineChapter} disabled={refining || !refineInput.trim()}>
                                  {refining ? <Spinner size={12} /> : 'Refine'}
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      ) : (
                        <div style={{ textAlign: 'center', padding: '40px 0' }}>
                          <p style={{ marginBottom: 16 }}>This chapter hasn't been generated yet.</p>
                          <button className="btn btn-primary" onClick={() => generateChapter(activeChapter)} disabled={generating}>
                            {generating ? <><Spinner size={14} /> Generating...</> : `Generate Chapter ${activeChapter}`}
                          </button>
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            </>
          )}

          {/* STAGE: Joined */}
          {story.stage === 'joined' && story.joinedText && (
            <div className="joined-text-view" style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius)', padding: 24 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
                <h3>Joined Story ({mediumLabel})</h3>
                <button className="copy-btn" onClick={() => copyToClipboard(story.joinedText)}>Copy</button>
              </div>
              {editingJoined ? (
                <>
                  <textarea
                    value={editContent}
                    onChange={e => setEditContent(e.target.value)}
                    style={{ minHeight: 400, width: '100%', fontFamily: 'inherit', fontSize: 14, padding: 12, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}
                  />
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditingJoined(false)}>Cancel</button>
                    <button className="btn btn-primary btn-sm" onClick={() => saveTextEdit('joinedText')}>Save</button>
                  </div>
                </>
              ) : (
                <div
                  style={{ whiteSpace: 'pre-wrap', cursor: 'text', lineHeight: 1.7, fontSize: 15 }}
                  onClick={() => { setEditingJoined(true); setEditContent(story.joinedText); }}
                >
                  {story.joinedText}
                </div>
              )}
            </div>
          )}

          {/* STAGE: Blended */}
          {story.stage === 'blended' && story.blendedText && (
            <div className="blended-text-view" style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius)', padding: 24 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
                <h3>Final Story ({mediumLabel})</h3>
                <button className="copy-btn" onClick={() => copyToClipboard(story.blendedText)}>Copy</button>
              </div>
              {editingBlended ? (
                <>
                  <textarea
                    value={editContent}
                    onChange={e => setEditContent(e.target.value)}
                    style={{ minHeight: 400, width: '100%', fontFamily: 'inherit', fontSize: 14, padding: 12, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}
                  />
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditingBlended(false)}>Cancel</button>
                    <button className="btn btn-primary btn-sm" onClick={() => saveTextEdit('blendedText')}>Save</button>
                  </div>
                </>
              ) : (
                <div
                  style={{ whiteSpace: 'pre-wrap', cursor: 'text', lineHeight: 1.7, fontSize: 15 }}
                  onClick={() => { setEditingBlended(true); setEditContent(story.blendedText); }}
                >
                  {story.blendedText}
                </div>
              )}
            </div>
          )}

          {/* Copy edit input — available at all stages */}
          {story && (story.chapters.length > 0 || story.joinedText || story.blendedText) && (
            <div style={{ display: 'flex', gap: 8, marginTop: 16, alignItems: 'center' }}>
              <input
                value={copyEditInput}
                onChange={e => setCopyEditInput(e.target.value)}
                placeholder="Ask Maria to edit... e.g. 'Make it shorter' or 'More emphasis on security'"
                style={{ flex: 1, padding: '10px 14px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontSize: 14 }}
                onKeyDown={e => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && copyEdit()}
              />
              <button className="btn btn-secondary btn-sm" onClick={copyEdit} disabled={copyEditing || !copyEditInput.trim()}>
                {copyEditing ? <Spinner size={12} /> : 'Edit'}
              </button>
            </div>
          )}
        </>
      )}

      <div style={{ marginTop: 24, display: 'flex', justifyContent: 'space-between' }}>
        <button className="btn btn-ghost" onClick={() => navigate(`/three-tier/${draftId}`)}>Back to Three Tier</button>
        <button className="btn btn-ghost" onClick={() => navigate('/')}>Dashboard</button>
      </div>
    </div>
  );
}
