const SITE = "https://aqui-pauli.web.app";
const HEAD = ["id","item_group_id","title","description","availability","condition","price","link","image_link","additional_image_link","brand","google_product_category","product_type","custom_label_0","custom_label_1"];
const esc = v => { v = (v ?? "").toString().replace(/\r?\n/g," ").trim(); return /[",]/.test(v) ? '"' + v.replace(/"/g,'""') + '"' : v; };
const avail = v => {
  if (!v) return "out of stock";
  if ((v.stock||0) - (v.reservedStock||0) > 0) return "in stock";
  if (v.commercialStatus === "bajo_pedido" || v.supplyType === "bajo_pedido") return "in stock"; // Meta/WhatsApp hide non-"in stock" items; made-to-order shown as in stock
  if (v.commercialStatus === "disponible") return "in stock";
  return "out of stock";
};
// Categories: cats = {id: {name, active, parentId}}; product.categoryIdList = ids (from categoryRefs/categoryIds).
// custom_label_0 = top-level (root) category; custom_label_1 = sub-category (e.g. Hombres/Mujeres);
// product_type = "Root > Sub" (extra roots, if any, appended after ", ").
function catInfo(p, cats) {
  const act = (p.categoryIdList || []).map(id => ({ id, ...(cats[id] || {}) })).filter(c => c.name && c.active !== false);
  const roots = act.filter(c => !c.parentId || !cats[c.parentId]);
  const subs = act.filter(c => c.parentId && cats[c.parentId]);
  const top = roots[0] || (subs[0] && { id: subs[0].parentId, ...cats[subs[0].parentId] });
  if (!top) return { product_type: "", custom_label_0: "", custom_label_1: "" };
  const sub = subs.find(c => c.parentId === top.id);
  const path = c => (c.parentId && cats[c.parentId] ? `${cats[c.parentId].name} > ${c.name}` : c.name);
  const types = [sub ? path(sub) : top.name, ...roots.filter(c => c.id !== top.id).map(path)];
  return { product_type: types.join(", "), custom_label_0: top.name, custom_label_1: sub ? sub.name : "" };
}
// Descripciones antiguas prometían "envío incluido y pago contra entrega" (el checkout cobra el envío y no ofrece contra entrega)
const OLD_PROMISE_RE = /env[ií]o\s+(?:incluido|gratis|gratuito)(?:\s+(?:a|en)\s+todo\s+(?:el\s+)?pa[ií]s)?(?:\s*(?:y|e|,|\+|\/)\s*(?:pago\s+)?(?:contra\s*entrega|contraentrega))?|(?:pago\s+)?contra\s*-?\s*entrega/gi;
const SHIPPING_NOTE = "Envío incluido a todo el país. Elegís el método de pago al finalizar la compra.";
const cleanDesc = (t) => { let used = false; return (t||"").replace(OLD_PROMISE_RE, () => (used ? "" : ((used = true), SHIPPING_NOTE))).replace(/\s*·\s*·\s*/g, " · ").replace(/\s*·\s*$/, "").replace(/\.\s*\./g, ".").trim(); };

// products: [{id, ...fields}], variants: {pid:[{id,...}]}, brands: {id:name}
function buildRows(products, variants, brands, cats = {}) {
  const rows = [], problems = [];
  for (const p of products) {
    if (!p.active || p.deleted) continue;
    const brand = brands[p.brandId] || "Aquí Pauli";
    const imgs = (p.images||[]).filter(u => /^https:\/\//.test(u));
    const vs = (variants[p.id]||[]).filter(v => v.active !== false).sort((a,b)=>(a.order||0)-(b.order||0));
    const ci = catInfo(p, cats);
    const base = { ...ci, title: p.name, description: cleanDesc(p.description) || `${p.name} - ${brand}. Disponible en Aquí Pauli, Costa Rica.`,
      condition: "new", link: `${SITE}/producto/${p.id}`, brand };
    const list = vs.length ? vs.map(v => ({ ...base, id: v.sku || `${p.id}-${v.id}`, item_group_id: vs.length>1 ? p.id : "",
        title: vs.length>1 && v.name ? `${p.name} - ${v.name}` : p.name,
        availability: avail(v), price: v.price || p.basePrice, image_link: v.imageUrl || imgs[0], additional_image_link: imgs.filter(u=>u!==(v.imageUrl||imgs[0])).slice(0,10).join(",") }))
      : [{ ...base, id: p.id, item_group_id: "", availability: "in stock", price: p.basePrice, image_link: imgs[0], additional_image_link: imgs.slice(1,11).join(",") }];
    for (const r of list) {
      const miss = ["id","title","description","availability","price","link","image_link","brand"].filter(k => !r[k]);
      if (!(Number(r.price) > 0)) miss.push("price");
      if (miss.length) { problems.push({ product: p.name, id: r.id, missing: [...new Set(miss)] }); continue; }
      r.price = `${Math.round(Number(r.price))} CRC`;
      rows.push(r);
    }
  }
  return { rows, problems };
}
const toCsv = rows => [HEAD.join(","), ...rows.map(r => HEAD.map(h => esc(r[h])).join(","))].join("\n") + "\n";
module.exports = { buildRows, toCsv };
