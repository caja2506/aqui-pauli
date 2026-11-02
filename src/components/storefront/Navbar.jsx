import { useState, useRef, useEffect, useSyncExternalStore } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ShoppingBag, ShoppingCart, User, LogOut, Shield, ClipboardList } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useRole } from '../../contexts/RoleContext';
import { useCart } from '../../contexts/CartContext';

import MobileCategoryMenu from './MobileCategoryMenu';
import MobileBenefitsBanner from './MobileBenefitsBanner';

const mobileHeaderQuery = '(width < 48rem)';
const mobileHeaderMatches = () => window.matchMedia(mobileHeaderQuery).matches;
function subscribeToWidth(update) {
  const query = window.matchMedia(mobileHeaderQuery);
  query.addEventListener('change', update);
  return () => query.removeEventListener('change', update);
}

export default function Navbar() {
  const { user, signOut } = useAuth();
  const { isAdmin } = useRole();
  const { itemCount, setIsCartOpen } = useCart();
  const navigate = useNavigate();
  const location = useLocation();
  const mobile = useSyncExternalStore(subscribeToWidth, mobileHeaderMatches, () => false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef(null);

  // Cerrar menú al hacer clic fuera
  useEffect(() => {
    function handleClickOutside(e) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target)) {
        setUserMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, []);

  const handleSignOut = async () => {
    setUserMenuOpen(false);
    await signOut();
    navigate('/');
  };

  return (
    <header className="sticky top-0 z-50 bg-white/80 backdrop-blur-xl border-b border-slate-100">
      {mobile && <MobileBenefitsBanner />}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {mobile && <MobileCategoryMenu key={location.key} isAdmin={isAdmin} user={user} />}
          {/* Logo */}
          <Link to="/" className="flex items-center gap-2 group max-md:mr-auto">
            <div className="w-9 h-9 bg-gradient-to-br from-rose-500 to-rose-600 rounded-xl flex items-center justify-center shadow-md group-hover:rotate-3 transition-transform">
              <ShoppingBag className="w-5 h-5 text-white" />
            </div>
            <span className="text-lg font-black text-slate-900 tracking-tight">Aquí Pauli</span>
          </Link>

          {/* Desktop Nav */}
          <nav className="hidden md:flex items-center gap-1">
            <Link to="/" className="px-4 py-2 text-sm font-bold text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-all">
              Inicio
            </Link>
            <Link to="/catalogo" className="px-4 py-2 text-sm font-bold text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-all">
              Catálogo
            </Link>
          </nav>

          {/* Actions */}
          <div className="flex items-center gap-2">
            {/* Cart */}
            <button
              onClick={() => setIsCartOpen(true)}
              aria-label={`Abrir carrito: ${itemCount} ${itemCount === 1 ? 'unidad' : 'unidades'}`}
              className="relative p-2.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-all"
            >
              <ShoppingCart className="w-5 h-5" />
              {itemCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 w-5 h-5 bg-rose-600 text-white text-[10px] font-black rounded-full flex items-center justify-center">
                  {itemCount}
                </span>
              )}
            </button>

            {user && !user.isAnonymous ? (
              <div className="flex items-center gap-2">
                {isAdmin && (
                  <Link
                    to="/admin"
                    className="hidden sm:flex items-center gap-1.5 px-3 py-2 text-xs font-bold text-rose-600 bg-rose-50 rounded-xl hover:bg-rose-100 transition-all"
                  >
                    <Shield className="w-3.5 h-3.5" />
                    Admin
                  </Link>
                )}
                <div className="relative" ref={userMenuRef}>
                  <button
                    onClick={() => setUserMenuOpen(!userMenuOpen)}
                    className="flex items-center gap-2 p-1.5 rounded-xl hover:bg-slate-100 transition-all"
                  >
                    {user.photoURL ? (
                      <img src={user.photoURL} alt="" className="w-8 h-8 rounded-full" referrerPolicy="no-referrer" />
                    ) : (
                      <div className="w-8 h-8 rounded-full bg-rose-600 flex items-center justify-center text-white text-xs font-bold">
                        {(user.displayName || user.email || '?')[0].toUpperCase()}
                      </div>
                    )}
                  </button>

                  {/* Dropdown — click-based */}
                  {userMenuOpen && (
                    <div className="absolute right-0 top-full mt-2 w-52 bg-white rounded-2xl shadow-xl border border-slate-100 py-2 z-[100] animate-in fade-in slide-in-from-top-2 duration-150">
                      <div className="px-4 py-2 border-b border-slate-100">
                        <p className="text-xs font-bold text-slate-900 truncate">{user.displayName || 'Usuario'}</p>
                        <p className="text-[10px] text-slate-400 truncate">{user.email}</p>
                      </div>

                      {isAdmin && (
                        <Link
                          to="/admin"
                          onClick={() => setUserMenuOpen(false)}
                          className="flex items-center gap-2 px-4 py-2.5 text-sm font-bold text-rose-600 hover:bg-rose-50 transition-colors"
                        >
                          <Shield className="w-4 h-4" /> Panel Admin
                        </Link>
                      )}

                      <Link
                        to="/mi-cuenta"
                        onClick={() => setUserMenuOpen(false)}
                        className="flex items-center gap-2 px-4 py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-50 transition-colors"
                      >
                        <ClipboardList className="w-4 h-4" /> Mis Pedidos
                      </Link>

                      <button
                        onClick={handleSignOut}
                        className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-red-500 hover:bg-red-50 transition-colors"
                      >
                        <LogOut className="w-4 h-4" /> Cerrar Sesión
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <Link
                to="/login"
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-bold text-white bg-rose-600 hover:bg-rose-700 rounded-xl transition-all shadow-md active:scale-95"
              >
                <User className="w-4 h-4" />
                <span className="hidden sm:inline">Ingresar</span>
              </Link>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
