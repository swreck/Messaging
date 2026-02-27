import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { Spinner } from '../shared/Spinner';
import { InfoTooltip } from '../shared/InfoTooltip';
import type { ThreeTierDraft, FiveChapterStory, ChapterContent } from '../types';
import { CHAPTER_CRITERIA } from '../types';

export function FiveChapterShell() {
  const { draftId } = useParams<{ draftId: string }>();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<ThreeTierDraft | null>(null);
  const [story, setStory] = useState<FiveChapterStory | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeChapter, setActiveChapter] = useState(1);

  // Input form
  const [medium, setMedium] = useState<'15s' | '1m' | '5m'>('1m');
  const [cta, setCta] = useState('');
  const [emphasis, setEmphasis] = useState('');
  const [creating, setCreating] = useState(false);

  // Generation
  const [generating, setGenerating] = useState(false);
  const [blending, setBlending] = useState(false);

  // Refinement
  const [refineInput, setRefineInput] = useState('');
  const [refining, setRefining] = useState(false);

  // Edit mode
  const [editingChapter, setEditingChapter] = useState<number | null>(null);
  const [editText, setEditText] = useState('');

  useEffect(() => {
    if (draftId) loadData();
  }, [draftId]);

  async function loadData() {
    setLoading(true);
    try {
      const { draft: d } = await api.get<{ draft: ThreeTierDraft }>(`/drafts/${draftId}`);
      setDraft(d);
      const { stories } = await api.get<{ stories: FiveChapterStory[] }>(`/stories?draftId=${draftId}`);
      if (stories.length > 0) setStory(stories[0]);
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
      setStory(s);
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

  function copyStory() {
    if (!story?.blendedText) return;
    navigator.clipboard.writeText(story.blendedText);
  }

  if (loading) return <div className="loading-screen"><Spinner size={32} /></div>;
  if (!draft) return null;

  const currentChapter = story?.chapters.find(c => c.chapterNum === activeChapter);

  return (
    <div className="five-chapter-shell">
      <h1 style={{ marginBottom: 8 }}>Five Chapter Story</h1>
      <p style={{ marginBottom: 24 }}>
        {draft.offering.name} → {draft.audience.name}
      </p>

      {/* Story creation form or story viewer */}
      {!story ? (
        <div className="story-input-form">
          <h2>Create a Story</h2>
          <p className="step-description">Configure your Five Chapter Story. The Three Tier table will be used as the foundation.</p>
          <form onSubmit={createStory}>
            <div className="form-group">
              <label>Medium</label>
              <select value={medium} onChange={e => setMedium(e.target.value as any)}>
                <option value="15s">15 seconds (~40 words)</option>
                <option value="1m">1 minute (~150 words)</option>
                <option value="5m">5 minutes (~750 words)</option>
              </select>
            </div>
            <div className="form-group">
              <label>Call to Action</label>
              <input value={cta} onChange={e => setCta(e.target.value)} placeholder="e.g. Schedule a demo, Start a free trial, Visit our website" required />
            </div>
            <div className="form-group">
              <label>Emphasis (optional)</label>
              <input value={emphasis} onChange={e => setEmphasis(e.target.value)} placeholder="e.g. Focus on security, Emphasize cost savings" />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => navigate('/')}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={creating || !cta}>
                {creating ? 'Creating...' : 'Create Story'}
              </button>
            </div>
          </form>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <button className="btn btn-primary btn-sm" onClick={generateAllChapters} disabled={generating}>
              {generating ? <><Spinner size={12} /> Generating...</> : 'Generate All Chapters'}
            </button>
            {story.chapters.length === 5 && (
              <button className="btn btn-secondary btn-sm" onClick={blendStory} disabled={blending}>
                {blending ? <><Spinner size={12} /> Blending...</> : 'Blend into Story'}
              </button>
            )}
          </div>

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
            {story.blendedText && (
              <button
                className={`chapter-tab${activeChapter === 0 ? ' active' : ''}`}
                onClick={() => setActiveChapter(0)}
              >
                Blended Story
              </button>
            )}
          </div>

          {/* Blended story view */}
          {activeChapter === 0 && story.blendedText && (
            <div className="blended-story">
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
                <h3>Blended Story ({story.medium})</h3>
                <button className="copy-btn" onClick={copyStory}>Copy Story</button>
              </div>
              <div className="blended-story-text">{story.blendedText}</div>
            </div>
          )}

          {/* Chapter panel */}
          {activeChapter > 0 && (
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
                                onKeyDown={e => e.key === 'Enter' && refineChapter()}
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
