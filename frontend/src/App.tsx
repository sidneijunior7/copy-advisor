
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider, useTheme } from './context/ThemeContext';
import ProtectedRoute from './components/ProtectedRoute';
import AppLayout from './Layouts/AppLayout';
import Login from './pages/Login';
import NotFound from './pages/NotFound';
import DevDashboard from './pages/DevDashboard';
import ClientDashboard from './pages/ClientDashboard';

// Manager Pages
import ManagerOverview from './pages/manager/ManagerOverview';
import Strategies from './pages/manager/Strategies';
import Portfolios from './pages/manager/Portfolios';
import Clients from './pages/manager/Clients';

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

            {/* TDM_DEV Routes */}
            <Route element={<ProtectedRoute allowedRoles={['TDM_DEV']} />}>
              <Route element={<AppLayout />}>
                <Route path="/dev" element={<DevDashboard />} />
              </Route>
            </Route>

            {/* Manager Routes */}
            <Route element={<ProtectedRoute allowedRoles={['MANAGER']} />}>
              <Route path="/manager" element={<AppLayout />}>
                <Route index element={<ManagerOverview />} />
                <Route path="strategies" element={<Strategies />} />
                <Route path="portfolios" element={<Portfolios />} />
                <Route path="clients" element={<Clients />} />
              </Route>
            </Route>

            {/* Client Routes */}
            <Route element={<ProtectedRoute allowedRoles={['CLIENT']} />}>
              <Route element={<AppLayout />}>
                <Route path="/client" element={<ClientDashboard />} />
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
