import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [, setDemoCount] = useState<number | null>(null);

  useEffect(() => {
    // Use the public demo-count endpoint — NOT the admin demos endpoint.
    // Calling an auth-required endpoint from the login page triggers the
    // 401 → redirect-to-login loop (CLAUDE.md gotcha #7).
    fetch('/api/auth/demo-count')
      .then(r => r.json())
      .then(j => { if (j.count > 0) setDemoCount(j.count); })
      .catch(() => {});
  }, []);

  const isDemo = username.toLowerCase().startsWith('demo');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(username, password);
      navigate('/');
    } catch (err: any) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <h1 className="login-title">Maria</h1>
          <p className="login-tagline">Your messaging partner</p>
          <p className="login-value-prop">A partner in drafting persuasive stories, who can either lead the process or offer support when asked.</p>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="username">Username</label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              required
            />
          </div>
          <div className="form-group">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
            {isDemo && (
              <span className="login-demo-hint">Maria2026</span>
            )}
          </div>
          {error && <div className="form-error">{error}</div>}
          <button type="submit" className="btn btn-primary btn-full" disabled={loading}>
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <p className="auth-link">
          Have an invite link? <Link to="/register">Create account</Link>
        </p>

        {/* Demo count hidden — admin-only info, confuses new users */}
      </div>
    </div>
  );
}
