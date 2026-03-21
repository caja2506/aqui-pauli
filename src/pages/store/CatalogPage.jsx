import React, { useState, useMemo } from 'react';
import { Search, SlidersHorizontal, X } from 'lucide-react';
import { useCollection } from '../../hooks/useCollection';
import ProductCard from '../../components/storefront/ProductCard';
import EmptyState from '../../components/ui/EmptyState';

export default function CatalogPage() {
  const { data: products, loading: loadingProducts } = useCollection('products');
  const { data: brands } = useCollection('brands');
  const { data: categories } = useCollection('categories');

  const [search, setSearch] = useState('');
  const [selectedBrand, setSelectedBrand] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  const activeProducts = useMemo(() => {
    return products.filter(p => {
      if (!p.active || p.deleted) return false;
      const s = search.toLowerCase();
      const matchesSearch = !s || (p.name || '').toLowerCase().includes(s) || (p.description || '').toLowerCase().includes(s);
      const matchesBrand = !selectedBrand || (p.brandRef && p.brandRef.id === selectedBrand);
      const matchesCategory = !selectedCategory || (p.categoryRefs || []).some(ref => ref.id === selectedCategory);
      return matchesSearch && matchesBrand && matchesCategory;
    });
  }, [products, search, selectedBrand, selectedCategory]);

  const hasActiveFilters = search || selectedBrand || selectedCategory;

  const clearFilters = () => {
    setSearch('');
    setSelectedBrand('');
    setSelectedCategory('');
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-black text-slate-900 tracking-tight">Catálogo</h1>
        <p className="text-sm text-slate-400 mt-1">Explora todos nuestros productos</p>
      </div>

      {/* Search & Filters */}
      <div className="flex flex-wrap gap-3 mb-8">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar productos..."
            className="w-full pl-12 pr-4 py-3 border border-slate-200 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-indigo-500 bg-white shadow-sm"
          />
        </div>
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={`flex items-center gap-2 px-4 py-3 rounded-2xl border text-sm font-bold transition-all ${
            showFilters || hasActiveFilters
              ? 'bg-indigo-50 border-indigo-200 text-indigo-600'
              : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'
          }`}
        >
          <SlidersHorizontal className="w-4 h-4" />
          Filtros
          {hasActiveFilters && (
            <span className="w-5 h-5 bg-indigo-600 text-white text-[10px] font-black rounded-full flex items-center justify-center">
              {[search, selectedBrand, selectedCategory].filter(Boolean).length}
            </span>
          )}
        </button>
        {hasActiveFilters && (
          <button onClick={clearFilters} className="flex items-center gap-1 px-3 py-2 text-xs font-bold text-red-500 hover:bg-red-50 rounded-xl transition-all">
            <X className="w-3 h-3" /> Limpiar
          </button>
        )}
      </div>

      {/* Filter Panel */}
      {showFilters && (
        <div className="bg-white rounded-2xl border border-slate-100 p-5 mb-8 shadow-sm animate-in slide-in-from-top duration-200">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2 block">Marca</label>
              <select
                value={selectedBrand}
                onChange={e => setSelectedBrand(e.target.value)}
                className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="">Todas las marcas</option>
                {brands.filter(b => b.active !== false).map(b => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2 block">Categoría</label>
              <select
                value={selectedCategory}
                onChange={e => setSelectedCategory(e.target.value)}
                className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="">Todas las categorías</option>
                {categories.filter(c => c.active !== false).map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      )}

      {/* Products Grid */}
      {loadingProducts ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 sm:gap-6">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="bg-slate-100 rounded-3xl animate-pulse aspect-[3/4]" />
          ))}
        </div>
      ) : activeProducts.length > 0 ? (
        <>
          <p className="text-xs font-bold text-slate-400 mb-4">{activeProducts.length} producto{activeProducts.length !== 1 ? 's' : ''}</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 sm:gap-6">
            {activeProducts.map(product => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
        </>
      ) : (
        <EmptyState
          title="No se encontraron productos"
          message={hasActiveFilters ? 'Intenta cambiar los filtros de búsqueda' : 'Aún no hay productos publicados'}
          action={hasActiveFilters ? (
            <button onClick={clearFilters} className="text-sm font-bold text-indigo-600 hover:text-indigo-700">
              Limpiar filtros
            </button>
          ) : null}
        />
      )}
    </div>
  );
}
