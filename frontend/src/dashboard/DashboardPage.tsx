import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { Spinner } from '../shared/Spinner';
import { useMaria } from '../shared/MariaContext';
import { useWorkspace } from '../shared/WorkspaceContext';
import { LEAD_TOGGLE_EVENT } from '../shared/leadershipDetection';
import { PATH_A_BANNER } from '../shared/milestoneCopy';
import { MobileHomeAffordances } from '../shared/MobileHomeAffordances';
import { MOBILE_HOME_BREAKPOINT_PX } from '../shared/breakpoints';
import { useAuth } from '../auth/AuthContext';
import type { Offering, Audience } from '../types';

interface HierarchyOffering {
  id: string;
  name: string;
  elementCount: number;
  audiences: {
    id: string;
    name: string;
    threeTier: {
      id: string;
      status: string;
      currentStep: number;
      updatedAt: string;
      tier1Text: string | null;
    };
    deliverables: { id: string; medium: string; stage: string; updatedAt: string }[];
  }[];
}

interface ActiveDraft {
  draftId: string;
  offeringName: string;
  audienceName: string;
  currentStep: number;
  status: string;
  tier1Text: string | null;
  updatedAt: string;
  deliverableCount: number;
}

export function DashboardPage() {
  const navigate = useNavigate();
  const { activeWorkspace } = useWorkspace();
  const { user } = useAuth();
  const firstName = user?.firstName || user?.displayName;
  const [hierarchy, setHierarchy] = useState<HierarchyOffering[]>([]);
  const [offerings, setOfferings] = useState<Offering[]>([]);
  const [audiences, setAudiences] = useState<Audience[]>([]);
  const [loading, setLoading] = useState(true);
  const [consultation, setConsultation] = useState(() => {
    try {
      const saved = localStorage.getItem('maria-consultation');
      return saved === null ? true : saved === 'on';
    } catch { return true; }
  });
  const [recentSearch, setRecentSearch] = useState('');
  const [recentTab, setRecentTab] = useState<'all' | 'inProgress' | 'complete'>('all');
  const [recentAudience, setRecentAudience] = useState<string>('');
  const [recentSort, setRecentSort] = useState<'recent' | 'oldest' | 'offeringAZ' | 'audienceAZ'>('recent');
  const [recentDateRange, setRecentDateRange] = useState<'any' | '7' | '30' | '90'>('any');
  // Cowork follow-up #4 — once Maria has greeted the user even once, the
  // home-screen welcome card with the "Let's start" button should never
  // show again. We check both the introduced flag (set after the first
  // chat-open opener fires) and the partner history (any assistant
  // message means Maria has spoken to this user). Either signal suffices.
  const [welcomeSuppressed, setWelcomeSuppressed] = useState<boolean | null>(null);

  // Phase 2 — Fix 4: hide the dashboard's consultation toggle bar on small
  // screens. The toggle moves into the chat-panel header (MariaPartner) so
  // the iPhone home renders only the two affordance buttons + tiles.
  const [isSmallScreen, setIsSmallScreen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth <= MOBILE_HOME_BREAKPOINT_PX;
  });
  useEffect(() => {
    function update() {
      setIsSmallScreen(window.innerWidth <= MOBILE_HOME_BREAKPOINT_PX);
    }
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  const { setPageContext, registerRefresh } = useMaria();
  useEffect(() => { setPageContext({ page: 'dashboard' }); registerRefresh(loadAll); }, []);
  useEffect(() => { loadAll(); }, []);

  useEffect(() => {
    if (!user) return;
    api.get<{ introduced?: boolean }>('/partner/status')
      .then(s => {
        if (s.introduced) { setWelcomeSuppressed(true); return; }
        return api.get<{ messages: { role: string }[] }>('/partner/history')
          .then(h => {
            setWelcomeSuppressed((h.messages || []).some(m => m.role === 'assistant'));
          });
      })
      .catch(() => setWelcomeSuppressed(false));
  }, [user]);

  // Listen for toggle promotions from chat. When Maria flips the "Let Maria lead"
  // default in response to a user's in-chat request, the switch here should
  // visibly move so the toggle stays truthful.
  useEffect(() => {
    function onToggleChanged(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (detail?.value === 'on' || detail?.value === 'off') {
        setConsultation(detail.value === 'on');
      }
    }
    document.addEventListener(LEAD_TOGGLE_EVENT, onToggleChanged);
    return () => document.removeEventListener(LEAD_TOGGLE_EVENT, onToggleChanged);
  }, []);

  async function loadAll(retries = 2) {
    setLoading(true);
    try {
      const [h, o, a] = await Promise.all([
        api.get<{ hierarchy: HierarchyOffering[] }>('/drafts/hierarchy'),
        api.get<{ offerings: Offering[] }>('/offerings'),
        api.get<{ audiences: Audience[] }>('/audiences'),
      ]);
      setHierarchy(h.hierarchy);
      setOfferings(o.offerings);
      setAudiences(a.audiences);
    } catch {
      if (retries > 0) {
        await new Promise(r => setTimeout(r, 1500));
        return loadAll(retries - 1);
      }
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <div className="loading-screen"><Spinner size={32} /></div>;

  const isNew = offerings.length === 0 && audiences.length === 0;

  // Flatten hierarchy into a list of all drafts, sorted by most recent
  const allDrafts: ActiveDraft[] = [];
  for (const offering of hierarchy) {
    for (const aud of offering.audiences) {
      allDrafts.push({
        draftId: aud.threeTier.id,
        offeringName: offering.name,
        audienceName: aud.name,
        currentStep: aud.threeTier.currentStep,
        status: aud.threeTier.status,
        tier1Text: aud.threeTier.tier1Text,
        updatedAt: aud.threeTier.updatedAt,
        deliverableCount: aud.deliverables.length,
      });
    }
  }
  allDrafts.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  const inProgressAll = allDrafts.filter(d => d.status !== 'complete' && d.currentStep < 5);
  const completedAll = allDrafts.filter(d => d.status === 'complete' || d.currentStep === 5);
  const mostRecent = inProgressAll[0] || null;

  // Unified Recent Work pipeline — tab → search → audience → date range → sort.
  const q = recentSearch.trim().toLowerCase();
  const isDraftComplete = (d: ActiveDraft) => d.status === 'complete' || d.currentStep === 5;

  let workingList: ActiveDraft[] = [...allDrafts];
  if (recentTab === 'inProgress') workingList = workingList.filter(d => !isDraftComplete(d));
  else if (recentTab === 'complete') workingList = workingList.filter(isDraftComplete);
  if (q) workingList = workingList.filter(d => d.offeringName.toLowerCase().includes(q) || d.audienceName.toLowerCase().includes(q));
  if (recentAudience) workingList = workingList.filter(d => d.audienceName === recentAudience);
  if (recentDateRange !== 'any') {
    const days = parseInt(recentDateRange, 10);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    workingList = workingList.filter(d => new Date(d.updatedAt).getTime() >= cutoff);
  }
  if (recentSort === 'recent') workingList.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  else if (recentSort === 'oldest') workingList.sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
  else if (recentSort === 'offeringAZ') workingList.sort((a, b) => a.offeringName.localeCompare(b.offeringName));
  else if (recentSort === 'audienceAZ') workingList.sort((a, b) => a.audienceName.localeCompare(b.audienceName));

  const recentList = workingList;
  const uniqueAudiences = Array.from(new Set(allDrafts.map(d => d.audienceName))).sort();
  const showFilters = allDrafts.length >= 6;
  const anyFilterActive = !!q || !!recentAudience || recentDateRange !== 'any' || recentSort !== 'recent';

  function clearAllFilters() {
    setRecentSearch('');
    setRecentAudience('');
    setRecentSort('recent');
    setRecentDateRange('any');
  }

  function plainProgress(d: ActiveDraft): string {
    if (isDraftComplete(d)) return 'Complete';
    const step = d.currentStep;
    if (step <= 1) return 'Just started';
    if (step === 2) return 'Getting started';
    if (step === 3) return 'Halfway';
    if (step === 4) return 'Almost done';
    return `Step ${step}`;
  }

  // First Three Tier prompt — user has an offering and audience set up but no draft yet.
  // This closes the gap Ken hit: new users arrive on the dashboard and don't know where to start.
  const hasSetup = offerings.length > 0 && audiences.length > 0;
  const needsFirstThreeTier = hasSetup && allDrafts.length === 0;

  function formatTimeAgo(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return 'just now';
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return `${Math.floor(days / 7)}w ago`;
  }

  // Counts for nav tiles
  const audCount = audiences.length;
  const offCount = offerings.length;
  const ttCount = allDrafts.length;
  const fcsCount = allDrafts.reduce((sum, d) => sum + d.deliverableCount, 0);

  // Round 4 Fix 10 — toggleConsultation was the dashboard's flip handler.
  // Removed along with the dashboard toggle UI; the equivalent now lives
  // in MariaPartner.tsx as toggleConsultationFromPanel and runs at every
  // breakpoint. The dashboard's PATH_A_BANNER below still reads the
  // `consultation` state to render the off-state banner.

  return (
    <div className="dashboard">
      {/* Round 4 Fix 10 — toggle relocated to the chat-panel header at all
          breakpoints. The dashboard now keeps just the workspace name in
          this slot. The toggle lives in MariaPartner's header so it sits
          inside the Maria relationship rather than next to "Work with
          Maria" on the dashboard. */}
      {!isSmallScreen && activeWorkspace && (
        <div className="consultation-toggle-bar">
          <div className="consultation-toggle-left">
            <h2 className="dashboard-workspace-name" style={{ margin: 0 }}>{activeWorkspace.name}</h2>
          </div>
        </div>
      )}

      {/* Phase 2 — Redlines #10, #13, #14: iPhone-only home-screen affordances.
          The component renders nothing above MOBILE_HOME_BREAKPOINT_PX, so the
          desktop dashboard is untouched. On small layouts these two buttons sit
          right below the toggle bar; the rest of the dashboard tiles still
          render below for users who scroll. */}
      <MobileHomeAffordances mostRecentDraftId={mostRecent?.draftId} />

      {/* Round 4 Fix 10 Part B — Path A banner with the new locked text.
          Replaces the prior "You're driving. I'll wait until you ask."
          metaphor; new wording references the toggle by name so first-
          time users connect the banner to the affordance directly. */}
      {!consultation && (
        <div
          style={{
            background: 'var(--bg-secondary, #f5f5f7)',
            border: '1px solid var(--border-subtle, rgba(0,0,0,0.08))',
            borderRadius: 'var(--radius-md, 10px)',
            padding: '10px 16px',
            marginBottom: 16,
            fontSize: 14,
            color: 'var(--text-secondary)',
          }}
        >
          {PATH_A_BANNER}
        </div>
      )}

      {/* New user — Maria's voice, one forward button.
          Cowork follow-up #4: hidden once Maria has spoken to this user even
          once. introShown OR any prior assistant message in partner history
          flips welcomeSuppressed and this card never renders again. */}
      {isNew && welcomeSuppressed === false && (
        <div className="dashboard-welcome empty-state-enhanced">
          <div className="empty-icon">💬</div>
          <h3>{firstName ? `Hi ${firstName} — I'm Maria.` : `Hi, I'm Maria.`}</h3>
          <p>Tell me what you're working on and who needs to hear it. I'll help you land a clear message and a story you can use — whether you're selling, rallying your team, or persuading a partner.</p>
          <button
            className="btn btn-primary"
            onClick={() => navigate('/express')}
            style={{ marginTop: 12 }}
          >
            Let's start
          </button>
        </div>
      )}

      {/* First Three Tier prompt — setup is done, but no draft exists yet */}
      {needsFirstThreeTier && (
        <div
          className="dashboard-continue"
          onClick={() => navigate('/three-tiers')}
          style={{
            padding: '20px 22px',
            marginBottom: 20,
            background: 'var(--accent-light, #eaf4ff)',
            borderRadius: 'var(--radius-md, 10px)',
            border: '1px solid var(--accent, #007aff)',
            cursor: 'pointer',
            transition: 'box-shadow 0.15s',
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--accent, #007aff)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Start here
          </div>
          <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
            Build your first Three Tier message
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            You've got {offerings.length === 1 ? 'an offering' : `${offerings.length} offerings`} and {audiences.length === 1 ? 'an audience' : `${audiences.length} audiences`} set up. Tap here to pair one with another and let Maria draft the message.
          </div>
        </div>
      )}

      {/* Continue where you left off — only if there's an active draft */}
      {!isNew && mostRecent && (
        <div
          className="dashboard-continue"
          onClick={() => navigate(`/three-tier/${mostRecent.draftId}`)}
          style={{
            padding: '16px 20px',
            marginBottom: 20,
            background: 'var(--bg-secondary, #f8f8fa)',
            borderRadius: 'var(--radius-md, 10px)',
            border: '1px solid var(--border-light, #e5e5ea)',
            cursor: 'pointer',
            transition: 'border-color 0.15s',
          }}
          onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--accent, #007aff)')}
          onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border-light, #e5e5ea)')}
        >
          <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-tertiary)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Pick up where you left off
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)' }}>
            Message for {mostRecent.audienceName}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            about {mostRecent.offeringName}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 6 }}>
            {plainProgress(mostRecent)} · {formatTimeAgo(mostRecent.updatedAt)}
          </div>
        </div>
      )}

      {/* Nav tiles — compact when there's real content to show */}
      {!isNew && (
        <div className="nav-tiles">
          <div className="nav-tile nav-tile-audiences" onClick={() => navigate('/audiences')}>
            <div className="nav-tile-icon">👥</div>
            <div className="nav-tile-title">Audiences</div>
            <div className="nav-tile-sub">people you're writing to</div>
            <div className="nav-tile-stat">
              {audCount > 0 ? `${audCount}` : 'None yet'}
            </div>
          </div>

          <div className="nav-tile nav-tile-offerings" onClick={() => navigate('/offerings')}>
            <div className="nav-tile-icon">✨</div>
            <div className="nav-tile-title">Offerings</div>
            <div className="nav-tile-sub">what you offer</div>
            <div className="nav-tile-stat">
              {offCount > 0 ? `${offCount}` : 'None yet'}
            </div>
          </div>

          <div className="nav-tile nav-tile-three-tiers" onClick={() => navigate('/three-tiers')}>
            <div className="nav-tile-icon">💬</div>
            <div className="nav-tile-title">3 Tiers</div>
            <div className="nav-tile-sub">what you want to say</div>
            <div className="nav-tile-stat">
              {ttCount > 0 ? `${ttCount}` : 'None yet'}
            </div>
          </div>

          <div className="nav-tile nav-tile-five-chapters" onClick={() => navigate('/five-chapters')}>
            <div className="nav-tile-icon">📖</div>
            <div className="nav-tile-title">5 Ch. Stories</div>
            <div className="nav-tile-sub">how you tell it</div>
            <div className="nav-tile-stat">
              {fcsCount > 0 ? `${fcsCount}` : 'None yet'}
            </div>
          </div>
        </div>
      )}

      {/* Recent Work — unified list with tabs, filters, status pills */}
      {allDrafts.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px', margin: 0 }}>
              Recent work
            </h3>
            <button
              className="btn btn-ghost"
              onClick={() => {
                // Round 4 Fix 2 — fresh-start entry. Open the chat panel
                // with empty local message state so prior unrelated sessions
                // don't show through. The chat-open opener fires fresh after.
                document.dispatchEvent(new CustomEvent('maria-toggle', {
                  detail: { open: true, freshStart: true },
                }));
              }}
              style={{ fontSize: 13, color: 'var(--accent, #007aff)', padding: '4px 10px' }}
            >
              + New message
            </button>
          </div>

          {/* Tabs — All / In progress / Complete */}
          <div style={{ display: 'flex', gap: 4, marginBottom: showFilters ? 10 : 14, flexWrap: 'wrap' }}>
            {([
              { key: 'all', label: `All (${allDrafts.length})` },
              { key: 'inProgress', label: `In progress (${inProgressAll.length})` },
              { key: 'complete', label: `Complete (${completedAll.length})` },
            ] as const).map(tab => (
              <button
                key={tab.key}
                onClick={() => setRecentTab(tab.key)}
                style={{
                  padding: '6px 12px',
                  fontSize: 13,
                  fontWeight: recentTab === tab.key ? 600 : 500,
                  color: recentTab === tab.key ? 'var(--accent, #007aff)' : 'var(--text-secondary)',
                  background: recentTab === tab.key ? 'var(--accent-light, #eaf4ff)' : 'transparent',
                  border: `1px solid ${recentTab === tab.key ? 'var(--accent, #007aff)' : 'var(--border-light, #e5e5ea)'}`,
                  borderRadius: 6,
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Filters — search, audience, sort, date range */}
          {showFilters && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                type="text"
                placeholder="Find by offering or audience…"
                value={recentSearch}
                onChange={e => setRecentSearch(e.target.value)}
                style={{
                  flex: '1 1 200px',
                  minWidth: 160,
                  padding: '6px 10px',
                  fontSize: 13,
                  border: '1px solid var(--border-light, #e5e5ea)',
                  borderRadius: 6,
                  background: 'var(--bg-primary, #fff)',
                  color: 'var(--text-primary)',
                }}
              />
              <select
                value={recentAudience}
                onChange={e => setRecentAudience(e.target.value)}
                style={{
                  padding: '6px 10px',
                  fontSize: 13,
                  border: '1px solid var(--border-light, #e5e5ea)',
                  borderRadius: 6,
                  background: 'var(--bg-primary, #fff)',
                  color: 'var(--text-primary)',
                }}
                title="Filter by audience"
              >
                <option value="">Any audience</option>
                {uniqueAudiences.map(a => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
              <select
                value={recentSort}
                onChange={e => setRecentSort(e.target.value as typeof recentSort)}
                style={{
                  padding: '6px 10px',
                  fontSize: 13,
                  border: '1px solid var(--border-light, #e5e5ea)',
                  borderRadius: 6,
                  background: 'var(--bg-primary, #fff)',
                  color: 'var(--text-primary)',
                }}
                title="Sort order"
              >
                <option value="recent">Most recent</option>
                <option value="oldest">Oldest first</option>
                <option value="offeringAZ">Offering A–Z</option>
                <option value="audienceAZ">Audience A–Z</option>
              </select>
              <select
                value={recentDateRange}
                onChange={e => setRecentDateRange(e.target.value as typeof recentDateRange)}
                style={{
                  padding: '6px 10px',
                  fontSize: 13,
                  border: '1px solid var(--border-light, #e5e5ea)',
                  borderRadius: 6,
                  background: 'var(--bg-primary, #fff)',
                  color: 'var(--text-primary)',
                }}
                title="Date range"
              >
                <option value="any">Any time</option>
                <option value="7">Last 7 days</option>
                <option value="30">Last 30 days</option>
                <option value="90">Last 90 days</option>
              </select>
              {anyFilterActive && (
                <button
                  onClick={clearAllFilters}
                  style={{
                    padding: '6px 10px',
                    fontSize: 12,
                    color: 'var(--accent, #007aff)',
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                  }}
                >
                  Clear filters
                </button>
              )}
            </div>
          )}

          {/* Empty state when filters match nothing */}
          {recentList.length === 0 && (
            <div style={{
              padding: '24px 16px',
              textAlign: 'center',
              color: 'var(--text-secondary)',
              fontSize: 13,
              border: '1px dashed var(--border-light, #e5e5ea)',
              borderRadius: 'var(--radius-sm, 6px)',
              background: 'var(--bg-secondary, #f8f8fa)',
            }}>
              No messages match these filters.
              {anyFilterActive && (
                <button
                  onClick={clearAllFilters}
                  style={{ marginLeft: 8, color: 'var(--accent, #007aff)', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 13 }}
                >
                  Clear filters
                </button>
              )}
            </div>
          )}

          {/* Cards */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {recentList.map(d => {
              const isComplete = isDraftComplete(d);
              return (
                <div
                  key={d.draftId}
                  className="list-card"
                  onClick={() => navigate(`/three-tier/${d.draftId}`)}
                  style={{
                    // Bug B fix — .list-card defaults to flex row + center
                    // alignment, which collapses the stacked title/subtitle/
                    // preview/footer into one overlapping row. Override to a
                    // column so each region stacks cleanly at every width.
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'stretch',
                    padding: '14px 18px',
                    background: 'var(--bg-primary, #fff)',
                    borderRadius: 'var(--radius-sm, 6px)',
                    border: '1px solid var(--border-light, #e5e5ea)',
                    cursor: 'pointer',
                    transition: 'border-color 0.15s',
                  }}
                >
                  {/* Top row: status pill + deliverable count */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <span style={{
                      display: 'inline-block',
                      padding: '2px 8px',
                      fontSize: 11,
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      letterSpacing: '0.4px',
                      borderRadius: 4,
                      color: isComplete ? '#1a7f3c' : 'var(--text-secondary)',
                      background: isComplete ? '#e6f6ec' : 'var(--bg-secondary, #f0f0f2)',
                    }}>
                      {isComplete ? 'Complete' : 'In progress'}
                    </span>
                    {d.deliverableCount > 0 && (
                      <div
                        style={{ fontSize: 12, color: 'var(--accent, #007aff)', flexShrink: 0, marginLeft: 12, cursor: 'pointer' }}
                        onClick={e => { e.stopPropagation(); navigate(`/five-chapter/${d.draftId}`); }}
                      >
                        {d.deliverableCount} stor{d.deliverableCount === 1 ? 'y' : 'ies'} →
                      </div>
                    )}
                  </div>
                  {/* Title: Message for [audience] */}
                  <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.3 }}>
                    Message for {d.audienceName}
                  </div>
                  {/* Subtitle: about [offering] */}
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>
                    about {d.offeringName}
                  </div>
                  {/* Tier 1 preview */}
                  {d.tier1Text && (
                    <div style={{
                      fontSize: 13,
                      color: 'var(--text-secondary)',
                      marginTop: 8,
                      lineHeight: 1.5,
                    }}>
                      <span style={{ color: 'var(--text-tertiary)', fontStyle: 'normal' }}>First line so far: </span>
                      <span style={{ fontStyle: 'italic' }}>"{d.tier1Text}"</span>
                    </div>
                  )}
                  {/* Footer: plain progress + time */}
                  <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 8 }}>
                    {plainProgress(d)} · {formatTimeAgo(d.updatedAt)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
