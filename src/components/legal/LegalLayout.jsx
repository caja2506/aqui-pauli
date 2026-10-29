import { useEffect } from 'react';
import { Link } from 'react-router-dom';

export const LEGAL_LINKS = [
  { to: '/terminos', label: 'Términos y condiciones' },
  { to: '/devoluciones', label: 'Devoluciones y reembolsos' },
  { to: '/envios', label: 'Envíos y entregas' },
  { to: '/privacidad', label: 'Política de privacidad' },
];

export const LAST_UPDATED = '29 de octubre de 2026';

export const CONTACT = {
  whatsappLabel: '+506 7161 3342',
  whatsappUrl: 'https://wa.me/50671613342',
  email: 'hola@aquipauli.com',
  owner: 'Carlos Jiménez Arias',
  place: 'Grecia, Alajuela, Costa Rica',
};

export function Section({ title, children }) {
  return (
    <section className="mt-8">
      <h2 className="text-lg font-black text-slate-900 mb-2">{title}</h2>
      <div className="text-sm text-slate-600 leading-relaxed space-y-2">{children}</div>
    </section>
  );
}

export default function LegalLayout({ title, updated, children }) {
  useEffect(() => {
    const prev = document.title;
    document.title = `${title} | Aquí Pauli`;
    return () => { document.title = prev; };
  }, [title]);

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12" data-testid="legal-page">
      <h1 className="text-3xl font-black text-slate-900 tracking-tight">{title}</h1>
      <p className="text-xs text-slate-400 mt-2">Última actualización: {updated}</p>
      {children}
      <nav className="mt-12 pt-6 border-t border-slate-100 flex flex-wrap gap-x-5 gap-y-2" aria-label="Otras políticas">
        {LEGAL_LINKS.map((l) => (
          <Link key={l.to} to={l.to} className="text-xs font-bold text-rose-600 hover:text-rose-700">{l.label}</Link>
        ))}
      </nav>
    </div>
  );
}
