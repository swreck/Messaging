import { useState, useRef, useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useWorkspace } from './WorkspaceContext';

export function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const { workspaces, activeWorkspace, switchWorkspace } = useWorkspace();

  const showTeams = user?.isAdmin || workspaces.length > 1;
  const [teamDropdownOpen, setTeamDropdownOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const mobileMenuRef = useRef<HTMLDivElement>(null);

  // Close dropdowns when clicking outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setTeamDropdownOpen(false);
      }
      if (mobileMenuRef.current && !mobileMenuRef.current.contains(e.target as Node)) {
        setMobileMenuOpen(false);
      }
    }
    if (teamDropdownOpen || mobileMenuOpen) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [teamDropdownOpen, mobileMenuOpen]);

  // Close mobile menu on navigation
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location.pathname]);

  const NAV_ITEMS = [
    { path: '/', label: 'Home' },
    { path: '/audiences', label: 'Audiences' },
    { path: '/offerings', label: 'Offerings' },
    { path: '/three-tiers', label: '3 Tiers' },
    { path: '/five-chapters', label: '5 Ch. Stories' },
  ];

  function isActive(path: string) {
    if (path === '/') return location.pathname === '/';
    return location.pathname.startsWith(path);
  }

  const adminReturnToken = typeof window !== 'undefined' ? localStorage.getItem('maria-admin-return-token') : null;

  return (
    <div className="app-layout">
      {adminReturnToken && (
        <div style={{ background: '#007aff', color: 'white', padding: '6px 16px', fontSize: 13, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Viewing as {user?.username}</span>
          <button
            style={{ background: 'rgba(255,255,255,0.2)', color: 'white', border: 'none', borderRadius: 4, padding: '4px 12px', cursor: 'pointer', fontSize: 13 }}
            onClick={() => {
              localStorage.removeItem('maria-admin-return-token');
              localStorage.removeItem('maria-workspace-id');
              localStorage.setItem('token', adminReturnToken);
              window.location.href = '/settings';
            }}
          >
            Return to admin
          </button>
        </div>
      )}
      <nav className="nav-bar">
        <Link to="/" className="nav-brand">
          <span className="nav-brand-name">Maria</span>
          <span className="nav-brand-tagline">Your Messaging Partner</span>
        </Link>
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
        <div className="nav-mobile-wrapper" ref={mobileMenuRef}>
          <button
            className="nav-hamburger"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label="Menu"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              {mobileMenuOpen
                ? <><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></>
                : <><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></>
              }
            </svg>
          </button>
          {mobileMenuOpen && (
            <>
              <div
                className="nav-mobile-backdrop"
                onClick={() => setMobileMenuOpen(false)}
                aria-hidden="true"
              />
              <div className="nav-mobile-menu">
                {NAV_ITEMS.map(item => (
                  <Link
                    key={item.path}
                    to={item.path}
                    className={isActive(item.path) ? 'active' : ''}
                    onClick={() => setMobileMenuOpen(false)}
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            </>
          )}
        </div>
        {showTeams && (
          <div className="team-dropdown-wrapper" ref={dropdownRef}>
            <button
              className={`team-dropdown-trigger ${location.pathname.startsWith('/workspaces') ? 'active' : ''}`}
              onClick={() => setTeamDropdownOpen(!teamDropdownOpen)}
            >
              {activeWorkspace ? activeWorkspace.name : 'Teams'}
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ marginLeft: 4 }}>
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            {teamDropdownOpen && (
              <div className="team-dropdown-menu">
                {workspaces.map(ws => (
                  <button
                    key={ws.id}
                    className={`team-dropdown-item ${ws.id === activeWorkspace?.id ? 'team-dropdown-active' : ''}`}
                    onClick={() => { switchWorkspace(ws.id); setTeamDropdownOpen(false); }}
                  >
                    {ws.name}
                    {ws.id === activeWorkspace?.id && <span className="team-dropdown-check">✓</span>}
                  </button>
                ))}
                <div className="team-dropdown-divider" />
                <button
                  className="team-dropdown-item team-dropdown-manage"
                  onClick={() => { navigate('/workspaces'); setTeamDropdownOpen(false); }}
                >
                  Manage Teams
                </button>
              </div>
            )}
          </div>
        )}
        <div className="nav-right">
          <button
            onClick={() => {
              // Open Maria panel in place; don't rip the user away from what
              // they were looking at. If they're logged in, Maria greets and
              // asks what they'd like to draft.
              document.dispatchEvent(new CustomEvent('maria-toggle', { detail: { open: true } }));
            }}
            className="btn btn-primary btn-sm nav-start-draft"
            title="Work with Maria on a new message"
          >
            Work with Maria
          </button>
          <span className="nav-user">{user?.firstName || user?.displayName || user?.username}</span>
          <button
            onClick={() => navigate('/settings')}
            className={`nav-settings-btn ${location.pathname.startsWith('/settings') ? 'active' : ''}`}
            aria-label="Settings"
            title="Settings"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
          <button onClick={logout} className="btn btn-ghost btn-sm">Sign Out</button>
        </div>
      </nav>
      <main className="main-content">
        {children}
      </main>
    </div>
  );
}
