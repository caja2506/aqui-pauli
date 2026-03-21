import React, { useState } from 'react';
import { Plus, Edit3, Trash2, FolderTree, X } from 'lucide-react';
import { useCollection } from '../../hooks/useCollection';
import { createCategory, updateCategory, deleteCategory } from '../../services/productService';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import EmptyState from '../../components/ui/EmptyState';

export default function CategoriesPage() {
  const { data: categories } = useCollection('categories');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [confirmDelete, setConfirmDelete] = useState({ isOpen: false, title: '', message: '', onConfirm: null });

  const openNew = () => { setEditingCategory(null); setName(''); setDescription(''); setImageUrl(''); setIsModalOpen(true); };
  const openEdit = (cat) => { setEditingCategory(cat); setName(cat.name); setDescription(cat.description || ''); setImageUrl(cat.imageUrl || ''); setIsModalOpen(true); };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (editingCategory) {
      await updateCategory(editingCategory.id, { name: name.trim(), description: description.trim(), imageUrl: imageUrl.trim() });
    } else {
      await createCategory({ name: name.trim(), description: description.trim(), imageUrl: imageUrl.trim() });
    }
    setIsModalOpen(false);
  };

  const handleDelete = (cat) => {
    setConfirmDelete({
      isOpen: true,
      title: 'Eliminar Categoría',
      message: `¿Eliminar "${cat.name}"?`,
      onConfirm: () => deleteCategory(cat.id),
    });
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-6 rounded-3xl border border-slate-100 shadow-sm">
        <div>
          <h2 className="font-black text-2xl text-slate-800 tracking-tight">Categorías</h2>
          <p className="text-sm text-slate-400 mt-1">{categories.length} categoría{categories.length !== 1 ? 's' : ''}</p>
        </div>
        <button onClick={openNew} className="bg-indigo-600 text-white px-6 py-3 rounded-2xl font-black shadow-lg flex items-center justify-center active:scale-95 transition-transform text-sm">
          <Plus className="mr-2 w-4 h-4" /> Nueva Categoría
        </button>
      </div>

      {categories.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {categories.map(cat => (
            <div key={cat.id} className="bg-white p-5 rounded-2xl border border-slate-100 shadow-sm group hover:border-indigo-200 transition-all">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 min-w-0">
                  {cat.imageUrl ? (
                    <img src={cat.imageUrl} alt="" className="w-10 h-10 rounded-lg object-cover border border-slate-200" />
                  ) : (
                    <div className="w-10 h-10 rounded-lg bg-purple-50 flex items-center justify-center"><FolderTree className="w-5 h-5 text-purple-300" /></div>
                  )}
                  <div className="min-w-0">
                    <span className="font-bold text-slate-900 block truncate">{cat.name}</span>
                    {cat.description && <p className="text-[10px] text-slate-400 truncate">{cat.description}</p>}
                  </div>
                </div>
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button onClick={() => openEdit(cat)} className="p-2 text-amber-500 bg-amber-50 rounded-lg hover:bg-amber-100"><Edit3 className="w-4 h-4" /></button>
                  <button onClick={() => handleDelete(cat)} className="p-2 text-red-500 bg-red-50 rounded-lg hover:bg-red-100"><Trash2 className="w-4 h-4" /></button>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState icon={FolderTree} title="Sin categorías" message="Crea la primera categoría para organizar tus productos" />
      )}

      {/* Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[250] flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md p-6 animate-in zoom-in duration-200">
            <div className="flex justify-between items-center mb-6 border-b pb-4">
              <h2 className="font-black text-xl flex items-center tracking-tighter"><FolderTree className="mr-2 text-indigo-600 w-5 h-5" /> {editingCategory ? 'Editar' : 'Nueva'} Categoría</h2>
              <button onClick={() => setIsModalOpen(false)} className="p-2 text-slate-400 hover:bg-slate-100 rounded-full"><X className="w-4 h-4" /></button>
            </div>
            <form onSubmit={handleSave} className="space-y-4">
              <div>
                <label className="text-xs font-bold text-slate-400 uppercase ml-1 mb-1 block">Nombre</label>
                <input value={name} onChange={e => setName(e.target.value)} placeholder="Ej: Electrónica" className="w-full p-4 border border-slate-200 rounded-2xl bg-slate-50 outline-none focus:ring-2 focus:ring-indigo-500 font-bold" required />
              </div>
              <div>
                <label className="text-xs font-bold text-slate-400 uppercase ml-1 mb-1 block">Descripción (opcional)</label>
                <textarea value={description} onChange={e => setDescription(e.target.value)} className="w-full p-4 border border-slate-200 rounded-2xl bg-slate-50 outline-none focus:ring-2 focus:ring-indigo-500" rows={2} />
              </div>
              <div>
                <label className="text-xs font-bold text-slate-400 uppercase ml-1 mb-1 block">URL Imagen (opcional)</label>
                <input value={imageUrl} onChange={e => setImageUrl(e.target.value)} placeholder="https://..." className="w-full p-4 border border-slate-200 rounded-2xl bg-slate-50 outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <button type="submit" className="w-full p-4 bg-indigo-600 text-white rounded-2xl font-black shadow-lg hover:bg-indigo-700 active:scale-95 transition-all">
                {editingCategory ? 'Actualizar' : 'Crear Categoría'}
              </button>
            </form>
          </div>
        </div>
      )}

      <ConfirmDialog {...confirmDelete} onClose={() => setConfirmDelete({ isOpen: false, onConfirm: null })} />
    </div>
  );
}
