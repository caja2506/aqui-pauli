import React from 'react';
import { ORDER_STATUS_LABELS, ORDER_STATUS_COLORS, COMMERCIAL_STATUS_LABELS } from '../../utils/constants';

export default function StatusBadge({ status, type = 'order' }) {
  let label, colors;

  if (type === 'order') {
    label = ORDER_STATUS_LABELS[status] || status;
    colors = ORDER_STATUS_COLORS[status] || { bg: 'bg-slate-100', text: 'text-slate-600', border: 'border-slate-200' };
  } else if (type === 'commercial') {
    label = COMMERCIAL_STATUS_LABELS[status] || status;
    const colorMap = {
      disponible: { bg: 'bg-green-100', text: 'text-green-700', border: 'border-green-200' },
      agotado: { bg: 'bg-red-100', text: 'text-red-700', border: 'border-red-200' },
      bajo_pedido: { bg: 'bg-amber-100', text: 'text-amber-700', border: 'border-amber-200' },
    };
    colors = colorMap[status] || { bg: 'bg-slate-100', text: 'text-slate-600', border: 'border-slate-200' };
  } else {
    label = status;
    colors = { bg: 'bg-slate-100', text: 'text-slate-600', border: 'border-slate-200' };
  }

  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wider border ${colors.bg} ${colors.text} ${colors.border}`}>
      {label}
    </span>
  );
}
