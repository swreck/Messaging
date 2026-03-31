import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { api } from '../api/client';

interface InviteInfo {
  valid: boolean;
  inviteeName?: string;
  workspaceName?: string;
  role?: string;
}

export function JoinPage() {
  const { code } = useParams<{ code: string }>();
  const { register } = useAuth();
  const navigate = useNavigate();

  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [loadingInvite, setLoadingInvite] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!code) return;
    api.get<InviteInfo>(`/auth/invite/${code}`)
      .then((info) => {
        setInvite(info);
        if (info.valid && info.inviteeName) {
          setUsername(info.inviteeName.trim().toLowerCase().replace(/\s+/g, ''));
        }
      })
      .catch(() => setInvite({ valid: false }))
      .finally(() => setLoadingInvite(false));
  }, [code]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setLoading(true);
    try {
      await register(code!, username, password);
      navigate('/');
    } catch (err: any) {
      setError(err.message || 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  if (loadingInvite) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <div className="spinner" style={{ margin: '40px auto' }} />
        </div>
      </div>
    );
  }

  if (!invite?.valid) {
    return (
      <div className="auth-page">
        <div className="auth-card join-page">
          <h1>Maria</h1>
          <div className="join-invalid">
            <p>This invite link has already been used or doesn't exist.</p>
            <p style={{ marginTop: 16, fontSize: 14 }}>
              If you already have an account, <Link to="/login">sign in here</Link>.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="auth-card join-page join-card">
        <h1>Maria</h1>

        {invite.inviteeName && (
          <>
            <p className="join-welcome">Welcome, {invite.inviteeName}</p>
            <p className="auth-subtitle">You've been invited to collaborate on messaging that matters.</p>
          </>
        )}

        {invite.workspaceName && (
          <span className="join-workspace-badge">{invite.workspaceName}</span>
        )}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="username">Choose a Username</label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              required
            />
            {invite.inviteeName && (
              <p className="join-username-hint">We suggested this based on your invite — feel free to change it.</p>
            )}
          </div>
          <div className="form-group">
            <label htmlFor="password">Choose a Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              required
              minLength={4}
            />
          </div>
          <div className="form-group">
            <label htmlFor="confirmPassword">Confirm Password</label>
            <input
              id="confirmPassword"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              required
              minLength={4}
            />
          </div>
          {error && <div className="form-error">{error}</div>}
          <button type="submit" className="btn btn-primary btn-full" disabled={loading}>
            {loading ? 'Creating account...' : 'Create Account'}
          </button>
        </form>

        <p className="auth-link">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
