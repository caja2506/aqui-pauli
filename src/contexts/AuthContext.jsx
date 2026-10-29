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
  signInWithRedirect,
  linkWithRedirect,
  getRedirectResult,
  GoogleAuthProvider,
  FacebookAuthProvider
} from 'firebase/auth';
import { auth, googleProvider, facebookProvider } from '../firebase';

const AuthContext = createContext(null);

// Móvil o navegadores in-app (Facebook/Instagram/Messenger): los popups fallan, usamos redirect
export function shouldUseRedirect() {
  if (typeof navigator === 'undefined') return false;
  return /FBAN|FBAV|FB_IAB|Instagram|Messenger|Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
}

// Mensaje claro para errores de inicio de sesión social
export function socialAuthErrorMessage(err, providerLabel = 'esa red') {
  switch (err?.code) {
    case 'auth/account-exists-with-different-credential':
      return `Ya existe una cuenta con ese correo creada con otro método (por ejemplo Google o correo y contraseña). Entrá con ese método y no se pierde nada; si querés, después la vinculamos con ${providerLabel}.`;
    case 'auth/popup-blocked':
      return 'Tu navegador bloqueó la ventana emergente. Permitila e intentá de nuevo.';
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return null; // el usuario canceló: sin mensaje
    case 'auth/operation-not-allowed':
      return `El ingreso con ${providerLabel} todavía no está disponible.`;
    case 'auth/network-request-failed':
      return 'Sin conexión. Revisá tu internet e intentá de nuevo.';
    default:
      return `No pudimos completar el ingreso con ${providerLabel}. Intentá de nuevo.`;
  }
}

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

  const [redirectError, setRedirectError] = useState(null);

  // Completa el flujo de signInWithRedirect / linkWithRedirect al volver de Facebook
  useEffect(() => {
    getRedirectResult(auth)
      .then((result) => { if (result?.user) forceRender(); })
      .catch(async (err) => {
        if (err.code === 'auth/credential-already-in-use') {
          const credential = FacebookAuthProvider.credentialFromError(err) || GoogleAuthProvider.credentialFromError(err);
          if (credential) { try { await signInWithCredential(auth, credential); return; } catch (e) { err = e; } }
        }
        console.error('Redirect sign-in error:', err);
        setRedirectError(socialAuthErrorMessage(err, 'Facebook'));
      });
  }, []);

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

  // Facebook: mismo patrón que Google. Si hay sesión de invitado se VINCULA (conserva el uid y los pedidos).
  const signInWithFacebook = async () => {
    const current = auth.currentUser;
    const useRedirect = shouldUseRedirect();
    try {
      if (current && current.isAnonymous) {
        if (useRedirect) { await linkWithRedirect(current, facebookProvider); return; }
        try {
          await linkWithPopup(current, facebookProvider);
          forceRender();
          return;
        } catch (err) {
          if (err.code === 'auth/credential-already-in-use') {
            const credential = FacebookAuthProvider.credentialFromError(err);
            if (credential) { await signInWithCredential(auth, credential); return; }
          }
          throw err;
        }
      }
      if (useRedirect) { await signInWithRedirect(auth, facebookProvider); return; }
      await signInWithPopup(auth, facebookProvider);
    } catch (error) {
      console.error('Error signing in with Facebook:', error);
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
    signInWithFacebook,
    redirectError,
    signInWithEmail,
    createAccount,
    signOut,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
