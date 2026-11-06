import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { getCatalogId } from '../../functions/lib/catalogId.mjs';
import { isSaleDecant } from '../../functions/lib/decantSale.mjs';
import { availableQuantity, maximumProductQuantity } from '../../functions/lib/catalogSafety.mjs';
import { pilotStorageKey } from '../services/payments/tilopayPilot';

const CartContext = createContext(null);

const CART_STORAGE_KEY = pilotStorageKey('aquipauli_cart');

export function useCart() {
  const context = useContext(CartContext);
  if (!context) throw new Error('useCart must be used within a CartProvider');
  return context;
}

function loadCartFromStorage() {
  try {
    const stored = localStorage.getItem(CART_STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveCartToStorage(items) {
  try {
    const stored = JSON.stringify(items);
    if (localStorage.getItem(CART_STORAGE_KEY) !== stored) localStorage.setItem(CART_STORAGE_KEY, stored);
  } catch { /* Keep the current cart usable when browser storage is unavailable. */ }
}

export function CartProvider({ children }) {
  const [items, setItems] = useState(loadCartFromStorage);
  const [isCartOpen, setIsCartOpen] = useState(false);

  // Persist to localStorage on change
  useEffect(() => {
    saveCartToStorage(items);
  }, [items]);

  // Another open tab can change the cart while this checkout remains mounted.
  useEffect(() => {
    const syncCart = (event) => {
      if (event.storageArea === localStorage && (event.key === CART_STORAGE_KEY || event.key === null)) {
        setItems(loadCartFromStorage());
      }
    };
    window.addEventListener('storage', syncCart);
    return () => window.removeEventListener('storage', syncCart);
  }, []);

  const addItem = useCallback((product, variant, quantity = 1) => {
    const available = availableQuantity(product, variant);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || available < 1) return;
    setItems(prev => {
      const elsewhere = prev.filter(i => i.productId === product.id && i.variantId !== variant.id)
        .reduce((sum, i) => sum + i.quantity, 0);
      const maxQuantity = Math.min(available, maximumProductQuantity(product) - elsewhere);
      if (maxQuantity < 1) return prev;
      const existingIndex = prev.findIndex(
        i => i.productId === product.id && i.variantId === variant.id
      );

      if (existingIndex >= 0) {
        const updated = [...prev];
        updated[existingIndex] = {
          ...updated[existingIndex],
          catalogId: getCatalogId(product.id, variant),
          quantity: Math.min(maxQuantity, updated[existingIndex].quantity + quantity),
          maxQuantity,
        };
        return updated;
      }

      return [...prev, {
        productId: product.id,
        catalogId: getCatalogId(product.id, variant),
        variantId: variant.id,
        productName: product.name,
        productKind: isSaleDecant(product) ? 'decant' : 'other',
        variantName: variant.name,
        imageUrl: variant.imageUrl || (product.images && product.images[0]) || '',
        price: variant.price,
        quantity: Math.min(quantity, maxQuantity),
        maxQuantity,
        supplyType: variant.supplyType || 'stock_propio',
        commercialStatus: variant.commercialStatus || 'disponible',
        addedAt: new Date().toISOString(),
      }];
    });
  }, []);

  const removeItem = useCallback((productId, variantId) => {
    setItems(prev => prev.filter(
      i => !(i.productId === productId && i.variantId === variantId)
    ));
  }, []);

  const updateQuantity = useCallback((productId, variantId, quantity) => {
    if (!Number.isSafeInteger(quantity)) return;
    if (quantity <= 0) {
      removeItem(productId, variantId);
      return;
    }
    setItems(prev => prev.map(i =>
      i.productId === productId && i.variantId === variantId
        ? { ...i, quantity: Math.min(quantity, i.maxQuantity ?? 99) }
        : i
    ));
  }, [removeItem]);

  const clearCart = useCallback(() => {
    setItems([]);
  }, []);

  const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);

  const subtotal = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);

  const value = {
    items,
    itemCount,
    subtotal,
    isCartOpen,
    setIsCartOpen,
    addItem,
    removeItem,
    updateQuantity,
    clearCart,
  };

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}
