import { useState } from 'react';
import { UserCheck, Loader2 } from 'lucide-react';
import { useAuth, socialAuthErrorMessage } from '../../contexts/AuthContext';
import { useAuthFlags } from '../../hooks/useAuthFlags';
import FacebookIcon from './FacebookIcon';

// Ofrece al invitado (sesión anónima) guardar su cuenta con Google (o Facebook si está habilitado)
// Una vinculación nueva conserva el uid. Ingresar a una cuenta existente no fusiona pedidos.
export default function SaveAccountPrompt({ compact = false }) {
  const { user, signInWithGoogle, signInWithFacebook, redirectError } = useAuth();
  const { facebookEnabled } = useAuthFlags();
  const [busy, setBusy] = useState(null); // 'google' | 'facebook' | null
  const [error, setError] = useState(null);

  if (!user?.isAnonymous) return null;

  const run = (key, fn, label) => async () => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(socialAuthErrorMessage(err, label));
    } finally {
      setBusy(null);
    }
  };

  const btn = 'min-w-0 w-full px-3 py-2 bg-white border border-rose-200 text-rose-600 text-xs font-bold rounded-xl hover:bg-rose-100 disabled:opacity-50 flex items-center justify-center gap-1';

  return (
    <div className={`bg-rose-50 border border-rose-100 rounded-2xl ${compact ? 'p-3' : 'p-5'} space-y-3`} data-testid="save-account">
      <div className="flex items-start gap-3" data-testid="save-account-description">
        <UserCheck className="w-5 h-5 text-rose-500 shrink-0" />
        <div className="flex-1 min-w-0">
        <p className="text-xs font-bold text-slate-700">{compact ? 'Estás comprando como invitado' : 'Opcional'}</p>
        {!compact && (
          <p className="text-[11px] text-slate-500">
            Si querés, guardá tu cuenta con {facebookEnabled ? 'Google o Facebook' : 'Google'} para ver tus pedidos luego. Los pedidos de invitado no se transfieren automáticamente a una cuenta que ya existía.
          </p>
        )}
        {(error || redirectError) && <p className="text-[11px] text-red-500 mt-1" role="alert">{error || redirectError}</p>}
        </div>
      </div>
      <div className={`grid grid-cols-1 ${facebookEnabled ? 'sm:grid-cols-2' : ''} gap-2`} data-testid="save-account-actions">
        <button type="button" onClick={run('google', signInWithGoogle, 'Google')} disabled={!!busy} className={btn}>
          {busy === 'google' && <Loader2 className="w-3 h-3 animate-spin" />} Guardar mi cuenta con Google
        </button>
        {facebookEnabled && (
          <button type="button" onClick={run('facebook', signInWithFacebook, 'Facebook')} disabled={!!busy} className={btn} data-testid="save-account-facebook">
            {busy === 'facebook' ? <Loader2 className="w-3 h-3 animate-spin" /> : <FacebookIcon className="w-3.5 h-3.5" />} Guardar mi cuenta con Facebook
          </button>
        )}
      </div>
    </div>
  );
}
