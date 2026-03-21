import { ShoppingBag, Instagram } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function Footer() {
  return (
    <footer className="bg-slate-900 text-white mt-auto">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {/* Brand */}
          <div>
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 bg-gradient-to-br from-rose-500 to-rose-600 rounded-lg flex items-center justify-center">
                <ShoppingBag className="w-4 h-4 text-white" />
              </div>
              <span className="text-lg font-black tracking-tight">Aquí Pauli</span>
            </div>
            <p className="text-sm text-slate-400 leading-relaxed">
              Tu tienda online en Costa Rica. Productos de calidad con envío a todo el país.
            </p>
          </div>

          {/* Links */}
          <div>
            <h3 className="text-xs font-black uppercase tracking-widest text-slate-400 mb-4">Tienda</h3>
            <div className="space-y-2">
              <Link to="/catalogo" className="block text-sm text-slate-300 hover:text-white transition-colors">Catálogo</Link>
              <Link to="/carrito" className="block text-sm text-slate-300 hover:text-white transition-colors">Mi Carrito</Link>
            </div>
          </div>

          {/* Contact */}
          <div>
            <h3 className="text-xs font-black uppercase tracking-widest text-slate-400 mb-4">Contacto</h3>
            <div className="space-y-2 text-sm text-slate-300">
              <p>WhatsApp: +506 0000-0000</p>
              <p>Email: info@aquipauli.com</p>
              <a
                href="https://www.instagram.com/aqui.paulina"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-slate-300 hover:text-rose-400 transition-colors"
              >
                <Instagram className="w-4 h-4" />
                @aqui.paulina
              </a>
              <p>Costa Rica 🇨🇷</p>
            </div>
          </div>
        </div>

        <div className="border-t border-slate-800 mt-8 pt-6 text-center">
          <p className="text-[11px] text-slate-500">© 2025 Aquí Pauli — Todos los derechos reservados</p>
        </div>
      </div>
    </footer>
  );
}
