import React, { useState } from 'react';
import { UserCheck, Loader2 } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';

// Ofrece al invitado (sesión anónima) guardar su cuenta con Google sin perder sus pedidos (linkWithPopup)
export default function SaveAccountPrompt({ compact = false }) {
  const { user, signInWithGoogle } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (!user?.isAnonymous) return null;

  const handle = async () => {
    setBusy(true);
    setError(null);
    try {
      await signInWithGoogle();
    } catch (err) {
      if (err.code !== 'auth/popup-closed-by-user' && err.code !== 'auth/cancelled-popup-request') {
        setError('No pudimos guardar tu cuenta. Intentá de nuevo.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`bg-rose-50 border border-rose-100 rounded-2xl ${compact ? 'p-3' : 'p-5'} flex items-center gap-3`} data-testid="save-account">
      <UserCheck className="w-5 h-5 text-rose-500 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-bold text-slate-700">{compact ? 'Estás comprando como invitado' : 'Opcional'}</p>
        {!compact && <p className="text-[11px] text-slate-500">Si querés, guardá tu cuenta con Google para ver tus pedidos luego. No perdés este pedido.</p>}
        {error && <p className="text-[11px] text-red-500 mt-1">{error}</p>}
      </div>
      <button
        type="button"
        onClick={handle}
        disabled={busy}
        className="px-3 py-2 bg-white border border-rose-200 text-rose-600 text-xs font-bold rounded-xl hover:bg-rose-100 disabled:opacity-50 shrink-0 flex items-center gap-1"
      >
        {busy && <Loader2 className="w-3 h-3 animate-spin" />} Guardar mi cuenta con Google
      </button>
    </div>
  );
}
