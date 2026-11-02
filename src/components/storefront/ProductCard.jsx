import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ShoppingCart, Eye } from 'lucide-react';
import { formatCRC } from '../../utils/formatters';
import { normalizeCommercialStatus } from '../../utils/constants';
import { getVariantPrice, getProductPriceSummary, isActiveVariant, isPurchasableVariant } from '../../utils/productPrice';
import StatusBadge from '../ui/StatusBadge';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../../firebase';

// Fotos locales publicadas junto con el catálogo inicial de decants. El admin
// puede reemplazarlas: las URLs actuales del producto y sus variantes van primero.
const decantPhotos = {
  'decant-stronger-with-you-intensely': 'stronger-with-you-intensely',
  'decant-212-vip-rose-i-love-ny': '212-vip-rose-i-ny',
  'decant-al-haramain-amber-oud-gold': 'amber-oud-gold',
  'decant-moschino-toy-2-pearl': 'moschino-toy-2-pearl',
  'decant-lacoste-l1212-blanc': 'lacoste-l1212-blanc',
  'decant-armaf-odyssey-homme-white': 'odyssey-homme-white',
  'decant-lattafa-badee-al-oud-honor-glory': 'badee-honor-glory',
  'decant-boss-in-motion': 'boss-in-motion',
};

export default function ProductCard({ product }) {
  return <ProductCardDetails key={product.id} product={product} />;
}

function ProductCardDetails({ product }) {
  const navigate = useNavigate();
  const [variants, setVariants] = useState([]);
  const [loadingVariant, setLoadingVariant] = useState(true);
  const [variantError, setVariantError] = useState(false);
  const [failedImages, setFailedImages] = useState([]);

  useEffect(() => {
    let active = true;
    getDocs(collection(db, 'products', product.id, 'variants')).then((snap) => {
      if (!active) return;
      const vars = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(isActiveVariant)
        .sort((a, b) => (a.order || 0) - (b.order || 0));
      setVariants(vars);
      setLoadingVariant(false);
    }).catch(() => {
      if (!active) return;
      setVariantError(true);
      setLoadingVariant(false);
    });
    return () => { active = false; };
  }, [product.id]);

  const { price, isFrom, mainVariant } = getProductPriceSummary(product, variants);
  const localPhoto = decantPhotos[product.id];
  const candidates = [
    ...(Array.isArray(product.images) ? product.images : []), mainVariant?.imageUrl, product.imageUrl,
    ...variants.map(v => v.imageUrl), localPhoto && `/img/decants/${localPhoto}.jpg?v=1`,
  ];
  const imageUrl = candidates.filter(url => typeof url === 'string').map(url => url.trim())
    .find(url => url && !failedImages.includes(url));
  const purchasableVariant = variants.find(variant => isPurchasableVariant(variant, product)
    && getVariantPrice(product, variant) !== null);
  const commercialStatus = normalizeCommercialStatus((purchasableVariant || mainVariant || variants[0])?.commercialStatus);
  const canBuy = Boolean(purchasableVariant) && !variantError;

  const handleViewOptions = (e) => {
    e.preventDefault();
    e.stopPropagation();
    navigate(`/producto/${product.id}`);
  };

  return (
    <Link
      to={`/producto/${product.id}`}
      className="group bg-white rounded-3xl border border-slate-100 overflow-hidden shadow-sm hover:shadow-xl hover:border-rose-200 transition-all duration-300 flex flex-col"
    >
      {/* Image */}
      <div className="relative aspect-square bg-slate-50 overflow-hidden">
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={product.name}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
            key={imageUrl}
            onError={() => setFailedImages(previous => previous.includes(imageUrl) ? previous : [...previous, imageUrl])}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-slate-200">
            <ShoppingCart className="w-16 h-16" />
          </div>
        )}
        {/* Status overlay */}
        {!loadingVariant && variants.length > 0 && commercialStatus !== 'disponible' && (
          <div className="absolute top-3 left-3">
            <StatusBadge status={commercialStatus} type="commercial" />
          </div>
        )}
        {/* Hover overlay */}
        <div className="absolute inset-0 bg-rose-600/0 group-hover:bg-rose-600/10 transition-colors duration-300 flex items-center justify-center">
          <div className="opacity-0 group-hover:opacity-100 transition-opacity duration-300 bg-white/90 backdrop-blur-sm p-3 rounded-2xl shadow-lg">
            <Eye className="w-5 h-5 text-rose-600" />
          </div>
        </div>
      </div>

      {/* Info */}
      <div className="p-4 flex-1 flex flex-col">
        <h3 className="font-bold text-slate-900 text-[13px] leading-snug md:text-sm md:leading-tight line-clamp-2 group-hover:text-rose-600 transition-colors">
          {product.name}
        </h3>
        <div className="mt-auto pt-3">
          <div className="text-lg md:text-xl font-black text-rose-600 tracking-tight" aria-live="polite" data-testid="product-price">
            {loadingVariant ? 'Cargando precio…'
              : variantError ? 'Precio no disponible'
                : price === null ? 'Sin opciones disponibles'
                  : <>{isFrom && <span className="text-sm">Desde </span>}{formatCRC(price)}</>}
          </div>
          {!loadingVariant && !variantError && price !== null && <p className="text-[10px] text-slate-400 mt-0.5">IVA incluido</p>}
        </div>

        {/* Add to Cart button */}
        {canBuy && !loadingVariant && (
          <button
            onClick={handleViewOptions}
            className="mt-3 w-full flex items-center justify-center gap-1.5 py-2.5 rounded-xl font-bold text-xs transition-all active:scale-95 bg-rose-50 text-rose-600 border border-rose-200 hover:bg-rose-600 hover:text-white"
          >
            <ShoppingCart className="w-3.5 h-3.5" /> Ver opciones
          </button>
        )}
      </div>
    </Link>
  );
}
