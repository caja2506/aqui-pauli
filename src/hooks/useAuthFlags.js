import { useEffect, useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../firebase';

// Flags públicos de autenticación en config/auth (lectura pública, escritura solo admin).
// facebookEnabled: false por defecto; se enciende cuando el proveedor Facebook esté configurado en Firebase.
let cached = null;
let pending = null;

function loadFlags() {
  if (cached) return Promise.resolve(cached);
  if (!pending) {
    pending = getDoc(doc(db, 'config', 'auth'))
      .then((snap) => ({ facebookEnabled: snap.exists() && snap.data().facebookEnabled === true }))
      .catch(() => ({ facebookEnabled: false }))
      .then((flags) => { cached = flags; return flags; });
  }
  return pending;
}

export function useAuthFlags() {
  const [flags, setFlags] = useState(cached || { facebookEnabled: false });
  useEffect(() => {
    let alive = true;
    loadFlags().then((f) => { if (alive) setFlags(f); });
    return () => { alive = false; };
  }, []);
  return flags;
}
