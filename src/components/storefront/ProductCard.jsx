import React from 'react';
import { Link } from 'react-router-dom';
import { ShoppingCart, Eye } from 'lucide-react';
import { formatCRC } from '../../utils/formatters';
import StatusBadge from '../ui/StatusBadge';

export default function ProductCard({ product, variants = [] }) {
  const mainVariant = variants[0];
  const price = mainVariant?.price || product.basePrice || 0;
  const imageUrl = (product.images && product.images[0]) || mainVariant?.imageUrl || '';
  const commercialStatus = mainVariant?.commercialStatus || 'disponible';

  return (
    <Link
      to={`/producto/${product.id}`}
      className="group bg-white rounded-3xl border border-slate-100 overflow-hidden shadow-sm hover:shadow-xl hover:border-indigo-200 transition-all duration-300 flex flex-col"
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
        <div className="absolute inset-0 bg-indigo-600/0 group-hover:bg-indigo-600/10 transition-colors duration-300 flex items-center justify-center">
          <div className="opacity-0 group-hover:opacity-100 transition-opacity duration-300 bg-white/90 backdrop-blur-sm p-3 rounded-2xl shadow-lg">
            <Eye className="w-5 h-5 text-indigo-600" />
          </div>
        </div>
      </div>

      {/* Info */}
      <div className="p-4 flex-1 flex flex-col">
        <h3 className="font-bold text-slate-900 text-sm leading-tight line-clamp-2 group-hover:text-indigo-600 transition-colors">
          {product.name}
        </h3>
        <div className="mt-auto pt-3">
          <div className="text-xl font-black text-indigo-600 tracking-tight">
            {formatCRC(price)}
          </div>
          <p className="text-[10px] text-slate-400 mt-0.5">IVA incluido</p>
        </div>
      </div>
    </Link>
  );
}
