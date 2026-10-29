import { useEffect, useState } from 'react';
import { GIVEAWAY, giveawayStatus, watchGiveawayConfig, watchOwnGiveawayEntry } from '../services/giveawayService';

export function useGiveaway() {
  const [config, setConfig] = useState({ enabled: false, loading: true, error: false });
  const [now, setNow] = useState(Date.now);

  useEffect(() => watchGiveawayConfig(
    (enabled) => setConfig({ enabled, loading: false, error: false }),
    () => setConfig({ enabled: false, loading: false, error: true }),
  ), []);

  useEffect(() => {
    const update = () => setNow(Date.now());
    const nextBoundary = [Date.parse(GIVEAWAY.startsAt), Date.parse(GIVEAWAY.endsAt)]
      .find((boundary) => boundary > now);
    // El temporizador alcanza el límite exacto; al volver a la pestaña se vuelve
    // a consultar el reloj. El servidor también comprueba la fecha al inscribir.
    const delay = Math.max(1, Math.min(60 * 60 * 1000, (nextBoundary ?? now + 60 * 60 * 1000) - now));
    const timer = window.setTimeout(update, delay);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [now]);

  const status = giveawayStatus(config.enabled, now);
  return { ...config, status, isOpen: status === 'active' };
}

export function useGiveawayEntry(uid) {
  const [state, setState] = useState({ uid: null, entry: null, loading: false, error: false });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!uid) return undefined;
    let alive = true;
    const unsubscribe = watchOwnGiveawayEntry(uid,
      (entry) => { if (alive) setState({ uid, entry, loading: false, error: false }); },
      () => { if (alive) setState({ uid, entry: null, loading: false, error: true }); },
    );
    return () => { alive = false; unsubscribe(); };
  }, [uid, attempt]);

  return {
    entry: uid && state.uid === uid ? state.entry : null,
    loading: Boolean(uid) && (state.uid !== uid || state.loading),
    error: Boolean(uid) && state.uid === uid && state.error,
    retry: () => {
      setState({ uid, entry: null, loading: true, error: false });
      setAttempt((value) => value + 1);
    },
  };
}
