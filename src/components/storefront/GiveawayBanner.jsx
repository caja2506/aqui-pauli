import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { useGiveaway } from '../../hooks/useGiveaway';

export default function GiveawayBanner() {
  const { status, loading, error } = useGiveaway();
  if (loading || error || status !== 'active') return null;

  return (
    <aside aria-label="Sorteo de Aquí Pauli" className="border-y border-rose-200 bg-rose-100 text-rose-950">
      <Link
        to="/sorteo"
        className="mx-auto flex max-w-7xl items-center justify-center gap-3 px-4 py-4 text-center text-sm font-bold leading-relaxed transition-colors hover:bg-rose-200/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-600 sm:text-base"
        data-testid="giveaway-banner"
      >
        <span>🎁 Sorteo: ganá Light Blue Mujer EDT 25 ml o Acqua di Giò EDT 100 ml — <span className="underline underline-offset-4">Participar</span></span>
        <ArrowRight className="h-5 w-5 shrink-0" aria-hidden="true" />
      </Link>
    </aside>
  );
}
