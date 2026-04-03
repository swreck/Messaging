import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
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

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
        <WorkspaceProvider>
        <MariaProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/join/:code" element={<JoinPage />} />
          <Route path="/" element={<ProtectedRoute><Layout><DashboardPage /></Layout></ProtectedRoute>} />
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
          <Route path="/s/:token" element={<SharedView />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <MariaPartner />
        </MariaProvider>
        </WorkspaceProvider>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
