import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Menu, X } from 'lucide-react';
import { useCollection } from '../../hooks/useCollection';
import { categoryChips } from '../../utils/storeCategories';

const linkStyle = 'block rounded-xl px-3 py-3 text-sm font-semibold text-slate-700 hover:bg-rose-50 focus-visible:outline-rose-600';

function CategoryLinks() {
  const { data, loading, error, retry } = useCollection('categories');
  if (error) return <button type="button" onClick={retry} className={linkStyle}>Volver a cargar categorías</button>;
  if (loading) return <p className="px-3 py-2 text-sm text-slate-500">Cargando categorías…</p>;
  return categoryChips(data).map(({ id, label }) => (
    <Link key={id} to={'/catalogo?' + new URLSearchParams({ categoria: id })} className={linkStyle}>{label}</Link>
  ));
}

export default function MobileCategoryMenu({ isAdmin, user }) {
  const dialog = useRef(null);
  const [open, setOpen] = useState(false);
  const close = () => dialog.current?.close();

  return (
    <>
      <button type="button" aria-label="Abrir menú de categorías" aria-haspopup="dialog"
        aria-expanded={open} aria-controls="store-category-menu"
        onClick={() => { dialog.current.showModal(); setOpen(true); }}
        className="mr-1 grid size-11 shrink-0 place-items-center rounded-xl text-slate-600 hover:bg-slate-100">
        <Menu className="size-5" />
      </button>
      <dialog ref={dialog} id="store-category-menu" aria-labelledby="store-category-title"
        onClose={() => setOpen(false)}
        onClick={event => { if (event.target === event.currentTarget) close(); }}
        className="fixed inset-y-0 left-0 m-0 h-dvh max-h-none w-[min(20rem,86vw)] max-w-none overflow-y-auto overscroll-contain border-0 bg-white p-0 text-slate-900 shadow-xl backdrop:bg-slate-950/55">
        <div className="min-h-full px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))]">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <h2 id="store-category-title" className="text-lg font-black">Categorías</h2>
            <button type="button" onClick={close} aria-label="Cerrar menú"
              className="grid size-11 place-items-center rounded-xl hover:bg-slate-100"><X className="size-5" /></button>
          </div>
          <nav aria-label="Menú de la tienda" className="pt-2"
            onClick={event => { if (event.target.closest('a[href]')) close(); }}>
            <Link to="/" className={linkStyle}>Inicio</Link>
            <Link to="/catalogo" className={linkStyle}>Catálogo</Link>
            <div className="my-2 border-y border-slate-100 py-2">{open && <CategoryLinks />}</div>
            {user && <Link to="/mi-cuenta" className={linkStyle}>Mis Pedidos</Link>}
            {isAdmin && <Link to="/admin" className={linkStyle}>Panel Admin</Link>}
          </nav>
        </div>
      </dialog>
    </>
  );
}
