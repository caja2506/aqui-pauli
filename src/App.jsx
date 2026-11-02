import React, { useEffect, useLayoutEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation, matchPath } from 'react-router-dom';
import { useAuth } from './contexts/AuthContext';
import { useRole } from './contexts/RoleContext';
import { Loader2 } from 'lucide-react';

// --- Layout Components ---
import { trackPageView, trackWhatsAppClick } from './utils/pixel';
import Navbar from './components/storefront/Navbar';
import MobileCartBar from './components/storefront/MobileCartBar';
import Footer from './components/storefront/Footer';
import CartDrawer from './components/storefront/CartDrawer';
import WhatsAppButton from './components/storefront/WhatsAppButton';
import AdminSidebar from './components/admin/AdminSidebar';

// --- Auth ---
import LoginPage from './components/auth/LoginPage';

// --- Store Pages ---
import HomePage from './pages/store/HomePage';
import CatalogPage from './pages/store/CatalogPage';
import ProductPage from './pages/store/ProductPage';
import CartPage from './pages/store/CartPage';
import CheckoutPage from './pages/store/CheckoutPage';
import OrderConfirmation from './pages/store/OrderConfirmation';
import TilopayReturnPage from './pages/store/TilopayReturnPage';
import MyOrdersPage from './pages/store/MyOrdersPage';
import NotFoundPage from './pages/store/NotFoundPage';
import GiveawayPage from './pages/store/GiveawayPage';
import GiveawayRulesPage from './pages/store/GiveawayRulesPage';
import { TerminosPage, DevolucionesPage, EnviosPage, PrivacidadPage } from './pages/store/LegalPages';

// --- Admin Pages ---
import DashboardPage from './pages/admin/DashboardPage';
import BrandsPage from './pages/admin/BrandsPage';
import CategoriesPage from './pages/admin/CategoriesPage';
import ProductsPage from './pages/admin/ProductsPage';
import OrdersPage from './pages/admin/OrdersPage';
import DiscountCardsPage from './pages/admin/DiscountCardsPage';
import CrmPage from './pages/admin/CrmPage';
import ShippingPage from './pages/admin/ShippingPage';
import GiveawayAdminPage from './pages/admin/GiveawayAdminPage';
import TilopayPilotPage from './pages/admin/TilopayPilotPage';

// ========================================
// Layout: Storefront (public)
// ========================================
function StoreLayout() {
  return (
    <div className="min-h-screen flex flex-col bg-white font-sans max-md:text-[15px]">
      <Navbar />
      <CartDrawer />
      <main className="flex-1">
        <Outlet />
      </main>
      <Footer />
      <WhatsAppButton />
    </div>
  );
}

// ========================================
// Layout: Admin (protected)
// ========================================
function AdminLayout() {
  const { user, loading: authLoading } = useAuth();
  const location = useLocation();
  const { isAdmin, roleLoading } = useRole();

  if (authLoading || roleLoading) {
    return (
      <div className="h-screen flex items-center justify-center bg-slate-950">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-10 h-10 text-rose-400 animate-spin" />
          <p className="text-slate-400 text-sm font-bold">Cargando panel admin...</p>
        </div>
      </div>
    );
  }

  if (!user || user.isAnonymous) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  if (!isAdmin) return (
    <div className="h-screen flex items-center justify-center bg-slate-50">
      <div className="text-center">
        <h2 className="text-xl font-black text-slate-900 mb-2">Acceso Denegado</h2>
        <p className="text-sm text-slate-400 mb-4">No tienes permisos de administrador.</p>
        <a href="/" className="text-sm font-bold text-rose-600 hover:text-rose-700">← Ir a la tienda</a>
      </div>
    </div>
  );

  return (
    <div className="h-screen flex flex-col md:flex-row bg-slate-50 text-slate-900 font-sans overflow-hidden">
      <AdminSidebar />
      <main id="admin-content" className="flex-1 overflow-y-auto p-4 md:p-8">
        <Outlet />
      </main>
    </div>
  );
}

// ========================================
// App
// ========================================
function PixelNavigation() {
  const { pathname, search, hash } = useLocation();
  useLayoutEffect(() => { trackPageView(pathname + search + hash); }, [pathname, search, hash]);
  useEffect(() => {
    document.addEventListener('click', trackWhatsAppClick, true);
    return () => document.removeEventListener('click', trackWhatsAppClick, true);
  }, []);
  return null;
}

function ScrollToTop() {
  const { pathname } = useLocation();
  useLayoutEffect(() => {
    const previous = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';
    return () => { window.history.scrollRestoration = previous; };
  }, []);
  useLayoutEffect(() => {
    const top = { top: 0, left: 0, behavior: 'instant' };
    window.scrollTo(top);
    document.getElementById('admin-content')?.scrollTo(top);
  }, [pathname]);
  return null;
}

function GlobalMobileCartBar() {
  const { pathname } = useLocation();
  // Estas páginas integran la acción con el precio del checkout o la compra de la ficha.
  if (matchPath('/producto/:productId', pathname) || matchPath('/checkout', pathname)) return null;
  return <MobileCartBar />;
}

export default function App() {
  return (
    <BrowserRouter>
      <PixelNavigation />
      <ScrollToTop />
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
          <Route path="/tilopay/retorno/:orderId" element={<TilopayReturnPage />} />
          <Route path="/mi-cuenta" element={<MyOrdersPage />} />
          <Route path="/sorteo" element={<GiveawayPage />} />
          <Route path="/sorteo/bases" element={<GiveawayRulesPage />} />
          {/* Páginas legales */}
          <Route path="/terminos" element={<TerminosPage />} />
          <Route path="/devoluciones" element={<DevolucionesPage />} />
          <Route path="/envios" element={<EnviosPage />} />
          <Route path="/privacidad" element={<PrivacidadPage />} />
          <Route path="/carrito" element={<CartPage />} />
          {/* 404 real dentro del layout de la tienda */}
          <Route path="*" element={<NotFoundPage />} />
        </Route>

        {/* Admin */}
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<DashboardPage />} />
          <Route path="marcas" element={<BrandsPage />} />
          <Route path="categorias" element={<CategoriesPage />} />
          <Route path="productos" element={<ProductsPage />} />
          <Route path="pedidos" element={<OrdersPage />} />
          <Route path="crm" element={<CrmPage />} />
          <Route path="crm/tarjetitas" element={<DiscountCardsPage />} />
          <Route path="envios" element={<ShippingPage />} />
          <Route path="sorteo" element={<GiveawayAdminPage />} />
          <Route path="prueba-tilopay" element={<TilopayPilotPage />} />
        </Route>

      </Routes>
      <GlobalMobileCartBar />
    </BrowserRouter>
  );
}
