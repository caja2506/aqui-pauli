import { Link } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Minus, Plus, ShoppingBag, Trash2 } from 'lucide-react';
import { useCart } from '../../contexts/CartContext';
import { formatCRC } from '../../utils/formatters';
import { computeBackorder, BACKORDER_DEPOSIT_LABEL } from '../../utils/backorder';
import usePageTitle from '../../hooks/usePageTitle';

export default function CartPage() {
  usePageTitle('Mi carrito | Aquí Pauli');
  const { items, subtotal, itemCount, removeItem, updateQuantity } = useCart();
  const summary = computeBackorder(items);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-8 pb-[calc(6rem+env(safe-area-inset-bottom,0px))] lg:pb-12">
      <Link to="/catalogo" className="inline-flex items-center gap-2 text-sm font-bold text-rose-600 hover:text-rose-700 mb-6">
        <ArrowLeft className="w-4 h-4" /> Seguir comprando
      </Link>
      <h1 className="text-3xl font-black text-slate-900 tracking-tight">Mi carrito</h1>

      {items.length === 0 ? (
        <div className="flex flex-col items-center text-center py-16 gap-4">
          <ShoppingBag className="w-16 h-16 text-rose-200" />
          <h2 className="text-xl font-bold text-slate-700">Tu carrito está vacío</h2>
          <p className="text-sm text-slate-500">Elegí tus productos para revisar tu compra acá.</p>
          <Link to="/catalogo" className="px-6 py-3 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-2xl">Ver catálogo</Link>
        </div>
      ) : (
        <>
          <p className="text-sm text-slate-500 mt-2 mb-6" aria-live="polite">{itemCount} producto{itemCount === 1 ? '' : 's'} en tu carrito</p>
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_22rem] gap-8 items-start">
            <div className="space-y-4">
              {items.map(item => (
                <article key={`${item.productId}-${item.variantId}`} className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
                  <div className="flex gap-4">
                    <Link to={`/producto/${item.productId}`} aria-label={`Ver ${item.productName}`} className="w-20 h-20 sm:w-24 sm:h-24 shrink-0 rounded-xl overflow-hidden bg-slate-50 border border-slate-100 flex items-center justify-center">
                      {item.imageUrl ? <img src={item.imageUrl} alt="" className="w-full h-full object-contain" /> : <ShoppingBag className="w-8 h-8 text-slate-300" />}
                    </Link>
                    <div className="min-w-0 flex-1">
                      <h2 className="font-bold text-slate-900 break-words"><Link to={`/producto/${item.productId}`} className="hover:text-rose-600">{item.productName}</Link></h2>
                      <p className="text-sm text-slate-500 mt-1">{item.variantName}</p>
                      <p className="text-sm text-slate-600 mt-1">{formatCRC(item.price)} por unidad</p>
                      {item.supplyType === 'bajo_pedido' && <p className="text-xs font-bold text-amber-700 mt-2">Bajo pedido · Apartado del {BACKORDER_DEPOSIT_LABEL}</p>}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3 mt-4 pt-4 border-t border-slate-100">
                    <div className="flex items-center rounded-xl border border-slate-200">
                      <button type="button" aria-label={`Reducir cantidad de ${item.productName}, ${item.variantName}`} onClick={() => updateQuantity(item.productId, item.variantId, item.quantity - 1)} className="w-11 h-11 flex items-center justify-center hover:bg-slate-50 rounded-l-xl"><Minus className="w-4 h-4" /></button>
                      <span className="w-9 text-center font-bold text-slate-700" aria-label={`Cantidad de ${item.productName}`}>{item.quantity}</span>
                      <button type="button" aria-label={`Aumentar cantidad de ${item.productName}, ${item.variantName}`} onClick={() => updateQuantity(item.productId, item.variantId, item.quantity + 1)} className="w-11 h-11 flex items-center justify-center hover:bg-slate-50 rounded-r-xl"><Plus className="w-4 h-4" /></button>
                    </div>
                    <p className="font-black text-rose-600" aria-label={`Total de ${item.productName}`}>{formatCRC(item.price * item.quantity)}</p>
                    <button type="button" aria-label={`Quitar ${item.productName}, ${item.variantName} del carrito`} onClick={() => removeItem(item.productId, item.variantId)} className="inline-flex items-center gap-1 min-h-11 px-2 text-sm font-bold text-red-500 hover:text-red-700"><Trash2 className="w-4 h-4" /> Quitar</button>
                  </div>
                </article>
              ))}
            </div>

            <section aria-labelledby="cart-summary-title" className="rounded-2xl border border-rose-100 bg-rose-50 p-5 sm:p-6 lg:sticky lg:top-24">
              <h2 id="cart-summary-title" className="text-xl font-black text-slate-900 mb-5">Resumen</h2>
              <dl className="space-y-3 text-sm">
                <div className="flex justify-between gap-4"><dt className="text-slate-500">Subtotal</dt><dd className="font-bold text-slate-800">{formatCRC(subtotal)}</dd></div>
                <div className="flex justify-between gap-4"><dt className="text-slate-500">Envío</dt><dd className="font-bold text-slate-800">Incluido</dd></div>
                <div className="flex justify-between gap-4 pt-3 border-t border-rose-100 text-base"><dt className="font-bold text-slate-800">Total del pedido</dt><dd className="font-black text-slate-900">{formatCRC(summary.total)}</dd></div>
                {summary.hasBackorder && <>
                  <div className="flex justify-between gap-4"><dt className="font-bold text-rose-700">Pagás ahora</dt><dd className="font-black text-rose-700">{formatCRC(summary.payNowTotal)}</dd></div>
                  <div className="flex justify-between gap-4"><dt className="text-slate-600">Saldo pendiente</dt><dd className="font-bold text-slate-800">{formatCRC(summary.balanceDue)}</dd></div>
                </>}
              </dl>
              {summary.hasBackorder && <p className="text-xs text-slate-600 leading-relaxed mt-4">Pagás el {BACKORDER_DEPOSIT_LABEL} de las líneas Bajo pedido y el importe completo de los productos en stock. El saldo se paga cuando el pedido esté listo para entregarse.</p>}
              <Link to="/checkout" className="mt-6 w-full inline-flex items-center justify-center gap-2 py-4 px-4 bg-rose-600 hover:bg-rose-700 text-white font-black rounded-2xl text-sm transition-all">Continuar al checkout <ArrowRight className="w-4 h-4" /></Link>
              <p className="text-xs text-slate-500 mt-3">En el siguiente paso completás el envío y elegís cómo pagar.</p>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
