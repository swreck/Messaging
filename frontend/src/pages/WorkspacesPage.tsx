import { useState, useEffect } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useWorkspace } from '../shared/WorkspaceContext';
import { Modal } from '../shared/Modal';

interface WorkspaceData {
  id: string;
  name: string;
  role: string;
  memberCount: number;
  offeringCount: number;
  createdAt: string;
}

interface Member {
  id: string;
  userId: string;
  username: string;
  role: string;
  createdAt: string;
}

interface InviteCodeData {
  id: string;
  code: string;
  createdAt: string;
}

const INITIAL_COLORS = [
  '#007AFF', '#34C759', '#FF9500', '#AF52DE',
  '#FF3B30', '#5856D6', '#FF2D55', '#00C7BE',
];

function getInitialColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return INITIAL_COLORS[Math.abs(hash) % INITIAL_COLORS.length];
}

export function WorkspacesPage() {
  const { user } = useAuth();
  const { switchWorkspace, reload } = useWorkspace();

  const [workspaces, setWorkspaces] = useState<WorkspaceData[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Per-workspace state
  const [members, setMembers] = useState<Record<string, Member[]>>({});
  const [inviteCodes, setInviteCodes] = useState<Record<string, InviteCodeData[]>>({});
  const [loadingMembers, setLoadingMembers] = useState<Set<string>>(new Set());

  // New workspace modal
  const [showNewModal, setShowNewModal] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState<WorkspaceData | null>(null);

  // Inline editing
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editNameValue, setEditNameValue] = useState('');

  // Invite by username
  const [inviteUsername, setInviteUsername] = useState<Record<string, string>>({});
  const [inviteRole, setInviteRole] = useState<Record<string, string>>({});
  const [inviteError, setInviteError] = useState<Record<string, string>>({});
  const [inviting, setInviting] = useState<Set<string>>(new Set());

  // Generated code display
  const [generatedCode, setGeneratedCode] = useState<Record<string, string>>({});
  const [generating, setGenerating] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => { loadWorkspaces(); }, []);

  async function loadWorkspaces() {
    try {
      const endpoint = user?.isAdmin ? '/workspaces/all' : '/workspaces';
      const { workspaces: ws } = await api.get<{ workspaces: WorkspaceData[] }>(endpoint);
      setWorkspaces(ws);
    } finally {
      setLoading(false);
    }
  }

  async function toggleExpand(wsId: string) {
    const next = new Set(expanded);
    if (next.has(wsId)) {
      next.delete(wsId);
    } else {
      next.add(wsId);
      // Load members and invite codes if not already loaded
      if (!members[wsId]) {
        await loadWorkspaceDetails(wsId);
      }
    }
    setExpanded(next);
  }

  async function loadWorkspaceDetails(wsId: string) {
    setLoadingMembers(prev => new Set(prev).add(wsId));
    try {
      const [membersRes, codesRes] = await Promise.all([
        api.get<{ members: Member[] }>(`/workspaces/${wsId}/members`),
        api.get<{ codes: InviteCodeData[] }>(`/workspaces/${wsId}/invite-codes`).catch(() => ({ codes: [] as InviteCodeData[] })),
      ]);
      setMembers(prev => ({ ...prev, [wsId]: membersRes.members }));
      setInviteCodes(prev => ({ ...prev, [wsId]: codesRes.codes }));
    } finally {
      setLoadingMembers(prev => {
        const next = new Set(prev);
        next.delete(wsId);
        return next;
      });
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (creating || !newName.trim()) return;
    setCreating(true);
    try {
      const { workspace } = await api.post<{ workspace: WorkspaceData }>('/workspaces', { name: newName.trim() });
      setShowNewModal(false);
      setNewName('');
      setJustCreated(workspace);
      await reload();
      await loadWorkspaces();
    } finally {
      setCreating(false);
    }
  }

  async function handleRename(wsId: string) {
    if (!editNameValue.trim()) return;
    await api.put(`/workspaces/${wsId}`, { name: editNameValue.trim() });
    setEditingName(null);
    await reload();
    await loadWorkspaces();
  }

  async function handleInviteUser(wsId: string) {
    const username = inviteUsername[wsId]?.trim();
    if (!username) return;
    setInviting(prev => new Set(prev).add(wsId));
    setInviteError(prev => ({ ...prev, [wsId]: '' }));
    try {
      await api.post(`/workspaces/${wsId}/invite`, {
        username,
        role: inviteRole[wsId] || 'editor',
      });
      setInviteUsername(prev => ({ ...prev, [wsId]: '' }));
      await loadWorkspaceDetails(wsId);
      await reload();
      await loadWorkspaces();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to invite user';
      setInviteError(prev => ({ ...prev, [wsId]: msg }));
    } finally {
      setInviting(prev => {
        const next = new Set(prev);
        next.delete(wsId);
        return next;
      });
    }
  }

  async function handleGenerateCode(wsId: string) {
    setGenerating(prev => new Set(prev).add(wsId));
    try {
      const { code } = await api.post<{ code: string }>(`/workspaces/${wsId}/invite`, {
        generateCode: true,
      });
      setGeneratedCode(prev => ({ ...prev, [wsId]: code }));
      // Refresh invite codes list
      const codesRes = await api.get<{ codes: InviteCodeData[] }>(`/workspaces/${wsId}/invite-codes`).catch(() => ({ codes: [] as InviteCodeData[] }));
      setInviteCodes(prev => ({ ...prev, [wsId]: codesRes.codes }));
    } finally {
      setGenerating(prev => {
        const next = new Set(prev);
        next.delete(wsId);
        return next;
      });
    }
  }

  async function handleCopyCode(code: string) {
    await navigator.clipboard.writeText(code);
    setCopied(code);
    setTimeout(() => setCopied(null), 2000);
  }

  async function handleRemoveMember(wsId: string, userId: string) {
    if (!confirm('Remove this member from the workspace?')) return;
    await api.delete(`/workspaces/${wsId}/members/${userId}`);
    await loadWorkspaceDetails(wsId);
    await reload();
    await loadWorkspaces();
  }

  function handleSwitchToNew() {
    if (justCreated) {
      switchWorkspace(justCreated.id);
    }
    setJustCreated(null);
  }

  const isOwner = (ws: WorkspaceData) => ws.role === 'owner' || ws.role === 'admin';

  if (loading) {
    return <div className="loading-screen"><div className="spinner" /></div>;
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <div>
          <h1>Your Workspaces</h1>
          <p className="page-description">Manage your workspaces and team members</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowNewModal(true)}>New Workspace</button>
      </header>

      {workspaces.length === 0 && (
        <div className="empty-state empty-state-enhanced">
          <h3>No workspaces yet</h3>
          <p>Create a workspace to organize your messaging work and collaborate with others.</p>
          <button className="btn btn-primary" onClick={() => setShowNewModal(true)} style={{ marginTop: 16 }}>
            Create a Workspace
          </button>
        </div>
      )}

      <div className="workspace-cards">
        {workspaces.map(ws => (
          <div key={ws.id} className="expandable-card">
            <div className="expandable-card-header" onClick={() => toggleExpand(ws.id)}>
              <span className="expand-icon">{expanded.has(ws.id) ? '\u25BC' : '\u25B6'}</span>
              <div className="expandable-card-title">
                {editingName === ws.id ? (
                  <input
                    className="workspace-inline-edit"
                    value={editNameValue}
                    onChange={e => setEditNameValue(e.target.value)}
                    onBlur={() => handleRename(ws.id)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleRename(ws.id);
                      if (e.key === 'Escape') setEditingName(null);
                    }}
                    onClick={e => e.stopPropagation()}
                    autoFocus
                  />
                ) : (
                  <strong
                    onClick={e => {
                      if (isOwner(ws)) {
                        e.stopPropagation();
                        setEditingName(ws.id);
                        setEditNameValue(ws.name);
                      }
                    }}
                    title={isOwner(ws) ? 'Click to rename' : undefined}
                    style={isOwner(ws) ? { cursor: 'text' } : undefined}
                  >
                    {ws.name}
                  </strong>
                )}
                <span className="badge">{ws.role}</span>
                <span className="workspace-card-meta">
                  {ws.memberCount} member{ws.memberCount !== 1 ? 's' : ''}
                </span>
              </div>
              <div className="expandable-card-actions" onClick={e => e.stopPropagation()}>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => toggleExpand(ws.id)}
                >
                  {expanded.has(ws.id) ? 'Close' : 'Manage'}
                </button>
              </div>
            </div>

            {expanded.has(ws.id) && (
              <div className="expandable-card-body">
                {loadingMembers.has(ws.id) ? (
                  <div className="workspace-loading">Loading...</div>
                ) : (
                  <>
                    {/* Member list */}
                    <div className="workspace-members">
                      <h4>Members</h4>
                      <div className="workspace-member-list">
                        {(members[ws.id] || []).map(m => (
                          <div key={m.id} className="workspace-member-row">
                            <span
                              className="workspace-member-avatar"
                              style={{ backgroundColor: getInitialColor(m.username) }}
                            >
                              {m.username[0].toUpperCase()}
                            </span>
                            <span className="workspace-member-name">{m.username}</span>
                            <span className="workspace-member-role">{m.role}</span>
                            {isOwner(ws) && m.userId !== user?.userId && (
                              <button
                                className="btn btn-ghost btn-sm btn-danger"
                                onClick={() => handleRemoveMember(ws.id, m.userId)}
                              >
                                Remove
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Invite section (owner only) */}
                    {isOwner(ws) && (
                      <div className="workspace-invite">
                        <h4>Invite</h4>

                        {/* Add existing user */}
                        <div className="workspace-invite-section">
                          <label className="workspace-invite-label">Add existing user</label>
                          <div className="workspace-invite-row">
                            <input
                              type="text"
                              placeholder="Username"
                              value={inviteUsername[ws.id] || ''}
                              onChange={e => setInviteUsername(prev => ({ ...prev, [ws.id]: e.target.value }))}
                              onKeyDown={e => { if (e.key === 'Enter') handleInviteUser(ws.id); }}
                              className="workspace-invite-input"
                            />
                            <select
                              value={inviteRole[ws.id] || 'editor'}
                              onChange={e => setInviteRole(prev => ({ ...prev, [ws.id]: e.target.value }))}
                              className="workspace-role-select"
                            >
                              <option value="editor">Editor</option>
                              <option value="viewer">Viewer</option>
                            </select>
                            <button
                              className="btn btn-primary btn-sm"
                              onClick={() => handleInviteUser(ws.id)}
                              disabled={inviting.has(ws.id) || !inviteUsername[ws.id]?.trim()}
                            >
                              {inviting.has(ws.id) ? 'Adding...' : 'Add'}
                            </button>
                          </div>
                          {inviteError[ws.id] && (
                            <div className="form-error" style={{ marginTop: 4 }}>{inviteError[ws.id]}</div>
                          )}
                        </div>

                        {/* Generate invite link */}
                        <div className="workspace-invite-section">
                          <label className="workspace-invite-label">Generate invite code</label>
                          <p className="text-secondary" style={{ fontSize: 13, margin: '0 0 8px' }}>
                            New users who register with this code will automatically join this workspace.
                          </p>
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => handleGenerateCode(ws.id)}
                            disabled={generating.has(ws.id)}
                          >
                            {generating.has(ws.id) ? 'Generating...' : 'Generate Code'}
                          </button>

                          {generatedCode[ws.id] && (
                            <div className="invite-code-display">
                              <code className="invite-code-value">{generatedCode[ws.id]}</code>
                              <button
                                className="btn btn-ghost btn-sm"
                                onClick={() => handleCopyCode(generatedCode[ws.id])}
                              >
                                {copied === generatedCode[ws.id] ? 'Copied' : 'Copy'}
                              </button>
                            </div>
                          )}

                          {/* List active codes */}
                          {(inviteCodes[ws.id] || []).length > 0 && (
                            <div className="workspace-active-codes">
                              <span className="workspace-invite-label" style={{ fontSize: 13 }}>
                                Active codes ({inviteCodes[ws.id].length})
                              </span>
                              {inviteCodes[ws.id].map(c => (
                                <div key={c.id} className="invite-code-display invite-code-small">
                                  <code className="invite-code-value">{c.code}</code>
                                  <button
                                    className="btn btn-ghost btn-sm"
                                    onClick={() => handleCopyCode(c.code)}
                                  >
                                    {copied === c.code ? 'Copied' : 'Copy'}
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* New Workspace Modal */}
      <Modal open={showNewModal} onClose={() => setShowNewModal(false)} title="New Workspace">
        <form onSubmit={handleCreate}>
          <div className="form-group">
            <label>Name</label>
            <input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="e.g., Marketing Team"
              required
              autoFocus
            />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setShowNewModal(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={creating}>
              {creating ? 'Creating...' : 'Create Workspace'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Switch to new workspace prompt */}
      <Modal open={!!justCreated} onClose={() => setJustCreated(null)} title="Workspace Created">
        <p style={{ marginBottom: 16, lineHeight: 1.5 }}>
          <strong>{justCreated?.name}</strong> is ready. Would you like to switch to it now?
        </p>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={() => setJustCreated(null)}>Stay Here</button>
          <button className="btn btn-primary" onClick={handleSwitchToNew}>Switch Now</button>
        </div>
      </Modal>
    </div>
  );
}
