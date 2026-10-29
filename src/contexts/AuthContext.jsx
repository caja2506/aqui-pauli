import React, { createContext, useContext, useState, useEffect, useReducer } from 'react';
import {
  onAuthStateChanged,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
  signOut as firebaseSignOut,
  signInAnonymously,
  linkWithPopup,
  signInWithCredential,
  GoogleAuthProvider
} from 'firebase/auth';
import { auth, googleProvider } from '../firebase';

const AuthContext = createContext(null);

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  // El objeto User se muta en sitio al vincular una cuenta: forzamos re-render de los consumidores
  const [, forceRender] = useReducer((n) => n + 1, 0);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // Compra como invitado: sesión anónima para que el pedido tenga un uid propio
  const ensureGuestSession = async () => {
    if (auth.currentUser) return auth.currentUser;
    const cred = await signInAnonymously(auth);
    return cred.user;
  };

  const signInWithGoogle = async () => {
    try {
      const current = auth.currentUser;
      if (current && current.isAnonymous) {
        // Conserva el uid (y los pedidos) del invitado al guardar su cuenta con Google
        try {
          await linkWithPopup(current, googleProvider);
          forceRender();
          return;
        } catch (err) {
          if (err.code === 'auth/credential-already-in-use' || err.code === 'auth/email-already-in-use') {
            const credential = GoogleAuthProvider.credentialFromError(err);
            if (credential) { await signInWithCredential(auth, credential); return; }
          }
          throw err;
        }
      }
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error('Error signing in with Google:', error);
      throw error;
    }
  };

  const signInWithEmail = async (email, password) => {
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (error) {
      console.error('Error signing in with email:', error);
      throw error;
    }
  };

  const createAccount = async (email, password, displayName) => {
    try {
      const result = await createUserWithEmailAndPassword(auth, email, password);
      if (displayName) {
        await updateProfile(result.user, { displayName });
      }
      return result.user;
    } catch (error) {
      console.error('Error creating account:', error);
      throw error;
    }
  };

  const signOut = async () => {
    try {
      await firebaseSignOut(auth);
    } catch (error) {
      console.error('Error signing out:', error);
      throw error;
    }
  };

  const value = {
    user,
    loading,
    isAnonymous: !!user?.isAnonymous,
    ensureGuestSession,
    signInWithGoogle,
    signInWithEmail,
    createAccount,
    signOut,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
