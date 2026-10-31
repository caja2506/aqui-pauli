import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

const CartContext = createContext(null);

const CART_STORAGE_KEY = 'aquipauli_cart';

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
    setItems(prev => {
      const existingIndex = prev.findIndex(
        i => i.productId === product.id && i.variantId === variant.id
      );

      if (existingIndex >= 0) {
        const updated = [...prev];
        updated[existingIndex] = {
          ...updated[existingIndex],
          quantity: updated[existingIndex].quantity + quantity,
        };
        return updated;
      }

      return [...prev, {
        productId: product.id,
        variantId: variant.id,
        productName: product.name,
        variantName: variant.name,
        imageUrl: variant.imageUrl || (product.images && product.images[0]) || '',
        price: variant.price,
        quantity,
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
    if (quantity <= 0) {
      removeItem(productId, variantId);
      return;
    }
    setItems(prev => prev.map(i =>
      i.productId === productId && i.variantId === variantId
        ? { ...i, quantity }
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
