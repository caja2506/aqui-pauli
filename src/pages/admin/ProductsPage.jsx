import { useState } from 'react';
import { Plus, Edit3, Trash2, Package, Search, Eye, EyeOff, X, ChevronDown, Tag, RefreshCw } from 'lucide-react';
import { useCollection } from '../../hooks/useCollection';
import { createProduct, updateProduct, deleteProduct, toggleProductActive, createVariant, updateVariant, deleteVariant, createBrand, updateBrand, deleteBrand, createCategory, updateCategory, deleteCategory } from '../../services/productService';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../../firebase';
import { formatCRC } from '../../utils/formatters';
import { COMMERCIAL_STATUS_LABELS } from '../../utils/constants';
import { getFunctions, httpsCallable } from 'firebase/functions';
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

  // Manager modals
  const [showBrandManager, setShowBrandManager] = useState(false);
  const [brandEdits, setBrandEdits] = useState([]);
  const [showCategoryManager, setShowCategoryManager] = useState(false);
  const [categoryEdits, setCategoryEdits] = useState([]);

  // WhatsApp catalog sync
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);

  const handleSyncCatalog = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const functions = getFunctions();
      const syncFn = httpsCallable(functions, 'syncCatalogBatch');
      const result = await syncFn();
      setSyncResult(result.data);
      setTimeout(() => setSyncResult(null), 8000);
    } catch (err) {
      setSyncResult({ success: false, message: err.message });
      setTimeout(() => setSyncResult(null), 8000);
    }
    setSyncing(false);
  };

  const openBrandManager = () => {
    setBrandEdits(brands.map(b => ({ id: b.id, name: b.name, isNew: false, deleted: false })));
    setShowBrandManager(true);
  };

  const openCategoryManager = () => {
    setCategoryEdits(categories.map(c => ({ id: c.id, name: c.name, isNew: false, deleted: false })));
    setShowCategoryManager(true);
  };

  const handleSaveBrands = async () => {
    for (const item of brandEdits) {
      if (item.deleted && !item.isNew) {
        await deleteBrand(item.id);
      } else if (item.isNew && !item.deleted && item.name.trim()) {
        await createBrand(item.name.trim());
      } else if (!item.isNew && !item.deleted) {
        const original = brands.find(b => b.id === item.id);
        if (original && original.name !== item.name && item.name.trim()) {
          await updateBrand(item.id, { name: item.name.trim() });
        }
      }
    }
    setShowBrandManager(false);
  };

  const handleSaveCategories = async () => {
    for (const item of categoryEdits) {
      if (item.deleted && !item.isNew) {
        await deleteCategory(item.id);
      } else if (item.isNew && !item.deleted && item.name.trim()) {
        await createCategory({ name: item.name.trim() });
      } else if (!item.isNew && !item.deleted) {
        const original = categories.find(c => c.id === item.id);
        if (original && original.name !== item.name && item.name.trim()) {
          await updateCategory(item.id, { name: item.name.trim() });
        }
      }
    }
    setShowCategoryManager(false);
  };

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

  // SKU generator
  const generateSku = (productName, variantName) => {
    const clean = (s) => (s || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Z0-9]/g, '').slice(0, 4);
    const base = clean(productName);
    const variant = clean(variantName);
    const rand = String(Math.floor(Math.random() * 900) + 100);
    return [base, variant, rand].filter(Boolean).join('-');
  };

  // Variant CRUD
  const openNewVariant = (productId) => {
    const parentProduct = products.find(p => p.id === productId);
    const autoSku = generateSku(parentProduct?.name, '');
    setVariantParentId(productId);
    setEditingVariant(null);
    setVariantForm({ name: '', sku: autoSku, price: parentProduct?.basePrice || '', stock: '', imageUrl: '', commercialStatus: 'disponible', supplyType: 'stock_propio' });
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
        <div className="flex items-center gap-2">
          <button
            onClick={handleSyncCatalog}
            disabled={syncing}
            className={`px-4 py-3 rounded-2xl font-bold text-sm flex items-center gap-2 transition-all ${
              syncing
                ? 'bg-green-100 text-green-600 cursor-wait'
                : 'bg-green-50 text-green-700 hover:bg-green-100 active:scale-95 border border-green-200'
            }`}
          >
            <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Sincronizando...' : 'Sync WhatsApp'}
          </button>
          <button onClick={openNewProduct} className="bg-rose-600 text-white px-6 py-3 rounded-2xl font-black shadow-lg flex items-center justify-center active:scale-95 transition-transform text-sm">
            <Plus className="mr-2 w-4 h-4" /> Nuevo Producto
          </button>
        </div>
      </div>

      {/* Sync result banner */}
      {syncResult && (
        <div className={`p-4 rounded-2xl text-sm font-bold animate-in fade-in duration-300 ${
          syncResult.success ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'
        }`}>
          {syncResult.success ? '✅' : '❌'} {syncResult.message}
        </div>
      )}

      {/* Search */}
      <div className="flex gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar productos..." className="w-full pl-12 pr-4 py-3 border border-slate-200 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-rose-500 bg-white shadow-sm" />
        </div>
      </div>

      {/* Products */}
      {filteredProducts.length > 0 ? (
        <div className="space-y-3">
          {filteredProducts.map(product => {
            const variants = productVariants[product.id] || [];
            const brandName = brands.find(b => b.id === product.brandRef?.id)?.name;

            return (
              <div key={product.id} className={`bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden ${product.deleted ? 'opacity-50' : ''}`}>
                {/* Product row */}
                <div className="flex items-center gap-3 p-4">
                  {/* Expand toggle */}
                  <button onClick={() => toggleExpand(product.id)} className={`shrink-0 transition-transform ${expandedProduct === product.id ? 'rotate-180' : ''}`}>
                    <ChevronDown className="w-4 h-4 text-slate-400" />
                  </button>

                  {/* Image */}
                  <div className="w-12 h-12 rounded-xl bg-slate-50 border border-slate-200 overflow-hidden shrink-0">
                    {product.images?.[0] ? (
                      <img src={product.images[0]} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center"><Package className="w-5 h-5 text-slate-200" /></div>
                    )}
                  </div>

                  {/* Info */}
                  <div className="min-w-0 flex-1">
                    <div className="font-bold text-slate-900 text-sm truncate">{product.name}</div>
                    <div className="flex items-center gap-2 flex-wrap">
                      {brandName && <span className="text-[10px] font-bold text-slate-400">{brandName}</span>}
                      <span className="text-xs font-black text-rose-600">{formatCRC(product.basePrice)}</span>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => toggleProductActive(product.id, !product.active)}
                      className={`p-2 rounded-lg transition-all ${product.active ? 'text-green-600 bg-green-50' : 'text-slate-400 bg-slate-100'}`}
                      title={product.active ? 'Activo' : 'Inactivo'}
                    >
                      {product.active ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                    </button>
                    <button onClick={() => openEditProduct(product)} className="p-2 text-amber-500 bg-amber-50 rounded-lg hover:bg-amber-100">
                      <Edit3 className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => setConfirmDelete({
                        isOpen: true,
                        title: 'Eliminar Producto',
                        message: `¿Eliminar "${product.name}"? Esta acción no se puede deshacer.`,
                        onConfirm: () => deleteProduct(product.id),
                      })}
                      className="p-2 text-red-500 bg-red-50 rounded-lg hover:bg-red-100"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Variants (expanded) */}
                {expandedProduct === product.id && (
                  <div className="bg-slate-50 border-t border-slate-100 p-4">
                    <div className="flex items-center justify-between mb-3">
                      <h4 className="text-xs font-black text-slate-500 uppercase tracking-widest">Variantes</h4>
                      <button onClick={() => openNewVariant(product.id)} className="text-xs font-bold text-rose-600 flex items-center gap-1 hover:text-rose-700">
                        <Plus className="w-3 h-3" /> Agregar
                      </button>
                    </div>
                    {variants.length > 0 ? (
                      <div className="space-y-2">
                        {variants.map(v => (
                          <div key={v.id} className="bg-white p-3 rounded-xl border border-slate-200 flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-slate-50 border overflow-hidden shrink-0">
                              {v.imageUrl ? <img src={v.imageUrl} alt="" className="w-full h-full object-cover" /> : <div className="w-full h-full" />}
                            </div>
                            <div className="min-w-0 flex-1">
                              <span className="font-bold text-slate-900 text-sm truncate block">{v.name || 'Sin nombre'}</span>
                              <div className="flex items-center gap-2 flex-wrap mt-0.5">
                                <span className="text-[10px] text-slate-400">SKU: {v.sku || '—'}</span>
                                <span className="text-xs font-bold text-rose-600">{formatCRC(v.price)}</span>
                                <span className="text-[10px] text-slate-400">Stock: {v.stock}</span>
                                <StatusBadge status={v.commercialStatus} type="commercial" />
                              </div>
                            </div>
                            <div className="flex gap-1 shrink-0">
                              <button onClick={() => openEditVariant(product.id, v)} className="p-1.5 text-amber-500 bg-amber-50 rounded-lg hover:bg-amber-100"><Edit3 className="w-3.5 h-3.5" /></button>
                              <button onClick={() => { setConfirmDelete({ isOpen: true, title: 'Eliminar Variante', message: `¿Eliminar "${v.name}"?`, onConfirm: async () => { await deleteVariant(product.id, v.id); await loadVariants(product.id); } }); }} className="p-1.5 text-red-500 bg-red-50 rounded-lg hover:bg-red-100"><Trash2 className="w-3.5 h-3.5" /></button>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-slate-400 text-center py-4">No hay variantes. Agrega al menos una para poder vender este producto.</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
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
                <input value={productForm.name} onChange={e => setProductForm({ ...productForm, name: e.target.value })} className="w-full p-4 border border-slate-200 rounded-2xl bg-slate-50 outline-none focus:ring-2 focus:ring-rose-500 font-bold" required />
              </div>
              <div>
                <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Descripción</label>
                <textarea value={productForm.description} onChange={e => setProductForm({ ...productForm, description: e.target.value })} className="w-full p-4 border border-slate-200 rounded-2xl bg-slate-50 outline-none focus:ring-2 focus:ring-rose-500" rows={3} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs font-bold text-slate-400 uppercase">Marca</label>
                    <button type="button" onClick={openBrandManager} className="text-[10px] font-bold text-rose-600 hover:text-rose-700 flex items-center gap-0.5">
                      <Plus className="w-3 h-3" /> Nueva
                    </button>
                  </div>
                  <select value={productForm.brandId} onChange={e => setProductForm({ ...productForm, brandId: e.target.value })} className="w-full p-3 border border-slate-200 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-rose-500">
                    <option value="">Sin marca</option>
                    {brands.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Precio Base (₡)</label>
                  <input type="number" value={productForm.basePrice} onChange={e => setProductForm({ ...productForm, basePrice: e.target.value })} className="w-full p-3 border border-slate-200 rounded-2xl text-sm outline-none focus:ring-2 focus:ring-rose-500" />
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-bold text-slate-400 uppercase">Categorías</label>
                  <button type="button" onClick={openCategoryManager} className="text-[10px] font-bold text-rose-600 hover:text-rose-700 flex items-center gap-0.5">
                    <Plus className="w-3 h-3" /> Nueva
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {categories.map(cat => (
                    <label key={cat.id} className={`px-3 py-1.5 rounded-lg border text-xs font-bold cursor-pointer transition-all ${productForm.categoryIds.includes(cat.id) ? 'bg-rose-50 border-rose-300 text-rose-600' : 'bg-slate-50 border-slate-200 text-slate-500'}`}>
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
                <textarea value={productForm.images} onChange={e => setProductForm({ ...productForm, images: e.target.value })} placeholder="https://ejemplo.com/imagen1.jpg" className="w-full p-4 border border-slate-200 rounded-2xl bg-slate-50 outline-none focus:ring-2 focus:ring-rose-500 font-mono text-xs" rows={3} />
              </div>
              <button type="submit" className="w-full p-4 bg-rose-600 text-white rounded-2xl font-black shadow-lg hover:bg-rose-700 active:scale-95 transition-all">
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
                  <input value={variantForm.name} onChange={e => {
                    const newName = e.target.value;
                    const parentProduct = products.find(p => p.id === variantParentId);
                    const updates = { ...variantForm, name: newName };
                    if (!editingVariant) updates.sku = generateSku(parentProduct?.name, newName);
                    setVariantForm(updates);
                  }} placeholder="Rojo / XL" className="w-full p-3 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-rose-500" />
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">SKU</label>
                  <input value={variantForm.sku} onChange={e => setVariantForm({ ...variantForm, sku: e.target.value })} className="w-full p-3 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-rose-500" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Precio (₡)</label>
                  <input type="number" value={variantForm.price} onChange={e => setVariantForm({ ...variantForm, price: e.target.value })} className="w-full p-3 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-rose-500" />
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Stock</label>
                  <input type="number" value={variantForm.stock} onChange={e => setVariantForm({ ...variantForm, stock: e.target.value })} className="w-full p-3 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-rose-500" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Estado Comercial</label>
                  <select value={variantForm.commercialStatus} onChange={e => setVariantForm({ ...variantForm, commercialStatus: e.target.value })} className="w-full p-3 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-rose-500">
                    {Object.entries(COMMERCIAL_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">Abastecimiento</label>
                  <select value={variantForm.supplyType} onChange={e => setVariantForm({ ...variantForm, supplyType: e.target.value })} className="w-full p-3 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-rose-500">
                    <option value="stock_propio">Stock Propio</option>
                    <option value="bajo_pedido">Bajo Pedido</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">URL Imagen</label>
                <input value={variantForm.imageUrl} onChange={e => setVariantForm({ ...variantForm, imageUrl: e.target.value })} placeholder="https://..." className="w-full p-3 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-rose-500" />
              </div>
              <button type="submit" className="w-full p-4 bg-rose-600 text-white rounded-2xl font-black shadow-lg hover:bg-rose-700 active:scale-95 transition-all">
                {editingVariant ? 'Actualizar' : 'Crear Variante'}
              </button>
            </form>
          </div>
        </div>
      )}

      <ConfirmDialog {...confirmDelete} onClose={() => setConfirmDelete({ isOpen: false, onConfirm: null })} />

      {/* Gestionar Marcas */}
      {showBrandManager && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[300] flex items-center justify-center p-4">
          <div className="bg-slate-900 rounded-3xl shadow-2xl w-full max-w-md p-6 animate-in zoom-in duration-150 max-h-[85vh] flex flex-col">
            <div className="flex items-center gap-3 mb-6">
              <Tag className="w-5 h-5 text-rose-400" />
              <h3 className="font-black text-lg text-white">Gestionar Marcas</h3>
            </div>
            <div className="space-y-2 overflow-y-auto flex-1 pr-1 mb-4">
              {brandEdits.filter(b => !b.deleted).map((item, idx) => (
                <div key={item.id || `new-${idx}`} className="flex items-center gap-2">
                  <input
                    value={item.name}
                    onChange={e => setBrandEdits(prev => prev.map((b, i) => i === idx || b.id === item.id ? { ...b, name: e.target.value } : b))}
                    className="flex-1 p-3 bg-slate-800 border border-slate-700 rounded-xl text-sm text-white outline-none focus:ring-2 focus:ring-rose-500 font-medium"
                    placeholder="Nombre de la marca"
                  />
                  <button
                    onClick={() => setBrandEdits(prev => prev.map(b => b === item ? { ...b, deleted: true } : b))}
                    className="p-2 text-red-400 hover:text-red-300 hover:bg-red-900/30 rounded-lg transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
            <button
              onClick={() => setBrandEdits(prev => [...prev, { id: `new-${Date.now()}`, name: '', isNew: true, deleted: false }])}
              className="w-full p-3 border border-dashed border-amber-500/50 rounded-xl text-amber-400 text-sm font-bold hover:bg-amber-500/10 transition-colors mb-4 flex items-center justify-center gap-1"
            >
              <Plus className="w-4 h-4" /> Agregar otro
            </button>
            <div className="flex gap-3">
              <button onClick={() => setShowBrandManager(false)} className="flex-1 p-3 bg-slate-800 text-slate-300 rounded-xl font-bold text-sm hover:bg-slate-700 transition-colors">
                Cancelar
              </button>
              <button onClick={handleSaveBrands} className="flex-1 p-3 bg-indigo-600 text-white rounded-xl font-black text-sm hover:bg-indigo-700 active:scale-95 transition-all shadow-lg">
                Guardar Cambios
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Gestionar Categorías */}
      {showCategoryManager && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[300] flex items-center justify-center p-4">
          <div className="bg-slate-900 rounded-3xl shadow-2xl w-full max-w-md p-6 animate-in zoom-in duration-150 max-h-[85vh] flex flex-col">
            <div className="flex items-center gap-3 mb-6">
              <Tag className="w-5 h-5 text-rose-400" />
              <h3 className="font-black text-lg text-white">Gestionar Categorías</h3>
            </div>
            <div className="space-y-2 overflow-y-auto flex-1 pr-1 mb-4">
              {categoryEdits.filter(c => !c.deleted).map((item, idx) => (
                <div key={item.id || `new-${idx}`} className="flex items-center gap-2">
                  <input
                    value={item.name}
                    onChange={e => setCategoryEdits(prev => prev.map((c, i) => i === idx || c.id === item.id ? { ...c, name: e.target.value } : c))}
                    className="flex-1 p-3 bg-slate-800 border border-slate-700 rounded-xl text-sm text-white outline-none focus:ring-2 focus:ring-rose-500 font-medium"
                    placeholder="Nombre de la categoría"
                  />
                  <button
                    onClick={() => setCategoryEdits(prev => prev.map(c => c === item ? { ...c, deleted: true } : c))}
                    className="p-2 text-red-400 hover:text-red-300 hover:bg-red-900/30 rounded-lg transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
            <button
              onClick={() => setCategoryEdits(prev => [...prev, { id: `new-${Date.now()}`, name: '', isNew: true, deleted: false }])}
              className="w-full p-3 border border-dashed border-amber-500/50 rounded-xl text-amber-400 text-sm font-bold hover:bg-amber-500/10 transition-colors mb-4 flex items-center justify-center gap-1"
            >
              <Plus className="w-4 h-4" /> Agregar otro
            </button>
            <div className="flex gap-3">
              <button onClick={() => setShowCategoryManager(false)} className="flex-1 p-3 bg-slate-800 text-slate-300 rounded-xl font-bold text-sm hover:bg-slate-700 transition-colors">
                Cancelar
              </button>
              <button onClick={handleSaveCategories} className="flex-1 p-3 bg-indigo-600 text-white rounded-xl font-black text-sm hover:bg-indigo-700 active:scale-95 transition-all shadow-lg">
                Guardar Cambios
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
