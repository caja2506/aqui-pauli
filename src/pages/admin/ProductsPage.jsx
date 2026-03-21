import React, { useState, useEffect } from 'react';
import { Plus, Edit3, Trash2, Package, Search, Eye, EyeOff, X, ChevronDown } from 'lucide-react';
import { useCollection } from '../../hooks/useCollection';
import { createProduct, updateProduct, deleteProduct, toggleProductActive, createVariant, updateVariant, deleteVariant } from '../../services/productService';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../../firebase';
import { formatCRC } from '../../utils/formatters';
import { COMMERCIAL_STATUS_LABELS, SUPPLY_TYPES } from '../../utils/constants';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import StatusBadge from '../../components/ui/StatusBadge';
import EmptyState from '../../components/ui/EmptyState';

export default function ProductsPage() {
  const { data: products } = useCollection('products');
  const { data: brands } = useCollection('brands');
  const { data: categories } = useCollection('categories');
  const [search, setSearch] = useState('');
  const [showDeleted, setShowDeleted] = useState(false);

  // Product modal
  const [isProductModal, setIsProductModal] = useState(false);
  const [editingProduct, setEditingProduct] = useState(null);
  const [productForm, setProductForm] = useState({ name: '', description: '', brandId: '', categoryIds: [], basePrice: '', images: '' });

  // Variant modal
  const [isVariantModal, setIsVariantModal] = useState(false);
  const [variantParentId, setVariantParentId] = useState(null);
  const [editingVariant, setEditingVariant] = useState(null);
  const [variantForm, setVariantForm] = useState({ name: '', sku: '', price: '', stock: '', imageUrl: '', commercialStatus: 'disponible', supplyType: 'stock_propio' });

  // Expanded product for variants
  const [expandedProduct, setExpandedProduct] = useState(null);
  const [productVariants, setProductVariants] = useState({});

  const [confirmDelete, setConfirmDelete] = useState({ isOpen: false, title: '', message: '', onConfirm: null });

  const filteredProducts = products.filter(p => {
    if (!showDeleted && p.deleted) return false;
    const s = search.toLowerCase();
    return !s || (p.name || '').toLowerCase().includes(s);
  });

  const loadVariants = async (productId) => {
    const snap = await getDocs(collection(db, 'products', productId, 'variants'));
    const vars = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0));
    setProductVariants(prev => ({ ...prev, [productId]: vars }));
  };

  const toggleExpand = async (productId) => {
    if (expandedProduct === productId) {
      setExpandedProduct(null);
    } else {
      setExpandedProduct(productId);
      await loadVariants(productId);
    }
  };

  // Product CRUD
  const openNewProduct = () => {
    setEditingProduct(null);
    setProductForm({ name: '', description: '', brandId: '', categoryIds: [], basePrice: '', images: '' });
    setIsProductModal(true);
  };

  const openEditProduct = (product) => {
    setEditingProduct(product);
    setProductForm({
      name: product.name,
      description: product.description || '',
      brandId: product.brandRef?.id || '',
      categoryIds: (product.categoryRefs || []).map(r => r.id),
      basePrice: product.basePrice || '',
      images: (product.images || []).join('\n'),
    });
    setIsProductModal(true);
  };

  const handleSaveProduct = async (e) => {
    e.preventDefault();
    const data = {
      name: productForm.name.trim(),
      description: productForm.description.trim(),
      brandId: productForm.brandId || null,
      categoryIds: productForm.categoryIds,
      basePrice: Number(productForm.basePrice) || 0,
      images: productForm.images.split('\n').map(u => u.trim()).filter(Boolean),
    };
    if (editingProduct) {
      await updateProduct(editingProduct.id, data);
    } else {
      await createProduct(data);
    }
    setIsProductModal(false);
  };

  // Variant CRUD
  const openNewVariant = (productId) => {
    setVariantParentId(productId);
    setEditingVariant(null);
    setVariantForm({ name: '', sku: '', price: '', stock: '', imageUrl: '', commercialStatus: 'disponible', supplyType: 'stock_propio' });
    setIsVariantModal(true);
  };

  const openEditVariant = (productId, variant) => {
    setVariantParentId(productId);
    setEditingVariant(variant);
    setVariantForm({
      name: variant.name || '',
      sku: variant.sku || '',
      price: variant.price || '',
      stock: variant.stock || '',
      imageUrl: variant.imageUrl || '',
      commercialStatus: variant.commercialStatus || 'disponible',
      supplyType: variant.supplyType || 'stock_propio',
    });
    setIsVariantModal(true);
  };

  const handleSaveVariant = async (e) => {
    e.preventDefault();
    const data = {
      name: variantForm.name.trim(),
      sku: variantForm.sku.trim(),
      price: Number(variantForm.price) || 0,
      stock: Number(variantForm.stock) || 0,
      imageUrl: variantForm.imageUrl.trim(),
      commercialStatus: variantForm.commercialStatus,
      supplyType: variantForm.supplyType,
    };
    if (editingVariant) {
      await updateVariant(variantParentId, editingVariant.id, data);
    } else {
      await createVariant(variantParentId, data);
    }
    setIsVariantModal(false);
    await loadVariants(variantParentId);
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-6 rounded-3xl border border-slate-100 shadow-sm">
        <div>
          <h2 className="font-black text-2xl text-slate-800 tracking-tight">Productos</h2>
          <p className="text-sm text-slate-400 mt-1">{filteredProducts.length} producto{filteredProducts.length !== 1 ? 's' : ''}</p>
        </div>
        <button onClick={openNewProduct} className="bg-indigo-600 text-white px-6 py-3 rounded-2xl font-black shadow-lg flex items-center justify-center active:scale-95 transition-transform text-sm">
          <Plus className="mr-2 w-4 h-4" /> Nuevo Producto
        </button>
      </div>

      {/* Search */}
      <div className="flex gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar productos..." className="w-full pl-12 pr-4 py-3 border border-slate-200 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-indigo-500 bg-white shadow-sm" />
        </div>
      </div>

      {/* Products Table */}
      {filteredProducts.length > 0 ? (
        <div className="bg-white rounded-3xl border border-slate-100 shadow-sm overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 border-b text-[10px] font-black text-slate-400 uppercase tracking-widest">
              <tr>
                <th className="p-5 w-10"></th>
                <th className="p-5 w-16"></th>
                <th className="p-5">Producto</th>
                <th className="p-5 text-right">Precio Base</th>
                <th className="p-5 text-center">Estado</th>
                <th className="p-5 text-center">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredProducts.map(product => {
                const variants = productVariants[product.id] || [];
                const brandName = brands.find(b => b.id === product.brandRef?.id)?.name;

                return (
                  <React.Fragment key={product.id}>
                    <tr className={`hover:bg-slate-50 transition-colors ${product.deleted ? 'opacity-50' : ''}`}>
                      <td className="p-5">
                        <button onClick={() => toggleExpand(product.id)} className={`transition-transform ${expandedProduct === product.id ? 'rotate-180' : ''}`}>
                          <ChevronDown className="w-4 h-4 text-slate-400" />
                        </button>
                      </td>
                      <td className="p-3">
                        <div className="w-12 h-12 rounded-xl bg-slate-50 border border-slate-200 overflow-hidden">
                          {product.images?.[0] ? (
                            <img src={product.images[0]} alt="" className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center"><Package className="w-5 h-5 text-slate-200" /></div>
                          )}
                        </div>
                      </td>
                      <td className="p-5">
                        <div className="font-bold text-slate-900">{product.name}</div>
                        {brandName && <span className="text-[10px] font-bold text-slate-400">{brandName}</span>}
                      </td>
                      <td className="p-5 text-right font-black text-slate-900">{formatCRC(product.basePrice)}</td>
                      <td className="p-5 text-center">
                        <button
                          onClick={() => toggleProductActive(product.id, !product.active)}
                          className={`p-2 rounded-lg transition-all ${product.active ? 'text-green-600 bg-green-50' : 'text-slate-400 bg-slate-100'}`}
                          title={product.active ? 'Activo' : 'Inactivo'}
                        >
                          {product.active ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                        </button>
                      </td>
                      <td className="p-5 text-center">
                        <div className="flex justify-center gap-1">
                          <button onClick={() => openEditProduct(product)} className="p-2 text-amber-500 bg-amber-50 rounded-lg hover:bg-amber-100"><Edit3 className="w-4 h-4" /></button>
                          <button onClick={() => setConfirmDelete({ isOpen: true, title: 'Eliminar Producto', message: `¿Eliminar "${product.name}"?`, onConfirm: () => deleteProduct(product.id) })} className="p-2 text-red-500 bg-red-50 rounded-lg hover:bg-red-100"><Trash2 className="w-4 h-4" /></button>
                        </div>
                      </td>
                    </tr>
                    {/* Variants */}
                    {expandedProduct === product.id && (
                      <tr>
                        <td colSpan={6} className="bg-slate-50 p-5">
                          <div className="flex items-center justify-between mb-3">
                            <h4 className="text-xs font-black text-slate-500 uppercase tracking-widest">Variantes</h4>
                            <button onClick={() => openNewVariant(product.id)} className="text-xs font-bold text-indigo-600 flex items-center gap-1 hover:text-indigo-700">
                              <Plus className="w-3 h-3" /> Agregar
                            </button>
                          </div>
                          {variants.length > 0 ? (
                            <div className="space-y-2">
                              {variants.map(v => (
                                <div key={v.id} className="bg-white p-4 rounded-xl border border-slate-200 flex items-center justify-between">
                                  <div className="flex items-center gap-4">
                                    <div className="w-10 h-10 rounded-lg bg-slate-50 border overflow-hidden">
                                      {v.imageUrl ? <img src={v.imageUrl} alt="" className="w-full h-full object-cover" /> : <div className="w-full h-full" />}
                                    </div>
                                    <div>
                                      <span className="font-bold text-slate-900 text-sm">{v.name || 'Sin nombre'}</span>
                                      <div className="flex items-center gap-2 mt-0.5">
                                        <span className="text-xs text-slate-400">SKU: {v.sku || '—'}</span>
                                        <span className="text-xs font-bold text-indigo-600">{formatCRC(v.price)}</span>
                                        <span className="text-xs text-slate-400">Stock: {v.stock}</span>
                                        <StatusBadge status={v.commercialStatus} type="commercial" />
                                      </div>
                                    </div>
                                  </div>
                                  <div className="flex gap-1">
                                    <button onClick={() => openEditVariant(product.id, v)} className="p-1.5 text-amber-500 bg-amber-50 rounded-lg hover:bg-amber-100"><Edit3 className="w-3.5 h-3.5" /></button>
                                    <button onClick={() => { setConfirmDelete({ isOpen: true, title: 'Eliminar Variante', message: `¿Eliminar "${v.name}"?`, onConfirm: async () => { await deleteVariant(product.id, v.id); await loadVariants(product.id); } }); }} className="p-1.5 text-red-500 bg-red-50 rounded-lg hover:bg-red-100"><Trash2 className="w-3.5 h-3.5" /></button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="text-xs text-slate-400 text-center py-4">No hay variantes. Agrega al menos una para poder vender este producto.</p>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState icon={Package} title="Sin productos" message="Crea el primer producto de tu catálogo" />
      )}

      {/* Product Modal */}
      {isProductModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[250] flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg p-6 animate-in zoom-in duration-200 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-6 border-b pb-4">
              <h2 className="font-black text-xl tracking-tighter">{editingProduct ? 'Editar' : 'Nuevo'} Producto</h2>
              <button onClick={() => setIsProductModal(false)} className="p-2 text-slate-400 hover:bg-slate-100 rounded-full"><X className="w-4 h-4" /></button>
            </div>
            <form onSubmit={handleSaveProduct} className="space-y-4">
              <div>
                <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Nombre *</label>
                <input value={productForm.name} onChange={e => setProductForm({ ...productForm, name: e.target.value })} className="w-full p-4 border border-slate-200 rounded-2xl bg-slate-50 outline-none focus:ring-2 focus:ring-indigo-500 font-bold" required />
              </div>
              <div>
                <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Descripción</label>
                <textarea value={productForm.description} onChange={e => setProductForm({ ...productForm, description: e.target.value })} className="w-full p-4 border border-slate-200 rounded-2xl bg-slate-50 outline-none focus:ring-2 focus:ring-indigo-500" rows={3} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Marca</label>
                  <select value={productForm.brandId} onChange={e => setProductForm({ ...productForm, brandId: e.target.value })} className="w-full p-3 border border-slate-200 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-indigo-500">
                    <option value="">Sin marca</option>
                    {brands.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Precio Base (₡)</label>
                  <input type="number" value={productForm.basePrice} onChange={e => setProductForm({ ...productForm, basePrice: e.target.value })} className="w-full p-3 border border-slate-200 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
              </div>
              <div>
                <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Categorías</label>
                <div className="flex flex-wrap gap-2">
                  {categories.map(cat => (
                    <label key={cat.id} className={`px-3 py-1.5 rounded-lg border text-xs font-bold cursor-pointer transition-all ${productForm.categoryIds.includes(cat.id) ? 'bg-indigo-50 border-indigo-300 text-indigo-600' : 'bg-slate-50 border-slate-200 text-slate-500'}`}>
                      <input type="checkbox" className="hidden" checked={productForm.categoryIds.includes(cat.id)}
                        onChange={() => setProductForm(prev => ({
                          ...prev,
                          categoryIds: prev.categoryIds.includes(cat.id)
                            ? prev.categoryIds.filter(id => id !== cat.id)
                            : [...prev.categoryIds, cat.id]
                        }))} />
                      {cat.name}
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">URLs de Imágenes (una por línea)</label>
                <textarea value={productForm.images} onChange={e => setProductForm({ ...productForm, images: e.target.value })} placeholder="https://ejemplo.com/imagen1.jpg" className="w-full p-4 border border-slate-200 rounded-2xl bg-slate-50 outline-none focus:ring-2 focus:ring-indigo-500 font-mono text-xs" rows={3} />
              </div>
              <button type="submit" className="w-full p-4 bg-indigo-600 text-white rounded-2xl font-black shadow-lg hover:bg-indigo-700 active:scale-95 transition-all">
                {editingProduct ? 'Actualizar' : 'Crear Producto'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Variant Modal */}
      {isVariantModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[250] flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md p-6 animate-in zoom-in duration-200">
            <div className="flex justify-between items-center mb-6 border-b pb-4">
              <h2 className="font-black text-xl tracking-tighter">{editingVariant ? 'Editar' : 'Nueva'} Variante</h2>
              <button onClick={() => setIsVariantModal(false)} className="p-2 text-slate-400 hover:bg-slate-100 rounded-full"><X className="w-4 h-4" /></button>
            </div>
            <form onSubmit={handleSaveVariant} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Nombre</label>
                  <input value={variantForm.name} onChange={e => setVariantForm({ ...variantForm, name: e.target.value })} placeholder="Rojo / XL" className="w-full p-3 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">SKU</label>
                  <input value={variantForm.sku} onChange={e => setVariantForm({ ...variantForm, sku: e.target.value })} className="w-full p-3 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Precio (₡)</label>
                  <input type="number" value={variantForm.price} onChange={e => setVariantForm({ ...variantForm, price: e.target.value })} className="w-full p-3 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Stock</label>
                  <input type="number" value={variantForm.stock} onChange={e => setVariantForm({ ...variantForm, stock: e.target.value })} className="w-full p-3 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Estado Comercial</label>
                  <select value={variantForm.commercialStatus} onChange={e => setVariantForm({ ...variantForm, commercialStatus: e.target.value })} className="w-full p-3 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-indigo-500">
                    {Object.entries(COMMERCIAL_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Abastecimiento</label>
                  <select value={variantForm.supplyType} onChange={e => setVariantForm({ ...variantForm, supplyType: e.target.value })} className="w-full p-3 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-indigo-500">
                    <option value="stock_propio">Stock Propio</option>
                    <option value="bajo_pedido">Bajo Pedido</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">URL Imagen</label>
                <input value={variantForm.imageUrl} onChange={e => setVariantForm({ ...variantForm, imageUrl: e.target.value })} placeholder="https://..." className="w-full p-3 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <button type="submit" className="w-full p-4 bg-indigo-600 text-white rounded-2xl font-black shadow-lg hover:bg-indigo-700 active:scale-95 transition-all">
                {editingVariant ? 'Actualizar' : 'Crear Variante'}
              </button>
            </form>
          </div>
        </div>
      )}

      <ConfirmDialog {...confirmDelete} onClose={() => setConfirmDelete({ isOpen: false, onConfirm: null })} />
    </div>
  );
}
