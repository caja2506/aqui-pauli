import { useState, useEffect, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { doc, onSnapshot, collection } from 'firebase/firestore';
import { db } from '../../firebase';
import { ShoppingCart, ArrowLeft, Check, MessageCircle, Package, Truck } from 'lucide-react';
import { formatCRC } from '../../utils/formatters';
import { BACKORDER_DEPOSIT_LABEL } from '../../utils/backorder';
import { useCart } from '../../contexts/CartContext';
import { cleanShippingPromise } from '../../utils/shippingText';
import { CONTACT } from '../../components/legal/LegalLayout';
import MobileCartBar from '../../components/storefront/MobileCartBar';
import StatusBadge from '../../components/ui/StatusBadge';
import { normalizeCommercialStatus } from '../../utils/constants';
import LoadingSpinner from '../../components/ui/LoadingSpinner';
import { getVariantPrice, getProductPriceSummary, isActiveVariant, isPurchasableVariant } from '../../utils/productPrice';
import { track, productEvent } from '../../utils/pixel';
import usePageTitle from '../../hooks/usePageTitle';
import { isFullPerfume } from '../../../functions/lib/catalogSafety.mjs';

export default function ProductPage() {
  const { productId } = useParams();
  // Cambiar de producto reinicia selección, cantidad, fotos y carga de variantes.
  return <ProductDetails key={productId} productId={productId} />;
}

function ProductDetails({ productId }) {
  const { addItem } = useCart();
  const [product, setProduct] = useState(null);
  const [variants, setVariants] = useState([]);
  const [selectedVariant, setSelectedVariant] = useState(null);
  const [quantity, setQuantity] = useState(1);
  const [loading, setLoading] = useState(true);
  const [addedToCart, setAddedToCart] = useState(false);
  const [selectedImage, setSelectedImage] = useState(0);
  const [variantError, setVariantError] = useState(false);
  const variantSectionRef = useRef(null);
  const addToCartLock = useRef(false);

  usePageTitle(product?.name ? `${product.name} | Aquí Pauli` : 'Producto | Aquí Pauli');

  useEffect(() => {
    let active = true;
    const unsub = onSnapshot(doc(db, 'products', productId), (snap) => {
      if (active) setProduct(snap.exists() ? { id: snap.id, ...snap.data() } : null);
    });

    const unsubVariants = onSnapshot(collection(db, 'products', productId, 'variants'), (snap) => {
      if (!active) return;
      const vars = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(isActiveVariant)
        .sort((a, b) => (a.order || 0) - (b.order || 0));
      setVariants(vars);
      // Si solo hay 1 variante, auto-seleccionar; si hay más, el usuario debe elegir
      setSelectedVariant(current => vars.find(v => v.id === current?.id) || (vars.length === 1 ? vars[0] : null));
      setLoading(false);
    }, (err) => {
      if (!active) return;
      console.warn('No se pudieron cargar las variantes:', err);
      setVariantError(true);
      setLoading(false);
    });

    return () => { active = false; unsub(); unsubVariants(); };
  }, [productId]);

  const viewed = useRef(false);
  useEffect(() => {
    if (viewed.current || loading || variantError || !product?.active || product.deleted || product.unlisted) return;
    const { price, mainVariant } = getProductPriceSummary(product, variants);
    if (price === null) return;
    viewed.current = track('ViewContent', { ...productEvent(product, mainVariant, price), content_name: product.name });
  }, [loading, variantError, product, variants]);

  if (loading) return <><LoadingSpinner message="Cargando producto..." /><MobileCartBar /></>;
  if (!product || product.active === false || product.deleted) return (
    <div className="max-w-7xl mx-auto px-4 py-20 text-center">
      <h2 className="text-xl font-black text-slate-900">{product ? 'Producto no disponible' : 'Producto no encontrado'}</h2>
      <Link to="/catalogo" className="text-sm font-bold text-rose-600 mt-4 inline-block">← Volver al catálogo</Link>
      <MobileCartBar />
    </div>
  );

  const priceSummary = getProductPriceSummary(product, variants);
  const currentPrice = variantError ? null
    : selectedVariant ? getVariantPrice(product, selectedVariant) : priceSummary.price;
  const showFrom = !selectedVariant && priceSummary.isFrom;
  const images = [...(product.images || [])];
  if (selectedVariant?.imageUrl && !images.includes(selectedVariant.imageUrl)) {
    images.unshift(selectedVariant.imageUrl);
  }

  const handleAddToCart = () => {
    if (addToCartLock.current || !isPurchasableVariant(selectedVariant, product, quantity) || currentPrice === null) return;
    addToCartLock.current = true;
    addItem(product, { ...selectedVariant, price: currentPrice }, quantity);
    if (!product.unlisted) track('AddToCart', productEvent(product, selectedVariant, currentPrice, quantity));
    setAddedToCart(true);
    setTimeout(() => { addToCartLock.current = false; setAddedToCart(false); }, 2000);
  };

  const canBuy = isPurchasableVariant(selectedVariant, product, quantity) && currentPrice !== null;
  const purchaseOptions = variantError ? [] : variants.filter(variant =>
    isPurchasableVariant(variant, product) && getVariantPrice(product, variant) !== null);
  const hasPurchasableOption = purchaseOptions.length > 0;
  const canArrangeCash = purchaseOptions.some(variant =>
    (!selectedVariant || variant.id === selectedVariant.id) &&
    (variant.supplyType ?? product.supplyType ?? 'stock_propio') === 'stock_propio');
  const productLink = `https://${CONTACT.site}/producto/${encodeURIComponent(productId)}`;
  const description = [product.name, selectedVariant?.name, currentPrice === null ? 'precio por confirmar' : formatCRC(currentPrice)]
    .filter(Boolean).join(' - ');
  const message = `Hola, quiero ${hasPurchasableOption ? 'comprar' : 'consultar disponibilidad de'}: ${description}. ${productLink}`;
  const whatsAppButton = (
    <a href={`${CONTACT.whatsappUrl}?text=${encodeURIComponent(message)}`}
      target="_blank" rel="noopener noreferrer"
      className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-[#25D366] px-4 py-3 text-sm font-black text-slate-950 hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800">
      <MessageCircle className="h-5 w-5" aria-hidden="true" />
      {hasPurchasableOption ? 'Comprar por WhatsApp' : 'Consultar disponibilidad'}
    </a>
  );
  const chooseVariant = () => {
    variantSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    variantSectionRef.current?.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-8 pb-[calc(14rem+env(safe-area-inset-bottom,0px))] lg:pb-8">
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
        <div className="flex flex-col gap-6">
          <div>
            <h1 className="text-[22px] max-md:leading-tight md:text-3xl font-black text-slate-900 tracking-tight">{product.name}</h1>
            {product.description && (
              <p className="text-sm text-slate-500 mt-3 leading-relaxed">{isFullPerfume(product) && /bajo pedido/i.test(product.description)
                  ? 'Disponible únicamente con existencias. No se aceptan pedidos de colonias agotadas.'
                  : cleanShippingPromise(product.description)}</p>
            )}
          </div>

          {/* Price */}
          <div className="bg-rose-50 rounded-2xl p-5 border border-rose-100">
            <div className="text-2xl md:text-3xl font-black text-rose-600 tracking-tight" aria-live="polite" data-testid="product-price">
              {currentPrice === null ? 'Precio no disponible' : <>{showFrom && <span className="text-base md:text-lg">Desde </span>}{formatCRC(currentPrice)}</>}
            </div>
            {currentPrice !== null && <p className="text-xs text-rose-400 mt-1">IVA incluido</p>}
          </div>

          {/* Sin variantes activas: no hay nada que agregar al carrito */}
          {variants.length === 0 && (
            <div className="bg-amber-50 border border-amber-100 rounded-2xl p-4">
              <p className="text-sm font-bold text-amber-700">{variantError ? 'No pudimos cargar las tallas/opciones. Recargá la página para consultar el precio.' : 'Este producto no tiene tallas/opciones disponibles por el momento.'}</p>
              <a
                href={`${CONTACT.whatsappUrl}?text=${encodeURIComponent(`¡Hola! Me interesa ${product.name}. ¿Tienen disponibilidad?`)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-bold text-rose-600 hover:text-rose-700 mt-2 inline-block"
              >
                Consultanos por WhatsApp →
              </a>
            </div>
          )}

          {/* Variants */}
          {variants.length > 0 && (
            <div ref={variantSectionRef} id="product-variants" className="scroll-mt-24">
              <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 block">Variante</p>
              <div className="flex flex-wrap gap-2">
                {variants.map(v => (
                  <button
                    key={v.id}
                    onClick={() => { setSelectedVariant(v); setQuantity(1); }}
                    aria-pressed={selectedVariant?.id === v.id}
                    className={`px-4 py-2.5 rounded-xl border text-sm font-bold transition-all ${selectedVariant?.id === v.id
                      ? 'bg-rose-600 text-white border-rose-600 shadow-md'
                      : 'bg-white text-slate-600 border-slate-200 hover:border-rose-300'
                    } ${normalizeCommercialStatus(v.commercialStatus) === 'agotado' ? 'opacity-50 line-through' : ''}`}
                    disabled={!isPurchasableVariant(v, product) || getVariantPrice(product, v) === null}
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
              <StatusBadge status={isPurchasableVariant(selectedVariant, product) ? selectedVariant.commercialStatus : 'agotado'} type="commercial" />
              {selectedVariant.supplyType === 'bajo_pedido' && (
                <span className="text-xs text-amber-600 font-bold flex items-center gap-1">
                  <Package className="w-3.5 h-3.5" /> Se aparta con el {BACKORDER_DEPOSIT_LABEL} de este producto
                </span>
              )}
            </div>
          )}

          {!variantError && variants.length > 0 && !hasPurchasableOption && (
            <p role="status" className="rounded-xl bg-slate-100 p-4 text-sm font-bold text-slate-600">Agotado por el momento</p>
          )}

          {/* Un solo control de compra: fijo abajo en móvil y dentro de la ficha en escritorio. */}
          {hasPurchasableOption && (
            <section data-mobile-cart-dock aria-label="Compra de este producto" data-testid="product-purchase-bar"
              className="fixed inset-x-0 bottom-0 z-40 flex flex-col gap-3 border-t border-rose-100 bg-white px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))] shadow-[0_-4px_20px_rgba(15,23,42,0.08)] lg:static lg:inset-auto lg:z-auto lg:flex-row lg:flex-wrap lg:items-center lg:gap-4 lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none">
              <div className="flex items-center justify-between gap-3 lg:shrink-0">
                <p className="min-w-0 text-base md:text-lg font-black text-rose-600 lg:hidden" data-testid="product-mobile-price">
                  {currentPrice === null ? 'Precio no disponible' : <>{showFrom && <span className="text-xs">Desde </span>}{formatCRC(currentPrice)}</>}
                </p>
                {canBuy && <div className="flex shrink-0 items-center border border-slate-200 rounded-xl overflow-hidden" aria-label="Cantidad">
                  <button type="button" aria-label="Disminuir cantidad" disabled={quantity <= 1}
                    onClick={() => setQuantity(q => Math.max(1, q - 1))} className="px-3 py-2 lg:px-4 lg:py-3 text-slate-500 hover:bg-slate-50 disabled:opacity-40 text-lg font-bold">−</button>
                  <span className="px-3 py-2 lg:px-4 lg:py-3 text-sm font-bold text-slate-900 min-w-[40px] text-center border-x border-slate-200" aria-live="polite">{quantity}</span>
                  <button type="button" aria-label="Aumentar cantidad" disabled={!isPurchasableVariant(selectedVariant, product, quantity + 1)}
                    onClick={() => setQuantity(q => q + 1)} className="px-3 py-2 lg:px-4 lg:py-3 text-slate-500 hover:bg-slate-50 text-lg font-bold">+</button>
                </div>}
              </div>
              <div className="grid gap-2 has-[[data-mobile-cart-link]]:grid-cols-2 lg:flex lg:flex-1">
                <button
                  type="button"
                  onClick={canBuy ? handleAddToCart : chooseVariant}
                  disabled={addedToCart || (!!selectedVariant && !canBuy)}
                  aria-controls={!selectedVariant ? 'product-variants' : undefined}
                  className={`w-full lg:flex-1 flex items-center justify-center gap-2 py-4 rounded-2xl font-black text-sm transition-all shadow-lg active:scale-95 disabled:opacity-70 ${
                    addedToCart
                      ? 'bg-green-500 text-white'
                      : 'bg-rose-600 hover:bg-rose-700 text-white'
                  }`}
                >
                  {addedToCart ? (
                    <><Check className="w-5 h-5" /> ¡Agregado!</>
                  ) : !selectedVariant ? (
                    'Elegí una variante'
                  ) : !canBuy ? (
                    'Opción no disponible'
                  ) : (
                    <><ShoppingCart className="w-5 h-5" /> Agregar al Carrito</>
                  )}
                </button>
                <MobileCartBar inline />
              </div>
              {whatsAppButton}
            </section>
          )}

          {!hasPurchasableOption && <>{whatsAppButton}<MobileCartBar /></>}

          {/* Shipping note */}
          <div className="bg-slate-50 rounded-2xl p-4 flex items-center gap-3">
            <Truck className="w-5 h-5 text-slate-400 flex-shrink-0" />
            <div>
              <p className="text-xs font-bold text-slate-700">Envío a todo Costa Rica</p>
              <p className="text-[10px] text-slate-400">Envío normal · Express en Grecia, cuando esté disponible</p>
              {canArrangeCash && (
                <p className="mt-1 text-xs text-slate-600">Podés coordinar el pago contra entrega por WhatsApp si todo tu pedido está en stock.</p>
              )}
            </div>
            {!selectedVariant && priceSummary.price !== null && variants.length > 1 && (
              <p className="text-xs font-bold text-amber-600 mt-2 animate-pulse">⬆️ Seleccioná una variante para agregar al carrito</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
