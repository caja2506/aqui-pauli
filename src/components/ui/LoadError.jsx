import React from 'react';
import { WifiOff } from 'lucide-react';

export default function LoadError({ onRetry, message }) {
  return (
    <div className="text-center py-16" role="alert">
      <div className="w-20 h-20 rounded-2xl bg-rose-50 flex items-center justify-center mx-auto mb-4">
        <WifiOff className="w-10 h-10 text-rose-300" />
      </div>
      <p className="text-sm font-bold text-slate-600">No pudimos cargar los productos</p>
      <p className="text-xs text-slate-400 mt-1">{message || 'Revisá tu conexión e intentá de nuevo.'}</p>
      <button
        onClick={onRetry}
        className="mt-5 px-6 py-3 bg-rose-600 text-white text-sm font-bold rounded-2xl hover:bg-rose-700 active:scale-95 transition-all"
      >
        Reintentar
      </button>
    </div>
  );
}
