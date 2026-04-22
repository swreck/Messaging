import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { LoginPage } from './auth/LoginPage';
import { RegisterPage } from './auth/RegisterPage';
import { JoinPage } from './auth/JoinPage';
import { Layout } from './shared/Layout';
import { MariaProvider } from './shared/MariaContext';
import { WorkspaceProvider } from './shared/WorkspaceContext';
import { MariaPartner } from './shared/MariaPartner';
import { ToastProvider } from './shared/ToastContext';
import { GuidedSessionProvider } from './guided/GuidedSessionContext';
import { DashboardPage } from './dashboard/DashboardPage';
import { AudiencesPage } from './pages/AudiencesPage';
import { OfferingsPage } from './pages/OfferingsPage';
import { OfferingDetailPage } from './pages/OfferingDetailPage';
import { ThreeTiersPage } from './pages/ThreeTiersPage';
import { FiveChaptersPage } from './pages/FiveChaptersPage';
import { ThreeTierShell } from './three-tier/ThreeTierShell';
import { FiveChapterShell } from './five-chapter/FiveChapterShell';
import { SettingsPage } from './pages/SettingsPage';
import { WorkspacesPage } from './pages/WorkspacesPage';
import { MappingPage } from './pages/MappingPage';
import { SharedView } from './pages/SharedView';
import { ExpressPreviewDemo } from './express/ExpressPreviewDemo';
import { ExpressEntry } from './express/ExpressEntry';

// /express → / and auto-open the Maria panel. The guided flow now lives inside the panel;
// legacy bookmarks and the Maria3 host's default landing land here and pop the panel.
function ExpressRedirect() {
  const navigate = useNavigate();
  useEffect(() => {
    navigate('/', { replace: true });
    setTimeout(() => {
      document.dispatchEvent(new CustomEvent('maria-toggle', { detail: { open: true } }));
    }, 50);
  }, [navigate]);
  return null;
}

// Maria 3.0 dual deployment: detect which branded URL is serving this bundle.
// When running on the 3.0 service hostname, "/" redirects to "/express" so
// Maria 3 users land on the chat entry by default. On the 2.5 URL, "/" stays
// the dashboard — 2.5 users see no change.
// Must match the backend's isMariaThreeHost in backend/src/index.ts. The Railway-
// generated hostname is `mariamessaging3.up.railway.app` (no dashes) which does
// NOT contain the substring "maria3" — so we must check for "mariamessaging3"
// explicitly.
const isMariaThreeHost =
  typeof window !== 'undefined' &&
  (window.location.hostname.includes('mariamessaging3') ||
    window.location.hostname.includes('maria-messaging-3') ||
    window.location.hostname.includes('maria3.'));

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
        <WorkspaceProvider>
        <GuidedSessionProvider>
        <MariaProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/join/:code" element={<JoinPage />} />
          <Route
            path="/"
            element={
              <ProtectedRoute><Layout><DashboardPage /></Layout></ProtectedRoute>
            }
          />
          {/* /express retired. Legacy bookmarks + Maria3 host land here and get bounced
              to / with the panel auto-opened. The guided flow lives inside the Maria panel now. */}
          <Route
            path="/express"
            element={<ProtectedRoute><ExpressRedirect /></ProtectedRoute>}
          />
          <Route
            path="/express-legacy"
            element={
              isMariaThreeHost ? (
                <ProtectedRoute><ExpressEntry /></ProtectedRoute>
              ) : (
                <ProtectedRoute><Layout><ExpressEntry /></Layout></ProtectedRoute>
              )
            }
          />
          <Route path="/audiences" element={<ProtectedRoute><Layout><AudiencesPage /></Layout></ProtectedRoute>} />
          <Route path="/offerings" element={<ProtectedRoute><Layout><OfferingsPage /></Layout></ProtectedRoute>} />
          <Route path="/offerings/:id" element={<ProtectedRoute><Layout><OfferingDetailPage /></Layout></ProtectedRoute>} />
          <Route path="/three-tiers" element={<ProtectedRoute><Layout><ThreeTiersPage /></Layout></ProtectedRoute>} />
          <Route path="/five-chapters" element={<ProtectedRoute><Layout><FiveChaptersPage /></Layout></ProtectedRoute>} />
          <Route path="/three-tier/:draftId" element={<ProtectedRoute><Layout><ThreeTierShell /></Layout></ProtectedRoute>} />
          <Route path="/five-chapter/:draftId" element={<ProtectedRoute><Layout><FiveChapterShell /></Layout></ProtectedRoute>} />
          <Route path="/workspaces" element={<ProtectedRoute><Layout><WorkspacesPage /></Layout></ProtectedRoute>} />
          <Route path="/settings" element={<ProtectedRoute><Layout><SettingsPage /></Layout></ProtectedRoute>} />
          <Route path="/mapping/:draftId" element={<ProtectedRoute><MappingPage /></ProtectedRoute>} />
          <Route path="/express-preview-demo" element={<ProtectedRoute><Layout><ExpressPreviewDemo /></Layout></ProtectedRoute>} />
          <Route path="/s/:token" element={<SharedView />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <MariaPartner />
        </MariaProvider>
        </GuidedSessionProvider>
        </WorkspaceProvider>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
