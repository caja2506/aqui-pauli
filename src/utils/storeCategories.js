const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
const rank = ['decants', 'perfumes hombre', 'perfumes mujer', 'perfumes unisex', 'bolsos', 'tenis', 'carteras', 'perfumes'];

export function categoryChips(categories) {
  const active = categories.filter(c => c.active !== false && !c.deleted && c.name);
  const byId = new Map(active.map(c => [c.id, c]));
  return active.map(c => {
    const parent = byId.get(c.parentId?.id || c.parentId);
    const gender = { hombres: 'hombre', hombre: 'hombre', mujeres: 'mujer', mujer: 'mujer', unisex: 'unisex' }[normalize(c.name)];
    const label = normalize(parent?.name) === 'perfumes' && gender ? 'Perfumes ' + gender : c.name;
    const position = rank.indexOf(normalize(label));
    return { id: c.id, label, position: position < 0 ? rank.length : position };
  }).sort((a, b) => a.position - b.position || a.label.localeCompare(b.label, 'es'));
}

export function matchesCategory(product, selectedId, byId) {
  if (!selectedId) return true;
  return (product.categoryRefs || []).some(ref => {
    let id = ref?.id || ref;
    const visited = new Set();
    while (id && !visited.has(id)) {
      if (id === selectedId) return true;
      visited.add(id);
      const parent = byId[id]?.parentId;
      id = parent?.id || parent;
    }
    return false;
  });
}
