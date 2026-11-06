import { useEffect, useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase';
import { useCart } from '../contexts/CartContext';
import { cartDecantDelivery } from '../../functions/lib/decantSale.mjs';

// El catálogo puede cambiar después de guardar el carrito en este dispositivo.
export function usePricedCart(drawer = false) {
  const cart = useCart();
  const [quote, setQuote] = useState(null);
  const key = cart.items.length && (!drawer || cart.isCartOpen)
    ? JSON.stringify(cart.items.map(({ productId, variantId, quantity }) => ({ productId, variantId, quantity }))) : '';
  useEffect(() => {
    if (!key) return;
    let active = true;
    const timer = setTimeout(async () => {
      try {
        const { data } = await httpsCallable(functions, 'quoteCartDelivery')({ items: JSON.parse(key) });
        if (active) setQuote({ key, data });
      } catch (error) {
        if (active) setQuote({ key, error: error?.code === 'functions/failed-precondition'
          ? error.message : 'No pudimos verificar precio y existencias. Volvé a abrir el carrito.' });
      }
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [key]);
  if (!quote || quote.key !== key) {
    return { ...cart, delivery: { ...cartDecantDelivery(cart.items, cart.subtotal), estimated: true } };
  }
  if (quote.error) return { ...cart, delivery: { ...cartDecantDelivery(cart.items, cart.subtotal), error: quote.error } };
  const { subtotal, delivery, lines } = quote.data;
  // El servidor conserva el orden de las líneas de la solicitud identificada por key.
  const items = cart.items.map((item, index) => ({ ...item, ...lines[index] }));
  return { ...cart, items, subtotal, delivery };
}
