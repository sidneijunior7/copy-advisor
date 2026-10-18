
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider, useTheme } from './context/ThemeContext';
import ProtectedRoute from './components/ProtectedRoute';
import AppLayout from './Layouts/AppLayout';
import PublicLayout from './Layouts/PublicLayout';
import Login from './pages/Login';
import Register from './pages/Register';
import { ForgotPassword, ResetPassword, VerifyEmail } from './pages/EmailLinks';
import Catalog from './pages/market/Catalog';
import ListingPage from './pages/market/ListingPage';
import AdminListings from './pages/dev/AdminListings';
import NotFound from './pages/NotFound';
import DevDashboard from './pages/DevDashboard';

// Manager Pages
import ManagerOverview from './pages/manager/ManagerOverview';
import Strategies from './pages/manager/Strategies';
import Portfolios from './pages/manager/Portfolios';
import Clients from './pages/manager/Clients';
import Connections from './pages/manager/Connections';
import Install from './pages/manager/Install';
import PortfolioPerformance from './pages/manager/PortfolioPerformance';
import ManagerMarketplace from './pages/manager/ManagerMarketplace';
import Subscriptions from './pages/manager/Subscriptions';

// Client Pages
import MyLicenses from './pages/client/MyLicenses';
import LicenseDetail from './pages/client/LicenseDetail';
import ClientInstall from './pages/client/ClientInstall';

function NavigateWrapper() {
  const { user } = useAuth();
  if (user?.role === 'TDM_DEV') return <Navigate to="/dev" replace />;
  if (user?.role === 'MANAGER') return <Navigate to="/manager" replace />;
  return <Navigate to="/client" replace />;
}

function ThemedToaster() {
  const { theme } = useTheme();
  return (
    <Toaster
      theme={theme}
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast: '!bg-popover !text-popover-foreground !border-border !shadow-card',
          description: '!text-muted-foreground',
        },
      }}
    />
  );
}

function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/cadastro" element={<Register />} />
            <Route path="/recuperar-senha" element={<ForgotPassword />} />
            <Route path="/redefinir-senha" element={<ResetPassword />} />
            <Route path="/verificar-email" element={<VerifyEmail />} />

            {/* Public: anyone can open the marketplace */}
            <Route element={<PublicLayout />}>
              <Route path="/marketplace" element={<Catalog />} />
              <Route path="/marketplace/:slug" element={<ListingPage />} />
            </Route>

            {/* TDM_DEV Routes */}
            <Route element={<ProtectedRoute allowedRoles={['TDM_DEV']} />}>
              <Route element={<AppLayout />}>
                <Route path="/dev" element={<DevDashboard />} />
                <Route path="/dev/marketplace" element={<AdminListings />} />
              </Route>
            </Route>

            {/* Manager Routes */}
            <Route element={<ProtectedRoute allowedRoles={['MANAGER']} />}>
              <Route path="/manager" element={<AppLayout />}>
                <Route index element={<ManagerOverview />} />
                <Route path="connections" element={<Connections />} />
                <Route path="strategies" element={<Strategies />} />
                <Route path="portfolios" element={<Portfolios />} />
                <Route path="portfolios/:id/performance" element={<PortfolioPerformance />} />
                <Route path="clients" element={<Clients />} />
                <Route path="install" element={<Install />} />
                <Route path="marketplace" element={<ManagerMarketplace />} />
                <Route path="subscriptions" element={<Subscriptions />} />
              </Route>
            </Route>

            {/* Client Routes */}
            <Route element={<ProtectedRoute allowedRoles={['CLIENT']} />}>
              <Route path="/client" element={<AppLayout />}>
                <Route index element={<MyLicenses />} />
                <Route path="licenses/:id" element={<LicenseDetail />} />
                <Route path="install" element={<ClientInstall />} />
              </Route>
            </Route>

            <Route element={<ProtectedRoute />}>
              <Route path="/dashboard" element={<NavigateWrapper />} />
            </Route>

            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
        <ThemedToaster />
      </AuthProvider>
    </ThemeProvider>
  );
}

export default App;
