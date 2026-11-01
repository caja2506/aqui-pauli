import { formatCRC } from '../../utils/formatters';

export default function OrderPromotion({ order, packing = false }) {
  if (!order?.giftSample && !order?.discount) return null;
  return <div className="my-3 rounded-xl bg-rose-50 p-3 text-sm text-slate-800">
    {order.giftSample && <p>🎁 Muestra de regalo (3 ml): <strong>{order.giftSample.choice === 'sorpresa' && packing ? 'Sorpresa (elegila vos)' : order.giftSample.name}</strong></p>}
    {order.discount && <p>Código usado: <strong>{order.discount.code}</strong> (−{formatCRC(order.discount.amount)})</p>}
  </div>;
}
