// An invitation is delivered in the URL fragment. It stays in this tab and
// never travels in a Hosting request or a referral URL.
const TOKEN = 'aqp_tilopay_invitation';
const SESSION = 'aqp_tilopay_pilot_session';

export function captureInvitation(browser = window) {
  const match = /^#tilopay-pilot=([a-f0-9]{64})$/.exec(browser.location.hash);
  if (!match) return;
  try {
    const storage = browser.sessionStorage;
    if (storage.getItem(TOKEN) !== match[1] || !storage.getItem(SESSION)) {
      storage.setItem(SESSION, browser.crypto.randomUUID().replaceAll('-', ''));
      storage.setItem(TOKEN, match[1]);
    }
  } finally {
    browser.history.replaceState(browser.history.state, '', browser.location.pathname + browser.location.search);
  }
}

if (typeof window !== 'undefined') captureInvitation();

export function pilotProof() {
  try {
    const pilotToken = window.sessionStorage.getItem(TOKEN);
    const pilotSession = window.sessionStorage.getItem(SESSION);
    return pilotToken && pilotSession ? { pilotToken, pilotSession } : {};
  } catch { return {}; }
}

export function pilotStorageKey(base) {
  const session = pilotProof().pilotSession;
  return session ? `${base}_pilot_${session}` : base;
}
