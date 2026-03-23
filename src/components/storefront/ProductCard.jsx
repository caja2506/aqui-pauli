import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ShoppingCart, Eye } from 'lucide-react';
import { formatCRC } from '../../utils/formatters';
import StatusBadge from '../ui/StatusBadge';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../../firebase';

export default function ProductCard({ product }) {
  const navigate = useNavigate();
  const [mainVariant, setMainVariant] = useState(null);
  const [loadingVariant, setLoadingVariant] = useState(true);

  useEffect(() => {
    // Cargar la primera variante activa para mostrar precio y habilitar compra
    getDocs(collection(db, 'products', product.id, 'variants')).then((snap) => {
      const vars = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(v => v.active !== false)
        .sort((a, b) => (a.order || 0) - (b.order || 0));
      if (vars.length > 0) setMainVariant(vars[0]);
      setLoadingVariant(false);
    });
  }, [product.id]);

  const price = mainVariant?.price || product.basePrice || 0;
  const imageUrl = (product.images && product.images[0]) || mainVariant?.imageUrl || '';
  const commercialStatus = mainVariant?.commercialStatus || 'disponible';
  const canBuy = mainVariant && (commercialStatus === 'disponible' || commercialStatus === 'bajo_pedido');

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
            onError={e => { e.target.style.display = 'none'; }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-slate-200">
            <ShoppingCart className="w-16 h-16" />
          </div>
        )}
        {/* Status overlay */}
        {commercialStatus !== 'disponible' && (
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
        <h3 className="font-bold text-slate-900 text-sm leading-tight line-clamp-2 group-hover:text-rose-600 transition-colors">
          {product.name}
        </h3>
        <div className="mt-auto pt-3">
          <div className="text-xl font-black text-rose-600 tracking-tight">
            {formatCRC(price)}
          </div>
          <p className="text-[10px] text-slate-400 mt-0.5">IVA incluido</p>
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
