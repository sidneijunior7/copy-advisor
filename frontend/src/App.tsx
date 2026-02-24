
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import ProtectedRoute from './components/ProtectedRoute';
import Login from './pages/Login';
import DevDashboard from './pages/DevDashboard';
import ClientDashboard from './pages/ClientDashboard';

// Manager Pages
import ManagerLayout from './Layouts/ManagerLayout';
import ManagerOverview from './pages/manager/ManagerOverview';
import Strategies from './pages/manager/Strategies';
import Portfolios from './pages/manager/Portfolios';
import Clients from './pages/manager/Clients';

function NavigateWrapper() {
  const { user } = useAuth();
  if (user?.role === 'TDM_DEV') return <Navigate to="/dev" />;
  if (user?.role === 'MANAGER') return <Navigate to="/manager" />;
  return <Navigate to="/client" />;
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
              <Route path="/dev" element={<DevDashboard />} />
            </Route>

            {/* Manager Routes */}
            <Route element={<ProtectedRoute allowedRoles={['MANAGER']} />}>
              <Route path="/manager" element={<ManagerLayout />}>
                <Route index element={<ManagerOverview />} />
                <Route path="strategies" element={<Strategies />} />
                <Route path="portfolios" element={<Portfolios />} />
                <Route path="clients" element={<Clients />} />
              </Route>
            </Route>

            {/* Client Routes */}
            <Route element={<ProtectedRoute allowedRoles={['CLIENT']} />}>
              <Route path="/client" element={<ClientDashboard />} />
            </Route>

            <Route element={<ProtectedRoute />}>
              <Route path="/dashboard" element={<NavigateWrapper />} />
            </Route>

            <Route path="/" element={<Navigate to="/login" />} />
            <Route path="*" element={<div className="text-white text-center mt-10">404 Not Found</div>} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  );
}

export default App;
