import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { doc, onSnapshot, collection, getDocs } from 'firebase/firestore';
import { db } from '../../firebase';
import { ShoppingCart, ArrowLeft, Check, Package, Truck } from 'lucide-react';
import { formatCRC } from '../../utils/formatters';
import { useCart } from '../../contexts/CartContext';
import StatusBadge from '../../components/ui/StatusBadge';
import LoadingSpinner from '../../components/ui/LoadingSpinner';

export default function ProductPage() {
  const { productId } = useParams();
  const { addItem, setIsCartOpen } = useCart();
  const [product, setProduct] = useState(null);
  const [variants, setVariants] = useState([]);
  const [selectedVariant, setSelectedVariant] = useState(null);
  const [quantity, setQuantity] = useState(1);
  const [loading, setLoading] = useState(true);
  const [addedToCart, setAddedToCart] = useState(false);
  const [selectedImage, setSelectedImage] = useState(0);

  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'products', productId), (snap) => {
      if (snap.exists()) {
        setProduct({ id: snap.id, ...snap.data() });
      }
    });

    getDocs(collection(db, 'products', productId, 'variants')).then((snap) => {
      const vars = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(v => v.active)
        .sort((a, b) => (a.order || 0) - (b.order || 0));
      setVariants(vars);
      if (vars.length > 0) setSelectedVariant(vars[0]);
      setLoading(false);
    });

    return () => unsub();
  }, [productId]);

  if (loading) return <LoadingSpinner message="Cargando producto..." />;
  if (!product) return (
    <div className="max-w-7xl mx-auto px-4 py-20 text-center">
      <h2 className="text-xl font-black text-slate-900">Producto no encontrado</h2>
      <Link to="/catalogo" className="text-sm font-bold text-rose-600 mt-4 inline-block">← Volver al catálogo</Link>
    </div>
  );

  const currentPrice = selectedVariant?.price || product.basePrice || 0;
  const images = product.images || [];
  if (selectedVariant?.imageUrl && !images.includes(selectedVariant.imageUrl)) {
    images.unshift(selectedVariant.imageUrl);
  }

  const handleAddToCart = () => {
    if (!selectedVariant) return;
    addItem(product, selectedVariant, quantity);
    setAddedToCart(true);
    setTimeout(() => setAddedToCart(false), 2000);
  };

  const canBuy = selectedVariant && (selectedVariant.commercialStatus === 'disponible' || selectedVariant.commercialStatus === 'bajo_pedido');

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <Link to="/catalogo" className="inline-flex items-center gap-1 text-sm font-bold text-rose-600 hover:text-rose-700 mb-6">
        <ArrowLeft className="w-4 h-4" /> Catálogo
      </Link>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-12">
        {/* Images */}
        <div className="space-y-4">
          <div className="aspect-square bg-slate-50 rounded-3xl overflow-hidden border border-slate-100">
            {images[selectedImage] ? (
              <img src={images[selectedImage]} alt={product.name} className="w-full h-full object-contain p-4" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-slate-200">
                <ShoppingCart className="w-24 h-24" />
              </div>
            )}
          </div>
          {images.length > 1 && (
            <div className="flex gap-3 overflow-x-auto pb-2">
              {images.map((img, i) => (
                <button
                  key={i}
                  onClick={() => setSelectedImage(i)}
                  className={`w-20 h-20 rounded-xl border-2 overflow-hidden flex-shrink-0 transition-all ${selectedImage === i ? 'border-rose-500 ring-2 ring-rose-200' : 'border-slate-200 hover:border-rose-300'}`}
                >
                  <img src={img} alt="" className="w-full h-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Details */}
        <div className="space-y-6">
          <div>
            <h1 className="text-2xl sm:text-3xl font-black text-slate-900 tracking-tight">{product.name}</h1>
            {product.description && (
              <p className="text-sm text-slate-500 mt-3 leading-relaxed">{product.description}</p>
            )}
          </div>

          {/* Price */}
          <div className="bg-rose-50 rounded-2xl p-5 border border-rose-100">
            <div className="text-3xl font-black text-rose-600 tracking-tight">{formatCRC(currentPrice)}</div>
            <p className="text-xs text-rose-400 mt-1">IVA incluido</p>
          </div>

          {/* Variants */}
          {variants.length > 0 && (
            <div>
              <label className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 block">Variante</label>
              <div className="flex flex-wrap gap-2">
                {variants.map(v => (
                  <button
                    key={v.id}
                    onClick={() => { setSelectedVariant(v); setQuantity(1); }}
                    className={`px-4 py-2.5 rounded-xl border text-sm font-bold transition-all ${selectedVariant?.id === v.id
                      ? 'bg-rose-600 text-white border-rose-600 shadow-md'
                      : 'bg-white text-slate-600 border-slate-200 hover:border-rose-300'
                    } ${v.commercialStatus === 'agotado' ? 'opacity-50 line-through' : ''}`}
                    disabled={v.commercialStatus === 'agotado'}
                  >
                    {v.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Status Info */}
          {selectedVariant && (
            <div className="flex items-center gap-3">
              <StatusBadge status={selectedVariant.commercialStatus} type="commercial" />
              {selectedVariant.supplyType === 'bajo_pedido' && (
                <span className="text-xs text-amber-600 font-bold flex items-center gap-1">
                  <Package className="w-3.5 h-3.5" /> Requiere anticipo del 20%
                </span>
              )}
            </div>
          )}

          {/* Quantity & Add to cart */}
          {canBuy && (
            <div className="flex items-center gap-4">
              <div className="flex items-center border border-slate-200 rounded-xl overflow-hidden">
                <button onClick={() => setQuantity(q => Math.max(1, q - 1))} className="px-4 py-3 text-slate-500 hover:bg-slate-50 text-lg font-bold">−</button>
                <span className="px-4 py-3 text-sm font-bold text-slate-900 min-w-[44px] text-center border-x border-slate-200">{quantity}</span>
                <button onClick={() => setQuantity(q => q + 1)} className="px-4 py-3 text-slate-500 hover:bg-slate-50 text-lg font-bold">+</button>
              </div>
              <button
                onClick={handleAddToCart}
                disabled={addedToCart}
                className={`flex-1 flex items-center justify-center gap-2 py-4 rounded-2xl font-black text-sm transition-all shadow-lg active:scale-95 ${
                  addedToCart
                    ? 'bg-green-500 text-white'
                    : 'bg-rose-600 hover:bg-rose-700 text-white'
                }`}
              >
                {addedToCart ? (
                  <><Check className="w-5 h-5" /> ¡Agregado!</>
                ) : (
                  <><ShoppingCart className="w-5 h-5" /> Agregar al Carrito</>
                )}
              </button>
            </div>
          )}

          {/* Shipping note */}
          <div className="bg-slate-50 rounded-2xl p-4 flex items-center gap-3">
            <Truck className="w-5 h-5 text-slate-400 flex-shrink-0" />
            <div>
              <p className="text-xs font-bold text-slate-700">Envío a todo Costa Rica</p>
              <p className="text-[10px] text-slate-400">Correos de Costa Rica · Normal y Express (Grecia)</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
