import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { LoginPage } from './auth/LoginPage';
import { RegisterPage } from './auth/RegisterPage';
import { Layout } from './shared/Layout';
import { MariaProvider } from './shared/MariaContext';
import { DashboardPage } from './dashboard/DashboardPage';
import { AudiencesPage } from './pages/AudiencesPage';
import { OfferingsPage } from './pages/OfferingsPage';
import { OfferingDetailPage } from './pages/OfferingDetailPage';
import { ThreeTiersPage } from './pages/ThreeTiersPage';
import { FiveChaptersPage } from './pages/FiveChaptersPage';
import { ThreeTierShell } from './three-tier/ThreeTierShell';
import { FiveChapterShell } from './five-chapter/FiveChapterShell';

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <MariaProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/" element={<ProtectedRoute><Layout><DashboardPage /></Layout></ProtectedRoute>} />
          <Route path="/audiences" element={<ProtectedRoute><Layout><AudiencesPage /></Layout></ProtectedRoute>} />
          <Route path="/offerings" element={<ProtectedRoute><Layout><OfferingsPage /></Layout></ProtectedRoute>} />
          <Route path="/offerings/:id" element={<ProtectedRoute><Layout><OfferingDetailPage /></Layout></ProtectedRoute>} />
          <Route path="/three-tiers" element={<ProtectedRoute><Layout><ThreeTiersPage /></Layout></ProtectedRoute>} />
          <Route path="/five-chapters" element={<ProtectedRoute><Layout><FiveChaptersPage /></Layout></ProtectedRoute>} />
          <Route path="/three-tier/:draftId" element={<ProtectedRoute><Layout><ThreeTierShell /></Layout></ProtectedRoute>} />
          <Route path="/five-chapter/:draftId" element={<ProtectedRoute><Layout><FiveChapterShell /></Layout></ProtectedRoute>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </MariaProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
