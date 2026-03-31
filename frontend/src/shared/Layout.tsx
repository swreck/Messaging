import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useWorkspace } from './WorkspaceContext';

const NAV_ITEMS = [
  { path: '/', label: 'Home' },
  { path: '/audiences', label: 'Audiences' },
  { path: '/offerings', label: 'Offerings' },
  { path: '/three-tiers', label: 'Three Tiers' },
  { path: '/five-chapters', label: 'Five Chapters' },
  { path: '/settings', label: 'Settings' },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const location = useLocation();
  const { workspaces, activeWorkspace, switchWorkspace } = useWorkspace();

  function isActive(path: string) {
    if (path === '/') return location.pathname === '/';
    return location.pathname.startsWith(path);
  }

  return (
    <div className="app-layout">
      <nav className="nav-bar">
        <Link to="/" className="nav-brand">
          <span className="nav-brand-name">Maria</span>
          <span className="nav-brand-tagline">Your Messaging Partner</span>
        </Link>
        {workspaces.length > 1 && activeWorkspace && (
          <span className="nav-workspace-name">{activeWorkspace.name}</span>
        )}
        {workspaces.length > 1 && (
          <div className="workspace-picker">
            <select
              value={activeWorkspace?.id || ''}
              onChange={(e) => switchWorkspace(e.target.value)}
            >
              {workspaces.map(ws => (
                <option key={ws.id} value={ws.id}>{ws.name}</option>
              ))}
            </select>
          </div>
        )}
        <div className="nav-links">
          {NAV_ITEMS.map(item => (
            <Link
              key={item.path}
              to={item.path}
              className={isActive(item.path) ? 'active' : ''}
            >
              {item.label}
            </Link>
          ))}
        </div>
        <div className="nav-right">
          <span className="nav-user">{user?.username}</span>
          <button onClick={logout} className="btn btn-ghost btn-sm">Sign Out</button>
        </div>
      </nav>
      <main className="main-content">
        {children}
      </main>
    </div>
  );
}
