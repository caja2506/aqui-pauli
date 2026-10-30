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
  getRedirectResult,
  GoogleAuthProvider,
  FacebookAuthProvider
} from 'firebase/auth';
import { auth, googleProvider, facebookProvider } from '../firebase';

const AuthContext = createContext(null);

// Mensaje claro para errores de inicio de sesión social
export function socialAuthErrorMessage(err, providerLabel = 'esa red') {
  switch (err?.code) {
    case 'auth/account-exists-with-different-credential':
      return 'Ese correo ya tiene una cuenta con otro método. Ingresá con el método que usaste al registrarte, como Google o correo y contraseña.';
    case 'auth/popup-blocked':
      return 'Tu navegador bloqueó la ventana de ingreso. Permití las ventanas emergentes e intentá de nuevo. Si estás en Instagram o Facebook, abrí aquipauli.com en Chrome o Safari.';
    case 'auth/operation-not-supported-in-this-environment':
    case 'auth/web-storage-unsupported':
      return 'Abrí aquipauli.com en Chrome o Safari para completar el ingreso.';
    case 'auth/unauthorized-domain':
      return `No pudimos habilitar el ingreso con ${providerLabel} desde esta dirección. Podés ingresar con Google o correo y contraseña.`;
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
        console.error('Redirect sign-in error:', err?.code || 'auth/unknown');
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

  // Popup también en móvil: el authDomain configurado pertenece a Firebase y
  // un redirect entre dominios puede fallar al bloquear almacenamiento de terceros.
  // Vincular un invitado conserva su uid; entrar a una cuenta existente no fusiona pedidos.
  const signInWithFacebook = async () => {
    const current = auth.currentUser;
    try {
      if (current && current.isAnonymous) {
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
      await signInWithPopup(auth, facebookProvider);
    } catch (error) {
      console.error('Error signing in with Facebook:', error?.code || 'auth/unknown');
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
