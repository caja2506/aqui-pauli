// Shared by checkout and return page; keep the backend validator under parity tests.
export function isValidTilopayPaymentUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    const suffix = '.tilopay.com';
    const host = url.hostname;
    const labels = host.endsWith(suffix) ? host.slice(0, -suffix.length).split('.') : [];
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
      && host.length <= 253 && labels.length > 0
      && labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
  } catch {
    return false;
  }
}
