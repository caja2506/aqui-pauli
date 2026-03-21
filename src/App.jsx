import React from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './contexts/AuthContext';
import { useRole } from './contexts/RoleContext';
import { Loader2 } from 'lucide-react';

// --- Layout Components ---
import Navbar from './components/storefront/Navbar';
import Footer from './components/storefront/Footer';
import CartDrawer from './components/storefront/CartDrawer';
import AdminSidebar from './components/admin/AdminSidebar';

// --- Auth ---
import LoginPage from './components/auth/LoginPage';

// --- Store Pages ---
import HomePage from './pages/store/HomePage';
import CatalogPage from './pages/store/CatalogPage';
import ProductPage from './pages/store/ProductPage';
import CheckoutPage from './pages/store/CheckoutPage';
import OrderConfirmation from './pages/store/OrderConfirmation';

// --- Admin Pages ---
import DashboardPage from './pages/admin/DashboardPage';
import BrandsPage from './pages/admin/BrandsPage';
import CategoriesPage from './pages/admin/CategoriesPage';
import ProductsPage from './pages/admin/ProductsPage';
import OrdersPage from './pages/admin/OrdersPage';
import CrmPage from './pages/admin/CrmPage';
import AutomationsPage from './pages/admin/AutomationsPage';

// ========================================
// Layout: Storefront (public)
// ========================================
function StoreLayout() {
  return (
    <div className="min-h-screen flex flex-col bg-white font-sans">
      <Navbar />
      <CartDrawer />
      <main className="flex-1">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}

// ========================================
// Layout: Admin (protected)
// ========================================
function AdminLayout() {
  const { user, loading: authLoading } = useAuth();
  const { isAdmin, roleLoading } = useRole();

  if (authLoading || roleLoading) {
    return (
      <div className="h-screen flex items-center justify-center bg-slate-950">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-10 h-10 text-indigo-400 animate-spin" />
          <p className="text-slate-400 text-sm font-bold">Cargando panel admin...</p>
        </div>
      </div>
    );
  }

  if (!user) return <Navigate to="/login" state={{ from: '/admin' }} replace />;
  if (!isAdmin) return (
    <div className="h-screen flex items-center justify-center bg-slate-50">
      <div className="text-center">
        <h2 className="text-xl font-black text-slate-900 mb-2">Acceso Denegado</h2>
        <p className="text-sm text-slate-400 mb-4">No tienes permisos de administrador.</p>
        <a href="/" className="text-sm font-bold text-indigo-600 hover:text-indigo-700">← Ir a la tienda</a>
      </div>
    </div>
  );

  return (
    <div className="h-screen flex flex-col md:flex-row bg-slate-50 text-slate-900 font-sans overflow-hidden">
      <AdminSidebar />
      <main className="flex-1 overflow-y-auto p-4 md:p-8">
        <Outlet />
      </main>
    </div>
  );
}

// ========================================
// App
// ========================================
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Auth */}
        <Route path="/login" element={<LoginPage />} />

        {/* Storefront */}
        <Route element={<StoreLayout />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/catalogo" element={<CatalogPage />} />
          <Route path="/producto/:productId" element={<ProductPage />} />
          <Route path="/checkout" element={<CheckoutPage />} />
          <Route path="/orden-confirmada/:orderId" element={<OrderConfirmation />} />
        </Route>

        {/* Admin */}
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<DashboardPage />} />
          <Route path="marcas" element={<BrandsPage />} />
          <Route path="categorias" element={<CategoriesPage />} />
          <Route path="productos" element={<ProductsPage />} />
          <Route path="pedidos" element={<OrdersPage />} />
          <Route path="crm" element={<CrmPage />} />
          <Route path="automatizaciones" element={<AutomationsPage />} />
        </Route>

        {/* Fallback */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
