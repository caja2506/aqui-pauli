import React, { useState, useEffect, useRef } from 'react';
import { ArrowLeft, ShoppingBag, Loader2 } from 'lucide-react';
import { useAuth, socialAuthErrorMessage } from '../../contexts/AuthContext';
import { useAuthFlags } from '../../hooks/useAuthFlags';
import usePageTitle from '../../hooks/usePageTitle';
import FacebookIcon from './FacebookIcon';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { requestPasswordReset, passwordResetErrorMessage, PASSWORD_RESET_SUCCESS } from '../../services/passwordReset';

export default function LoginPage() {
  const { user, signInWithGoogle, signInWithFacebook, redirectError, signInWithEmail, createAccount } = useAuth();
  const { facebookEnabled } = useAuthFlags();
  const navigate = useNavigate();
  const location = useLocation();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState(() => location.state?.mode === 'register' ? 'register' : 'login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [resetSent, setResetSent] = useState(false);
  const resetPending = useRef(false);
  usePageTitle(`${mode === 'reset' ? 'Restablecer contraseña' : mode === 'register' ? 'Crear cuenta' : 'Iniciar sesión'} | Aquí Pauli`);

  const redirectTo = location.state?.from || '/';
  const displayedError = error || (mode !== 'reset' ? redirectError : null);

  const changeMode = (nextMode) => {
    if (isLoading || resetPending.current) return;
    setMode(nextMode);
    setError(null);
    setResetSent(false);
    setPassword('');
  };

  const handleSuccess = () => {
    navigate(redirectTo, { replace: true });
  };

  // Una sesión autenticada (incluido un redirect anterior) continúa al destino.
  useEffect(() => {
    if (user && !user.isAnonymous) navigate(redirectTo, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const handleFacebookLogin = async () => {
    setIsLoading(true);
    setError(null);
    try {
      await signInWithFacebook();
      handleSuccess();
    } catch (err) {
      setError(socialAuthErrorMessage(err, 'Facebook'));
      setIsLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    setIsLoading(true);
    setError(null);
    try {
      await signInWithGoogle();
      handleSuccess();
    } catch (err) {
      setError(socialAuthErrorMessage(err, 'Google'));
      setIsLoading(false);
    }
  };

  const handleEmailSubmit = async (e) => {
    e.preventDefault();
    if (isLoading || resetPending.current) return;
    if (mode === 'reset') {
      resetPending.current = true;
      setIsLoading(true);
      setError(null);
      setResetSent(false);
      try {
        await requestPasswordReset(email);
        setResetSent(true);
      } catch (err) {
        setError(passwordResetErrorMessage(err));
      } finally {
        resetPending.current = false;
        setIsLoading(false);
      }
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      if (mode === 'register') {
        await createAccount(email, password, name);
      } else {
        await signInWithEmail(email, password);
      }
      handleSuccess();
    } catch (err) {
      const messages = {
        'auth/email-already-in-use': 'Este correo ya está registrado',
        'auth/invalid-email': 'Correo electrónico inválido',
        'auth/weak-password': 'La contraseña debe tener al menos 6 caracteres',
        'auth/user-not-found': 'No existe una cuenta con este correo',
        'auth/wrong-password': 'Contraseña incorrecta',
        'auth/invalid-credential': 'Credenciales inválidas',
      };
      setError(messages[err.code] || err.message || 'Error al iniciar sesión');
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-rose-950 p-4">
      {/* Ambient Glow */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-rose-600/20 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-1/4 right-1/4 w-64 h-64 bg-rose-600/15 rounded-full blur-[100px] pointer-events-none" />

      <div className="relative z-10 w-full max-w-md">
        <Link to="/" className="mb-5 inline-flex items-center gap-2 rounded-lg px-2 py-2 text-sm font-semibold text-rose-200 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-rose-300">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Volver a la tienda
        </Link>
        <div className="bg-slate-900/80 backdrop-blur-2xl rounded-3xl border border-slate-700/50 shadow-2xl shadow-black/50 p-8 sm:p-10">
          {/* Logo */}
          <div className="flex flex-col items-center mb-8">
            <div className="w-20 h-20 bg-gradient-to-br from-rose-500 to-rose-600 rounded-2xl flex items-center justify-center mb-5 shadow-lg shadow-rose-900/40 rotate-3 hover:rotate-0 transition-transform duration-300">
              <ShoppingBag className="w-10 h-10 text-white" />
            </div>
            <h1 className="text-3xl font-black text-white tracking-tight">Aquí Pauli</h1>
            <p className="text-sm text-slate-400 mt-2 text-center">
              Tu tienda online en Costa Rica
            </p>
          </div>

          {/* Tabs */}
          <div className="flex items-center gap-3 mb-6">
            <button
              type="button"
              onClick={() => changeMode('login')}
              disabled={isLoading}
              className={`flex-1 py-2 rounded-xl text-sm font-bold transition-all ${mode === 'login' ? 'bg-rose-600 text-white' : 'text-slate-400 hover:text-white'}`}
            >
              Iniciar Sesión
            </button>
            <button
              type="button"
              onClick={() => changeMode('register')}
              disabled={isLoading}
              className={`flex-1 py-2 rounded-xl text-sm font-bold transition-all ${mode === 'register' ? 'bg-rose-600 text-white' : 'text-slate-400 hover:text-white'}`}
            >
              Crear Cuenta
            </button>
          </div>

          {/* Error */}
          {displayedError && (
            <div role="alert" className="mb-6 bg-red-950/50 border border-red-500/30 rounded-xl p-3 text-sm text-red-300 text-center">
              {displayedError}
            </div>
          )}

          {mode === 'reset' && (
            <div className="mb-5 text-center">
              <h2 className="text-xl font-bold text-white">Restablecer contraseña</h2>
              <p className="mt-2 text-sm text-slate-400">Ingresá el correo de tu cuenta para recibir un enlace y elegir una contraseña nueva.</p>
            </div>
          )}
          {mode === 'reset' && resetSent && (
            <div role="status" aria-live="polite" className="mb-5 rounded-xl border border-emerald-500/30 bg-emerald-950/50 p-4 text-sm text-emerald-200">
              {PASSWORD_RESET_SUCCESS}
            </div>
          )}

          {/* Email/Password Form */}
          <form onSubmit={handleEmailSubmit} className="space-y-4 mb-6" aria-busy={isLoading}>
            {mode === 'register' && (
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Tu nombre"
                aria-label="Tu nombre"
                autoComplete="name"
                disabled={isLoading}
                className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700/50 rounded-xl text-white placeholder-slate-500 text-sm outline-none focus:ring-2 focus:ring-rose-500 focus:border-transparent transition-all"
                required
              />
            )}
            <input
              type="email"
              value={email}
              onChange={e => { setEmail(e.target.value); setResetSent(false); setError(null); }}
              placeholder="correo@ejemplo.com"
              aria-label="Correo electrónico"
              autoComplete={mode === 'login' ? 'username' : 'email'}
              autoCapitalize="none"
              spellCheck={false}
              disabled={isLoading}
              className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700/50 rounded-xl text-white placeholder-slate-500 text-sm outline-none focus:ring-2 focus:ring-rose-500 focus:border-transparent transition-all"
              required
            />
            {mode !== 'reset' && <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Contraseña"
              aria-label="Contraseña"
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              disabled={isLoading}
              className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700/50 rounded-xl text-white placeholder-slate-500 text-sm outline-none focus:ring-2 focus:ring-rose-500 focus:border-transparent transition-all"
              required
              minLength={6}
            />}
            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-3.5 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-xl transition-all shadow-lg hover:shadow-xl active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed text-sm"
            >
              {isLoading ? <span className="flex items-center justify-center gap-2"><Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />{mode === 'reset' ? 'Enviando enlace...' : 'Procesando...'}</span>
                : mode === 'reset' ? 'Enviar enlace de recuperación' : mode === 'register' ? 'Crear Cuenta' : 'Iniciar Sesión'}
            </button>
            {mode === 'login' && (
              <button type="button" onClick={() => changeMode('reset')} disabled={isLoading}
                className="w-full rounded-lg py-2 text-sm font-semibold text-rose-300 underline underline-offset-4 hover:text-rose-200 disabled:opacity-50">
                ¿Olvidaste tu contraseña?
              </button>
            )}
            {mode === 'reset' && (
              <button type="button" onClick={() => changeMode('login')} disabled={isLoading}
                className="w-full rounded-lg py-2 text-sm font-semibold text-rose-300 hover:text-rose-200 disabled:opacity-50">
                Volver a iniciar sesión
              </button>
            )}
          </form>

          {mode !== 'reset' && <>
          {/* Divider */}
          <div className="flex items-center gap-3 mb-6">
            <div className="flex-1 h-px bg-slate-700/50" />
            <span className="text-[11px] font-bold text-slate-500 uppercase tracking-widest">o</span>
            <div className="flex-1 h-px bg-slate-700/50" />
          </div>

          {/* Google Button */}
          <button
            onClick={handleGoogleLogin}
            disabled={isLoading}
            className="w-full flex items-center justify-center gap-3 bg-white hover:bg-slate-50 text-slate-800 font-bold py-3.5 px-6 rounded-xl transition-all duration-200 shadow-lg hover:shadow-xl hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
          >
            {isLoading ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <svg className="w-5 h-5" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.99 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
              </svg>
            )}
            Continuar con Google
          </button>

          {/* Facebook habilitado; config/auth.facebookEnabled=false permite ocultarlo. */}
          {facebookEnabled && (
            <button
              type="button"
              onClick={handleFacebookLogin}
              disabled={isLoading}
              data-testid="login-facebook"
              className="mt-3 w-full flex items-center justify-center gap-3 bg-[#1877F2] hover:bg-[#166FE5] text-white font-bold py-3.5 px-6 rounded-xl transition-all duration-200 shadow-lg hover:shadow-xl active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span className="bg-white rounded-full p-0.5"><FacebookIcon className="w-5 h-5" /></span>
              Continuar con Facebook
            </button>
          )}
          </>}
        </div>

        <p className="text-[10px] text-slate-600 text-center mt-6">
          © {new Date().getFullYear()} Aquí Pauli — Powered by Firebase
        </p>
      </div>
    </div>
  );
}
