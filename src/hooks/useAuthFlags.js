import { useEffect, useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../firebase';

// Flags públicos de autenticación en config/auth (lectura pública, escritura solo admin).
// Facebook ya está configurado en Firebase. Documento/campo ausente lo habilita;
// facebookEnabled: false permite apagar el botón explícitamente.
let cached = null;
let pending = null;

function loadFlags() {
  if (cached) return Promise.resolve(cached);
  if (!pending) {
    pending = getDoc(doc(db, 'config', 'auth'))
      .then((snap) => {
        cached = { facebookEnabled: !snap.exists() || snap.data().facebookEnabled !== false };
        return cached;
      })
      .catch(() => ({ facebookEnabled: false }))
      .finally(() => { pending = null; });
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
