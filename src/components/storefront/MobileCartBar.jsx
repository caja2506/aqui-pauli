import { useSyncExternalStore } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useCart } from '../../contexts/CartContext';
import { usePricedCart } from '../../hooks/usePricedCart';
import { formatCRC } from '../../utils/formatters';

const media = '(min-width: 64rem)';
const isMobile = () => !window.matchMedia(media).matches;
function onViewportChange(update) {
  const query = window.matchMedia(media);
  query.addEventListener('change', update);
  return () => query.removeEventListener('change', update);
}

function CartLink({ total, count, inline }) {
  const { pathname } = useLocation();
  const link = (
    <Link to="/checkout" data-mobile-cart-link
      onClick={() => {
        if (pathname === '/checkout') document.getElementById('checkout-summary')?.scrollIntoView({ block: 'start' });
      }}
      className="flex min-h-11 flex-wrap items-center justify-center gap-x-1 rounded-xl bg-slate-900 px-2 py-2 text-center text-sm font-bold leading-tight text-white focus-visible:ring-2 focus-visible:ring-rose-500">
      <span>Ver carrito · Pagar</span> <span className="whitespace-nowrap">({formatCRC(total)}, {count} {count === 1 ? 'artículo' : 'artículos'})</span>
    </Link>
  );
  if (inline) return link;
  return <div className="h-[calc(4rem+env(safe-area-inset-bottom,0px))] lg:hidden">
    <div data-mobile-cart-dock className="fixed inset-x-0 bottom-0 z-40 border-t border-rose-100 bg-white px-3 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))]">{link}</div>
  </div>;
}

function QuotedCartLink(props) {
  const { subtotal, delivery } = usePricedCart();
  return <CartLink {...props} total={subtotal + delivery.shippingCost} />;
}

export default function MobileCartBar({ inline = false, total }) {
  const { itemCount, isCartOpen } = useCart();
  const mobile = useSyncExternalStore(onViewportChange, isMobile, () => false);
  if (!mobile || !itemCount || isCartOpen) return null;
  return total == null ? <QuotedCartLink count={itemCount} inline={inline} />
    : <CartLink count={itemCount} inline={inline} total={total} />;
}
