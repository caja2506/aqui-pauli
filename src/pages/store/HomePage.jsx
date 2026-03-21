import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Truck, Shield, CreditCard, ShoppingBag } from 'lucide-react';
import { useCollection } from '../../hooks/useCollection';
import ProductCard from '../../components/storefront/ProductCard';

export default function HomePage() {
  const { data: products } = useCollection('products', { orderByField: 'createdAt', orderDirection: 'desc' });
  const activeProducts = products.filter(p => p.active && !p.deleted).slice(0, 8);

  return (
    <div className="min-h-screen">
      {/* Hero */}
      <section className="relative bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 text-white overflow-hidden">
        <div className="absolute inset-0 opacity-20">
          <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-indigo-500 rounded-full blur-[150px]" />
          <div className="absolute bottom-1/4 right-1/4 w-72 h-72 bg-purple-500 rounded-full blur-[120px]" />
        </div>
        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-24 sm:py-32">
          <div className="max-w-2xl">
            <div className="inline-flex items-center gap-2 bg-white/10 backdrop-blur-sm px-4 py-2 rounded-full mb-6 border border-white/10">
              <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
              <span className="text-xs font-bold text-slate-300">Envío a todo Costa Rica 🇨🇷</span>
            </div>
            <h1 className="text-4xl sm:text-6xl font-black tracking-tight leading-tight">
              Encuentra lo que<br />
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-purple-400">necesitas aquí</span>
            </h1>
            <p className="text-lg text-slate-300 mt-6 leading-relaxed max-w-lg">
              Productos de calidad, con precios transparentes y envío seguro a todo el país. Compra fácil, rápido y sin complicaciones.
            </p>
            <div className="flex flex-wrap gap-4 mt-8">
              <Link
                to="/catalogo"
                className="inline-flex items-center gap-2 px-8 py-4 bg-white text-slate-900 font-black rounded-2xl shadow-xl hover:shadow-2xl hover:scale-[1.02] active:scale-95 transition-all text-sm"
              >
                Ver Catálogo
                <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 -mt-12 relative z-10">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[
            { icon: Truck, title: 'Envío Nacional', desc: 'Con Correos de Costa Rica' },
            { icon: Shield, title: 'Compra Segura', desc: 'Pago protegido y verificado' },
            { icon: CreditCard, title: 'Métodos de Pago', desc: 'SINPE, PayPal, Transferencia' },
          ].map((feat, i) => (
            <div key={i} className="bg-white rounded-2xl p-6 shadow-lg border border-slate-100 flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-indigo-50 flex items-center justify-center flex-shrink-0">
                <feat.icon className="w-6 h-6 text-indigo-600" />
              </div>
              <div>
                <h3 className="font-bold text-sm text-slate-900">{feat.title}</h3>
                <p className="text-xs text-slate-400">{feat.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Featured Products */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h2 className="text-2xl font-black text-slate-900 tracking-tight">Productos Destacados</h2>
            <p className="text-sm text-slate-400 mt-1">Lo más nuevo en nuestra tienda</p>
          </div>
          <Link to="/catalogo" className="text-sm font-bold text-indigo-600 hover:text-indigo-700 flex items-center gap-1">
            Ver todos <ArrowRight className="w-4 h-4" />
          </Link>
        </div>

        {activeProducts.length > 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 sm:gap-6">
            {activeProducts.map(product => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
        ) : (
          <div className="text-center py-16">
            <div className="w-20 h-20 rounded-2xl bg-slate-100 flex items-center justify-center mx-auto mb-4">
              <ShoppingBag className="w-10 h-10 text-slate-300" />
            </div>
            <p className="text-sm font-bold text-slate-400">Próximamente: productos increíbles</p>
          </div>
        )}
      </section>
    </div>
  );
}
