import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Tag, FolderTree, Package, ClipboardList,
  Users, Zap, LogOut, Shield, ShoppingBag, ArrowLeft, Menu, X, MessageCircle, Truck
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useRole } from '../../contexts/RoleContext';

const NAV_ITEMS = [
  { to: '/admin', icon: LayoutDashboard, label: 'Dashboard', exact: true },
  { to: '/admin/marcas', icon: Tag, label: 'Marcas' },
  { to: '/admin/categorias', icon: FolderTree, label: 'Categorías' },
  { to: '/admin/productos', icon: Package, label: 'Productos' },
  { to: '/admin/pedidos', icon: ClipboardList, label: 'Pedidos' },
  { to: '/admin/crm', icon: Users, label: 'CRM' },
  { to: '/admin/automatizaciones', icon: Zap, label: 'Automatizaciones' },
  { to: '/admin/soporte', icon: MessageCircle, label: 'Soporte' },
  { to: '/admin/envios', icon: Truck, label: 'Envíos' },
];

export default function AdminSidebar() {
  const { user, signOut } = useAuth();
  const { role } = useRole();
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);

  const isActive = (item) => {
    if (item.exact) return location.pathname === item.to;
    return location.pathname.startsWith(item.to);
  };

  const handleSignOut = async () => {
    setMobileOpen(false);
    await signOut();
    navigate('/');
  };

  const currentPage = NAV_ITEMS.find(item => isActive(item))?.label || 'Admin';

  // Shared sidebar content
  const sidebarContent = (
    <>
      {/* Logo */}
      <div className="p-5 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-gradient-to-br from-rose-500 to-rose-600 rounded-xl flex items-center justify-center shadow-md">
            <ShoppingBag className="w-5 h-5 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-black tracking-tighter leading-none">Aquí Pauli</h1>
              <span className="text-[10px] font-mono bg-slate-700 text-slate-300 px-2 py-0.5 rounded-full">Admin</span>
            </div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        {NAV_ITEMS.map(item => (
          <Link
            key={item.to}
            to={item.to}
            onClick={() => setMobileOpen(false)}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all ${
              isActive(item)
                ? 'bg-rose-600 text-white shadow-lg shadow-rose-900/30'
                : 'text-slate-400 hover:bg-slate-800 hover:text-white'
            }`}
          >
            <item.icon className="w-5 h-5 shrink-0" />
            {item.label}
          </Link>
        ))}

        <div className="pt-4 mt-4 border-t border-slate-800">
          <Link
            to="/"
            onClick={() => setMobileOpen(false)}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold text-slate-400 hover:bg-slate-800 hover:text-white transition-all"
          >
            <ArrowLeft className="w-5 h-5 shrink-0" />
            Ir a la Tienda
          </Link>
        </div>
      </nav>

      {/* User */}
      <div className="p-4 border-t border-slate-800 space-y-3">
        <div className="flex items-center gap-3">
          {user?.photoURL ? (
            <img src={user.photoURL} alt="" className="w-8 h-8 rounded-full shrink-0" referrerPolicy="no-referrer" />
          ) : (
            <div className="w-8 h-8 rounded-full bg-rose-600 flex items-center justify-center text-white text-xs font-bold shrink-0">
              {(user?.displayName || user?.email || '?')[0].toUpperCase()}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-xs font-bold text-white truncate">{user?.displayName || 'Admin'}</p>
            <div className="flex items-center gap-1">
              <Shield className="w-3 h-3 text-slate-500 shrink-0" />
              <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400">{role || 'admin'}</span>
            </div>
          </div>
        </div>
        <button onClick={handleSignOut} className="w-full flex items-center justify-center gap-2 text-xs font-bold text-slate-400 hover:text-white hover:bg-slate-800 py-2 px-3 rounded-lg transition-all">
          <LogOut className="w-3.5 h-3.5" /> Cerrar Sesión
        </button>
      </div>
    </>
  );

  return (
    <>
      {/* ── Mobile top bar ── */}
      <div className="md:hidden flex items-center justify-between bg-slate-900 text-white px-4 py-3 shrink-0">
        <button
          onClick={() => setMobileOpen(true)}
          className="p-2 hover:bg-slate-800 rounded-xl transition-colors"
        >
          <Menu className="w-5 h-5" />
        </button>
        <span className="text-sm font-black">{currentPage}</span>
        <div className="w-9" /> {/* spacer */}
      </div>

      {/* ── Mobile drawer (overlay) ── */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setMobileOpen(false)}
          />
          {/* Drawer */}
          <aside className="relative w-72 max-w-[85vw] bg-slate-900 text-white flex flex-col h-full animate-in slide-in-from-left duration-200">
            {/* Close button */}
            <button
              onClick={() => setMobileOpen(false)}
              className="absolute top-4 right-4 p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-all"
            >
              <X className="w-5 h-5" />
            </button>
            {sidebarContent}
          </aside>
        </div>
      )}

      {/* ── Desktop sidebar ── */}
      <aside className="hidden md:flex flex-col w-64 bg-slate-900 text-white shrink-0">
        {sidebarContent}
      </aside>
    </>
  );
}
