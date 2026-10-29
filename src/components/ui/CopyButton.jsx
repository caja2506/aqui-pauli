import { useState } from 'react';
import { Copy, Check } from 'lucide-react';

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* cae al método antiguo */ }
  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

export default function CopyButton({ text, label = 'Copiar', ariaLabel }) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    const ok = await copyText(String(text));
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel || `${label} ${text}`}
      className="inline-flex items-center gap-1.5 px-3 py-2 bg-white border border-slate-300 hover:bg-slate-50 text-slate-800 text-sm font-bold rounded-lg active:scale-95 transition-all shrink-0"
    >
      {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
      {copied ? '¡Copiado!' : label}
    </button>
  );
}
