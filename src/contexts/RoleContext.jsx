import React, { createContext, useContext, useState, useEffect } from 'react';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from './AuthContext';

// Emails que reciben rol de admin automáticamente al registrarse
const ADMIN_EMAILS = [
  'caja2506@gmail.com',
  'pamesank61@gmail.com',
];

const RoleContext = createContext(null);

export function useRole() {
  const context = useContext(RoleContext);
  if (!context) throw new Error('useRole must be used within a RoleProvider');
  return context;
}

export function RoleProvider({ children }) {
  const { user } = useAuth();
  const [role, setRole] = useState(null);
  const [roleLoading, setRoleLoading] = useState(true);

  useEffect(() => {
    if (!user) {
      setRole(null);
      setRoleLoading(false);
      return;
    }

    setRoleLoading(true);
    const userRoleRef = doc(db, 'users_roles', user.uid);

    const unsubscribe = onSnapshot(userRoleRef, async (snap) => {
      if (snap.exists()) {
        setRole(snap.data().role || 'cliente');
      } else {
        // Auto-asignar admin si el email está en la lista
        const autoRole = ADMIN_EMAILS.includes(user.email?.toLowerCase()) ? 'admin' : 'cliente';
        await setDoc(userRoleRef, {
          email: user.email,
          displayName: user.displayName || '',
          photoURL: user.photoURL || '',
          phone: '',
          role: autoRole,
          createdAt: new Date().toISOString(),
        });
        setRole(autoRole);
      }
      setRoleLoading(false);
    });

    return () => unsubscribe();
  }, [user]);

  const isAdmin = role === 'admin';
  const isCliente = role === 'cliente';

  const value = {
    role,
    roleLoading,
    isAdmin,
    isCliente,
  };

  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>;
}
