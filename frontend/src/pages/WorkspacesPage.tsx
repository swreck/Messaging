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
  inviteeName: string;
  inviteeEmail: string;
  role: string;
  createdAt: string;
}

interface InviteResult {
  code: string;
  link: string;
  inviteeName: string;
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

function getBaseUrl(): string {
  return window.location.origin;
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

  // Per-workspace inline invite form
  const [wsInviteName, setWsInviteName] = useState<Record<string, string>>({});
  const [wsInviteEmail, setWsInviteEmail] = useState<Record<string, string>>({});
  const [wsInviteRole, setWsInviteRole] = useState<Record<string, string>>({});
  const [wsInviteResult, setWsInviteResult] = useState<Record<string, InviteResult | null>>({});
  const [wsInviteError, setWsInviteError] = useState<Record<string, string>>({});
  const [wsInviting, setWsInviting] = useState<Set<string>>(new Set());

  // Per-workspace "add existing user" expand
  const [showAddExisting, setShowAddExisting] = useState<Set<string>>(new Set());
  const [addUsername, setAddUsername] = useState<Record<string, string>>({});
  const [addRole, setAddRole] = useState<Record<string, string>>({});
  const [addError, setAddError] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState<Set<string>>(new Set());

  // Global invite modal
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [globalInviteName, setGlobalInviteName] = useState('');
  const [globalInviteEmail, setGlobalInviteEmail] = useState('');
  const [globalInviteWsId, setGlobalInviteWsId] = useState<string>('standalone');
  const [globalInviteRole, setGlobalInviteRole] = useState('editor');
  const [globalInviteResult, setGlobalInviteResult] = useState<InviteResult | null>(null);
  const [globalInviteError, setGlobalInviteError] = useState('');
  const [globalInviting, setGlobalInviting] = useState(false);

  // Copied feedback
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

  // Per-workspace invite (primary flow: name + email)
  async function handleWsInvite(wsId: string) {
    const name = wsInviteName[wsId]?.trim();
    if (!name) return;
    setWsInviting(prev => new Set(prev).add(wsId));
    setWsInviteError(prev => ({ ...prev, [wsId]: '' }));
    setWsInviteResult(prev => ({ ...prev, [wsId]: null }));
    try {
      const result = await api.post<InviteResult>(`/workspaces/${wsId}/invite`, {
        name,
        email: wsInviteEmail[wsId]?.trim() || undefined,
        role: wsInviteRole[wsId] || 'editor',
      });
      setWsInviteResult(prev => ({ ...prev, [wsId]: result }));
      setWsInviteName(prev => ({ ...prev, [wsId]: '' }));
      setWsInviteEmail(prev => ({ ...prev, [wsId]: '' }));
      // Refresh pending invites
      const codesRes = await api.get<{ codes: InviteCodeData[] }>(`/workspaces/${wsId}/invite-codes`).catch(() => ({ codes: [] as InviteCodeData[] }));
      setInviteCodes(prev => ({ ...prev, [wsId]: codesRes.codes }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to create invite';
      setWsInviteError(prev => ({ ...prev, [wsId]: msg }));
    } finally {
      setWsInviting(prev => {
        const next = new Set(prev);
        next.delete(wsId);
        return next;
      });
    }
  }

  // Add existing user by username (secondary flow)
  async function handleAddExisting(wsId: string) {
    const username = addUsername[wsId]?.trim();
    if (!username) return;
    setAdding(prev => new Set(prev).add(wsId));
    setAddError(prev => ({ ...prev, [wsId]: '' }));
    try {
      await api.post(`/workspaces/${wsId}/invite`, {
        username,
        role: addRole[wsId] || 'editor',
      });
      setAddUsername(prev => ({ ...prev, [wsId]: '' }));
      await loadWorkspaceDetails(wsId);
      await reload();
      await loadWorkspaces();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to add user';
      setAddError(prev => ({ ...prev, [wsId]: msg }));
    } finally {
      setAdding(prev => {
        const next = new Set(prev);
        next.delete(wsId);
        return next;
      });
    }
  }

  // Global invite modal
  async function handleGlobalInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!globalInviteName.trim()) return;
    setGlobalInviting(true);
    setGlobalInviteError('');
    setGlobalInviteResult(null);
    try {
      let result: InviteResult;
      if (globalInviteWsId === 'standalone') {
        result = await api.post<InviteResult>('/workspaces/invite-standalone', {
          name: globalInviteName.trim(),
          email: globalInviteEmail.trim() || undefined,
        });
      } else {
        result = await api.post<InviteResult>(`/workspaces/${globalInviteWsId}/invite`, {
          name: globalInviteName.trim(),
          email: globalInviteEmail.trim() || undefined,
          role: globalInviteRole,
        });
      }
      setGlobalInviteResult(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to create invite';
      setGlobalInviteError(msg);
    } finally {
      setGlobalInviting(false);
    }
  }

  function resetGlobalInvite() {
    setGlobalInviteName('');
    setGlobalInviteEmail('');
    setGlobalInviteWsId('standalone');
    setGlobalInviteRole('editor');
    setGlobalInviteResult(null);
    setGlobalInviteError('');
    setShowInviteModal(false);
  }

  async function handleCopyLink(link: string) {
    const fullLink = `${getBaseUrl()}${link}`;
    await navigator.clipboard.writeText(fullLink);
    setCopied(link);
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
  const ownedWorkspaces = workspaces.filter(isOwner);

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
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" onClick={() => setShowInviteModal(true)}>Invite Someone</button>
          <button className="btn btn-primary" onClick={() => setShowNewModal(true)}>New Workspace</button>
        </div>
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
                        <h4>Invite Someone</h4>

                        {/* Primary invite form: name + email */}
                        <div className="invite-form">
                          <div className="invite-form-row">
                            <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                              <input
                                type="text"
                                placeholder="Name (e.g., Ryan)"
                                value={wsInviteName[ws.id] || ''}
                                onChange={e => setWsInviteName(prev => ({ ...prev, [ws.id]: e.target.value }))}
                              />
                            </div>
                            <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                              <input
                                type="email"
                                placeholder="Email (optional)"
                                value={wsInviteEmail[ws.id] || ''}
                                onChange={e => setWsInviteEmail(prev => ({ ...prev, [ws.id]: e.target.value }))}
                              />
                            </div>
                          </div>
                          <div className="invite-form-row" style={{ marginTop: 8 }}>
                            <select
                              value={wsInviteRole[ws.id] || 'editor'}
                              onChange={e => setWsInviteRole(prev => ({ ...prev, [ws.id]: e.target.value }))}
                              className="workspace-role-select"
                            >
                              <option value="editor">Editor</option>
                              <option value="viewer">Viewer</option>
                            </select>
                            <button
                              className="btn btn-primary btn-sm"
                              onClick={() => handleWsInvite(ws.id)}
                              disabled={wsInviting.has(ws.id) || !(wsInviteName[ws.id] || '').trim()}
                            >
                              {wsInviting.has(ws.id) ? 'Creating...' : 'Send Invite'}
                            </button>
                          </div>
                        </div>

                        {wsInviteError[ws.id] && (
                          <div className="form-error" style={{ marginTop: 8 }}>{wsInviteError[ws.id]}</div>
                        )}

                        {/* Invite success */}
                        {wsInviteResult[ws.id] && (
                          <div className="invite-success">
                            <div className="invite-success-header">Invite created for {wsInviteResult[ws.id]!.inviteeName}</div>
                            <div className="invite-link-row">
                              <code className="invite-link">{getBaseUrl()}{wsInviteResult[ws.id]!.link}</code>
                              <button
                                className="btn btn-ghost btn-sm"
                                onClick={() => handleCopyLink(wsInviteResult[ws.id]!.link)}
                              >
                                {copied === wsInviteResult[ws.id]!.link ? 'Copied!' : 'Copy'}
                              </button>
                            </div>
                          </div>
                        )}

                        {/* Pending invites */}
                        {(inviteCodes[ws.id] || []).length > 0 && (
                          <div className="invite-pending">
                            <span className="workspace-invite-label" style={{ fontSize: 13 }}>
                              Pending invites ({inviteCodes[ws.id].length})
                            </span>
                            {inviteCodes[ws.id].map(c => (
                              <div key={c.id} className="invite-pending-row">
                                <span className="invite-pending-name">{c.inviteeName || 'Unnamed'}</span>
                                <code className="invite-pending-code">{c.code}</code>
                                <span className="invite-pending-role">{c.role}</span>
                                <button
                                  className="btn btn-ghost btn-sm"
                                  onClick={() => handleCopyLink(`/join/${c.code}`)}
                                >
                                  {copied === `/join/${c.code}` ? 'Copied!' : 'Copy Link'}
                                </button>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Secondary: add existing user */}
                        {!showAddExisting.has(ws.id) ? (
                          <button
                            className="btn-text-link"
                            onClick={() => setShowAddExisting(prev => new Set(prev).add(ws.id))}
                            style={{ marginTop: 12 }}
                          >
                            Already have an account? Add by username
                          </button>
                        ) : (
                          <div className="workspace-invite-section" style={{ marginTop: 12 }}>
                            <div className="workspace-invite-row">
                              <input
                                type="text"
                                placeholder="Username"
                                value={addUsername[ws.id] || ''}
                                onChange={e => setAddUsername(prev => ({ ...prev, [ws.id]: e.target.value }))}
                                onKeyDown={e => { if (e.key === 'Enter') handleAddExisting(ws.id); }}
                                className="workspace-invite-input"
                              />
                              <select
                                value={addRole[ws.id] || 'editor'}
                                onChange={e => setAddRole(prev => ({ ...prev, [ws.id]: e.target.value }))}
                                className="workspace-role-select"
                              >
                                <option value="editor">Editor</option>
                                <option value="viewer">Viewer</option>
                              </select>
                              <button
                                className="btn btn-primary btn-sm"
                                onClick={() => handleAddExisting(ws.id)}
                                disabled={adding.has(ws.id) || !(addUsername[ws.id] || '').trim()}
                              >
                                {adding.has(ws.id) ? 'Adding...' : 'Add'}
                              </button>
                            </div>
                            {addError[ws.id] && (
                              <div className="form-error" style={{ marginTop: 4 }}>{addError[ws.id]}</div>
                            )}
                          </div>
                        )}
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

      {/* Global Invite Modal */}
      <Modal open={showInviteModal} onClose={resetGlobalInvite} title="Invite Someone to Maria">
        {globalInviteResult ? (
          <div>
            <div className="invite-success">
              <div className="invite-success-header">Invite created for {globalInviteResult.inviteeName}</div>
              <div className="invite-link-row">
                <code className="invite-link">{getBaseUrl()}{globalInviteResult.link}</code>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => handleCopyLink(globalInviteResult.link)}
                >
                  {copied === globalInviteResult.link ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={resetGlobalInvite}>Done</button>
              <button className="btn btn-primary" onClick={() => {
                setGlobalInviteResult(null);
                setGlobalInviteName('');
                setGlobalInviteEmail('');
              }}>Invite Another</button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleGlobalInvite}>
            <div className="form-group">
              <label>Name</label>
              <input
                value={globalInviteName}
                onChange={e => setGlobalInviteName(e.target.value)}
                placeholder="e.g., Ryan"
                required
                autoFocus
              />
            </div>
            <div className="form-group">
              <label>Email <span style={{ color: 'var(--text-secondary)', fontWeight: 400 }}>(optional)</span></label>
              <input
                type="email"
                value={globalInviteEmail}
                onChange={e => setGlobalInviteEmail(e.target.value)}
                placeholder="ryan@example.com"
              />
            </div>
            <div className="form-group">
              <label>Add them to</label>
              <div className="invite-workspace-picker">
                {ownedWorkspaces.map(ws => (
                  <label key={ws.id} className="invite-radio-option">
                    <input
                      type="radio"
                      name="invite-workspace"
                      value={ws.id}
                      checked={globalInviteWsId === ws.id}
                      onChange={() => setGlobalInviteWsId(ws.id)}
                    />
                    <span>{ws.name}</span>
                  </label>
                ))}
                <label className="invite-radio-option">
                  <input
                    type="radio"
                    name="invite-workspace"
                    value="standalone"
                    checked={globalInviteWsId === 'standalone'}
                    onChange={() => setGlobalInviteWsId('standalone')}
                  />
                  <span>Their own fresh workspace</span>
                </label>
              </div>
            </div>
            {globalInviteWsId !== 'standalone' && (
              <div className="form-group">
                <label>Role</label>
                <select
                  value={globalInviteRole}
                  onChange={e => setGlobalInviteRole(e.target.value)}
                >
                  <option value="editor">Editor</option>
                  <option value="viewer">Viewer</option>
                </select>
              </div>
            )}
            {globalInviteError && <div className="form-error">{globalInviteError}</div>}
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={resetGlobalInvite}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={globalInviting}>
                {globalInviting ? 'Creating...' : 'Create Invite'}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
