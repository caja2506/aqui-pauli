import React, { useState } from 'react';
import { Plus, Edit3, Trash2, Tag, X } from 'lucide-react';
import { useCollection } from '../../hooks/useCollection';
import { createBrand, updateBrand, deleteBrand } from '../../services/productService';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import EmptyState from '../../components/ui/EmptyState';

export default function BrandsPage() {
  const { data: brands, loading } = useCollection('brands');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingBrand, setEditingBrand] = useState(null);
  const [name, setName] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [confirmDelete, setConfirmDelete] = useState({ isOpen: false, title: '', message: '', onConfirm: null });

  const openNew = () => { setEditingBrand(null); setName(''); setLogoUrl(''); setIsModalOpen(true); };
  const openEdit = (brand) => { setEditingBrand(brand); setName(brand.name); setLogoUrl(brand.logoUrl || ''); setIsModalOpen(true); };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (editingBrand) {
      await updateBrand(editingBrand.id, { name: name.trim(), logoUrl: logoUrl.trim() });
    } else {
      await createBrand(name.trim());
    }
    setIsModalOpen(false);
  };

  const handleDelete = (brand) => {
    setConfirmDelete({
      isOpen: true,
      title: 'Eliminar Marca',
      message: `¿Eliminar "${brand.name}"? Los productos asociados perderán esta marca.`,
      onConfirm: () => deleteBrand(brand.id),
    });
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-6 rounded-3xl border border-slate-100 shadow-sm">
        <div>
          <h2 className="font-black text-2xl text-slate-800 tracking-tight">Marcas</h2>
          <p className="text-sm text-slate-400 mt-1">{brands.length} marca{brands.length !== 1 ? 's' : ''} registrada{brands.length !== 1 ? 's' : ''}</p>
        </div>
        <button onClick={openNew} className="bg-rose-600 text-white px-6 py-3 rounded-2xl font-black shadow-lg flex items-center justify-center active:scale-95 transition-transform text-sm">
          <Plus className="mr-2 w-4 h-4" /> Nueva Marca
        </button>
      </div>

      {brands.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {brands.map(brand => (
            <div key={brand.id} className="bg-white p-5 rounded-2xl border border-slate-100 shadow-sm flex items-center justify-between group hover:border-rose-200 transition-all">
              <div className="flex items-center gap-3 min-w-0">
                {brand.logoUrl ? (
                  <img src={brand.logoUrl} alt="" className="w-10 h-10 rounded-lg object-contain border border-slate-200" />
                ) : (
                  <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center"><Tag className="w-5 h-5 text-slate-300" /></div>
                )}
                <span className="font-bold text-slate-900 truncate">{brand.name}</span>
              </div>
              <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button onClick={() => openEdit(brand)} className="p-2 text-amber-500 bg-amber-50 rounded-lg hover:bg-amber-100"><Edit3 className="w-4 h-4" /></button>
                <button onClick={() => handleDelete(brand)} className="p-2 text-red-500 bg-red-50 rounded-lg hover:bg-red-100"><Trash2 className="w-4 h-4" /></button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState icon={Tag} title="Sin marcas" message="Crea la primera marca para tus productos" />
      )}

      {/* Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[250] flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md p-6 animate-in zoom-in duration-200">
            <div className="flex justify-between items-center mb-6 border-b pb-4">
              <h2 className="font-black text-xl flex items-center tracking-tighter"><Tag className="mr-2 text-rose-600 w-5 h-5" /> {editingBrand ? 'Editar Marca' : 'Nueva Marca'}</h2>
              <button onClick={() => setIsModalOpen(false)} className="p-2 text-slate-400 hover:bg-slate-100 rounded-full"><X className="w-4 h-4" /></button>
            </div>
            <form onSubmit={handleSave} className="space-y-4">
              <div>
                <label className="text-xs font-bold text-slate-400 uppercase ml-1 mb-1 block">Nombre</label>
                <input value={name} onChange={e => setName(e.target.value)} placeholder="Ej: Samsung" className="w-full p-4 border border-slate-200 rounded-2xl bg-slate-50 outline-none focus:ring-2 focus:ring-rose-500 font-bold" required />
              </div>
              <div>
                <label className="text-xs font-bold text-slate-400 uppercase ml-1 mb-1 block">URL Logo (opcional)</label>
                <input value={logoUrl} onChange={e => setLogoUrl(e.target.value)} placeholder="https://..." className="w-full p-4 border border-slate-200 rounded-2xl bg-slate-50 outline-none focus:ring-2 focus:ring-rose-500" />
              </div>
              <button type="submit" className="w-full p-4 bg-rose-600 text-white rounded-2xl font-black shadow-lg hover:bg-rose-700 active:scale-95 transition-all">
                {editingBrand ? 'Actualizar' : 'Crear Marca'}
              </button>
            </form>
          </div>
        </div>
      )}

      <ConfirmDialog {...confirmDelete} onClose={() => setConfirmDelete({ isOpen: false, onConfirm: null })} />
    </div>
  );
}
