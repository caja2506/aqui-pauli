import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { SearchX, ArrowRight } from 'lucide-react';

export default function NotFoundPage() {
  useEffect(() => {
    const prevTitle = document.title;
    document.title = 'Página no encontrada | Aquí Pauli';
    // Una SPA responde 200 en cualquier ruta: pedimos a los buscadores no indexar esta vista
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex';
    document.head.appendChild(meta);
    return () => {
      document.title = prevTitle;
      meta.remove();
    };
  }, []);

  return (
    <div className="max-w-xl mx-auto px-4 py-24 text-center" data-testid="not-found">
      <div className="w-20 h-20 rounded-2xl bg-rose-50 flex items-center justify-center mx-auto mb-6">
        <SearchX className="w-10 h-10 text-rose-300" />
      </div>
      <p className="text-sm font-black text-rose-500 tracking-widest">ERROR 404</p>
      <h1 className="text-3xl font-black text-slate-900 tracking-tight mt-2">Página no encontrada</h1>
      <p className="text-sm text-slate-400 mt-3">
        La página que buscás no existe o ya no está disponible.
      </p>
      <div className="flex flex-wrap justify-center gap-3 mt-8">
        <Link to="/" className="px-6 py-3 bg-rose-600 text-white text-sm font-bold rounded-2xl hover:bg-rose-700 transition-all">
          Ir al inicio
        </Link>
        <Link to="/catalogo" className="inline-flex items-center gap-2 px-6 py-3 bg-white text-slate-900 text-sm font-bold rounded-2xl border border-slate-200 hover:bg-slate-50 transition-all">
          Ver catálogo <ArrowRight className="w-4 h-4" />
        </Link>
      </div>
    </div>
  );
}
