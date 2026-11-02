import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Truck, Shield, CreditCard, ShoppingBag, Search } from 'lucide-react';
import { useCollection } from '../../hooks/useCollection';
import { categoryChips } from '../../utils/storeCategories';
import ProductCard from '../../components/storefront/ProductCard';
import LoadError from '../../components/ui/LoadError';
import GiveawayBanner from '../../components/storefront/GiveawayBanner';
import usePageTitle from '../../hooks/usePageTitle';

export default function HomePage() {
  usePageTitle('Aquí Pauli | Tienda online en Costa Rica');
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const { data: products, loading, error, retry } = useCollection('products', { orderByField: 'createdAt', orderDirection: 'desc' });
  const { data: categories } = useCollection('categories');
  const activeProducts = products.filter(p => p.active && !p.deleted && !p.unlisted).slice(0, 8);
  const handleSearch = (event) => {
    event.preventDefault();
    const query = search.trim();
    navigate(query ? `/catalogo?${new URLSearchParams({ q: query })}` : '/catalogo');
  };

  return (
    <div className="flex min-h-screen flex-col md:block">
      <GiveawayBanner compact />
      {/* Hero */}
      <section className="relative bg-gradient-to-b from-rose-200 via-rose-100 to-white overflow-hidden">
        <div className="absolute inset-0 opacity-30">
          <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-rose-300 rounded-full blur-[150px]" />
          <div className="absolute bottom-1/4 right-1/4 w-72 h-72 bg-rose-200 rounded-full blur-[120px]" />
        </div>
        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-4 pb-3 md:py-24">
          <div className="max-w-2xl">
            <div className="hidden md:inline-flex items-center gap-2 bg-white/60 backdrop-blur-sm px-4 py-2 rounded-full mb-6 border border-rose-200">
              <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
              <span className="text-xs font-bold text-slate-600">Envío a todo Costa Rica 🇨🇷</span>
            </div>
            <h1 className="text-xl md:text-6xl font-black tracking-tight leading-tight text-slate-900">
              <span className="md:hidden">Descubrí Aquí Pauli</span>
              <span className="hidden md:inline">Encuentra lo que<br /><span className="text-rose-500">necesitas aquí</span></span>
            </h1>
            <p className="hidden md:block text-lg text-slate-600 mt-6 leading-relaxed max-w-lg">
              Productos de calidad, con precios transparentes y envío seguro a todo el país. Compra fácil, rápido y sin complicaciones.
            </p>
            <form role="search" aria-label="Buscar en la tienda" onSubmit={handleSearch} className="flex gap-2 md:gap-3 mt-3 md:mt-6 max-w-xl">
              <label htmlFor="home-product-search" className="sr-only">Buscar productos</label>
              <div className="relative flex-1 min-w-0">
                <Search aria-hidden="true" className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                <input
                  id="home-product-search"
                  name="q"
                  type="search"
                  value={search}
                  onChange={event => setSearch(event.target.value)}
                  placeholder="Buscá perfumes, bolsos, zapatos…"
                  className="w-full pl-12 pr-3 py-2.5 md:pr-4 md:py-4 border border-rose-200 rounded-2xl text-base outline-none focus:ring-2 focus:ring-rose-500 bg-white shadow-sm"
                />
              </div>
              <button type="submit" className="px-4 py-2.5 md:px-7 md:py-4 bg-rose-600 hover:bg-rose-700 text-white font-black rounded-2xl transition-all">Buscar</button>
            </form>
            <nav aria-label="Categorías de la tienda" className="mt-2 flex gap-2 overflow-x-auto overscroll-x-contain py-1 md:hidden">
              {categoryChips(categories).map(({ id, label }) => (
                <Link key={id} to={'/catalogo?' + new URLSearchParams({ categoria: id })}
                  className="shrink-0 rounded-full border border-rose-200 bg-white px-3 py-2 text-sm font-semibold text-rose-800 focus-visible:ring-2 focus-visible:ring-rose-500">
                  {label}
                </Link>
              ))}
            </nav>
            <div className="hidden md:flex flex-wrap gap-4 mt-8">
              <Link
                to="/catalogo"
                className="inline-flex items-center gap-2 px-8 py-4 bg-white text-slate-900 font-black rounded-2xl shadow-lg hover:shadow-xl hover:scale-[1.02] active:scale-95 transition-all text-sm border border-slate-200"
              >
                Ver Catálogo
                <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="order-last mb-5 w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 md:mb-0 md:-mt-12 relative z-10">
        <div className="grid grid-cols-3 rounded-xl border border-slate-100 bg-white md:rounded-none md:border-0 md:bg-transparent md:gap-4">
          {[
            { icon: Truck, title: 'Envío Nacional', desc: 'Mensajería local o Correos, según la zona' },
            { icon: Shield, title: 'Compra Segura', desc: 'Pago protegido y verificado' },
            { icon: CreditCard, title: 'Métodos de Pago', desc: 'SINPE, PayPal, Transferencia' },
          ].map((feat, i) => (
            <div key={i} className="flex flex-col items-center justify-center gap-1 py-2 md:flex-row md:justify-start md:gap-4 md:rounded-2xl md:border md:border-slate-100 md:bg-white md:p-6 md:shadow-lg">
              <div className="md:w-12 md:h-12 md:rounded-xl md:bg-rose-50 flex items-center justify-center flex-shrink-0">
                <feat.icon className="w-4 h-4 md:w-6 md:h-6 text-rose-600" />
              </div>
              <div>
                <h3 className="text-center text-[11px] font-bold text-slate-900 md:text-left md:text-sm">{feat.title}</h3>
                <p className="hidden md:block text-xs text-slate-400">{feat.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Featured Products */}
      <section className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-4 pb-6 md:py-16">
        <div className="flex items-center justify-between mb-3 md:mb-8">
          <div>
            <h2 className="text-lg md:text-2xl font-black text-slate-900 tracking-tight">Productos Destacados</h2>
            <p className="hidden md:block text-sm text-slate-400 mt-1">Lo más nuevo en nuestra tienda</p>
          </div>
          <Link to="/catalogo" className="text-sm font-bold text-rose-600 hover:text-rose-700 flex items-center gap-1">
            Ver todos <ArrowRight className="w-4 h-4" />
          </Link>
        </div>

        {error ? (
          <LoadError onRetry={retry} />
        ) : loading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 sm:gap-6">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="bg-slate-100 rounded-3xl animate-pulse aspect-[3/4]" />
            ))}
          </div>
        ) : activeProducts.length > 0 ? (
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
