import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useToast } from '../shared/ToastContext';

interface DemoAccount {
  userId: string;
  username: string;
  workspaceId: string | null;
  workspaceName: string;
  offeringCount: number;
  audienceCount: number;
  createdAt: string;
}

interface UsageRow {
  username: string;
  createdAt: string;
  lastActive: string;
  messageCount: number;
  offeringCount: number;
  audienceCount: number;
  storyCount: number;
  isDemo: boolean;
}

export function AdminPanel() {
  const { showToast } = useToast();
  const [demos, setDemos] = useState<DemoAccount[]>([]);
  const [, setTotalCreated] = useState(0);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [inviteName, setInviteName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviting, setInviting] = useState(false);
  const [lastInviteUrl, setLastInviteUrl] = useState('');

  async function loadDemos() {
    try {
      const { demos: d, totalCreated: t } = await api.get<{ demos: DemoAccount[]; totalCreated: number }>('/auth/demos');
      setDemos(d);
      setTotalCreated(t);
    } catch {}
  }

  async function loadUsage() {
    try {
      const { usage: u } = await api.get<{ usage: UsageRow[] }>('/auth/usage');
      setUsage(u);
    } catch {}
  }

  useEffect(() => { loadDemos(); loadUsage(); }, []);

  async function createDemo() {
    setCreating(true);
    try {
      const result = await api.post<{ username: string; password: string; workspaceName: string }>('/auth/demos', {});
      showToast(`Created ${result.username} / ${result.password}`);
      loadDemos();
    } catch { showToast('Could not create demo account'); }
    setCreating(false);
  }

  async function renameDemo(userId: string) {
    if (!editName.trim()) return;
    try {
      await api.patch(`/auth/demos/${userId}`, { name: editName.trim() });
      setEditingId(null);
      setEditName('');
      loadDemos();
    } catch { showToast('Could not rename'); }
  }

  async function deleteDemo(userId: string, username: string) {
    if (!confirm(`Delete ${username} and all its data?`)) return;
    try {
      await api.delete(`/auth/demos/${userId}`);
      showToast(`Deleted ${username}`);
      loadDemos();
    } catch { showToast('Could not delete'); }
  }

  async function sendInvite() {
    if (!inviteName.trim()) return;
    setInviting(true);
    try {
      const result = await api.post<{ joinUrl: string; emailBody: string }>('/auth/invite-simple', {
        name: inviteName.trim(),
        email: inviteEmail.trim(),
      });
      setLastInviteUrl(result.joinUrl);
      navigator.clipboard?.writeText(result.emailBody).then(() => {
        showToast('Invite copied to clipboard');
      }).catch(() => {});
      setInviteName('');
      setInviteEmail('');
    } catch { showToast('Could not create invite'); }
    setInviting(false);
  }

  function timeAgo(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  return (
    <div className="admin-panel">
      {/* ─── Demo Accounts ─────────────────────────────── */}
      <section className="admin-section">
        <div className="admin-section-header">
          <h3>Demo Accounts</h3>
          <button
            className="btn btn-primary btn-sm"
            onClick={createDemo}
            disabled={creating}
          >
            {creating ? 'Creating...' : '+ New Demo'}
          </button>
        </div>
        <p className="admin-hint">
          All demos use password <strong>Maria2026</strong>. Next account: <strong>demo{demos.length > 0 ? Math.max(...demos.map(d => { const n = parseInt(d.username.replace('demo_', '').replace('demo', ''), 10); return isNaN(n) ? 0 : n; })) + 1 : 1}</strong>
        </p>

        {demos.length === 0 ? (
          <p className="admin-empty">No demo accounts yet.</p>
        ) : (
          <div className="admin-demo-list">
            {demos.map(d => (
              <div key={d.userId} className="admin-demo-row">
                <div className="admin-demo-info">
                  <span className="admin-demo-username">{d.username}</span>
                  {editingId === d.userId ? (
                    <span className="admin-demo-rename">
                      <input
                        className="admin-rename-input"
                        value={editName}
                        onChange={e => setEditName(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') renameDemo(d.userId); if (e.key === 'Escape') setEditingId(null); }}
                        placeholder="New name"
                        autoFocus
                      />
                      <button className="btn btn-ghost btn-sm" onClick={() => renameDemo(d.userId)}>Save</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setEditingId(null)}>Cancel</button>
                    </span>
                  ) : (
                    <span className="admin-demo-workspace">{d.workspaceName}</span>
                  )}
                  <span className="admin-demo-meta">
                    {d.offeringCount > 0 || d.audienceCount > 0
                      ? `${d.offeringCount} offerings, ${d.audienceCount} audiences`
                      : 'empty'}
                    {' · '}
                    {timeAgo(d.createdAt)}
                  </span>
                </div>
                <div className="admin-demo-actions">
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      const w = window.open(`${window.location.origin}/login`, '_blank');
                      if (!w) { showToast('Popup blocked — allow popups for this site'); return; }
                      api.post<{ token: string }>('/auth/login', { username: d.username, password: 'Maria2026' })
                        .then(({ token }) => {
                          setTimeout(() => {
                            try {
                              w.localStorage.clear();
                              w.localStorage.setItem('token', token);
                              w.location.href = window.location.origin + '/';
                            } catch { showToast('Could not set up the account in the new tab'); }
                          }, 500);
                        })
                        .catch(() => showToast('Could not log into demo account'));
                    }}
                  >
                    View as
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => { setEditingId(d.userId); setEditName(d.workspaceName); }}
                  >
                    Rename
                  </button>
                  <button
                    className="btn btn-ghost btn-sm admin-delete"
                    onClick={() => deleteDemo(d.userId, d.username)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ─── Invite a Real User ────────────────────────── */}
      <section className="admin-section">
        <h3>Invite Someone</h3>
        <div className="admin-invite-form">
          <input
            className="admin-invite-input"
            placeholder="Name (e.g., Brad)"
            value={inviteName}
            onChange={e => setInviteName(e.target.value)}
          />
          <input
            className="admin-invite-input"
            placeholder="Email (optional)"
            value={inviteEmail}
            onChange={e => setInviteEmail(e.target.value)}
          />
          <button
            className="btn btn-primary btn-sm"
            onClick={sendInvite}
            disabled={!inviteName.trim() || inviting}
          >
            {inviting ? 'Creating...' : 'Invite'}
          </button>
        </div>
        {lastInviteUrl && (
          <p className="admin-invite-result">
            Invite link: <a href={lastInviteUrl} target="_blank" rel="noopener">{lastInviteUrl}</a>
            <br />
            <span className="admin-hint">Message copied to clipboard.</span>
          </p>
        )}
      </section>

      {/* ─── Usage ─────────────────────────────────────── */}
      <section className="admin-section">
        <h3>Usage</h3>
        {usage.length === 0 ? (
          <p className="admin-empty">No user activity yet.</p>
        ) : (
          <table className="admin-usage-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Last Active</th>
                <th>Messages</th>
                <th>Offerings</th>
                <th>Stories</th>
              </tr>
            </thead>
            <tbody>
              {usage.filter(u => !u.isDemo).map(u => (
                <tr key={u.username}>
                  <td>{u.username}</td>
                  <td>{timeAgo(u.lastActive)}</td>
                  <td>{u.messageCount}</td>
                  <td>{u.offeringCount}</td>
                  <td>{u.storyCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
