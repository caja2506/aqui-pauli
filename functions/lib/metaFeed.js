// FUENTE ÚNICA del feed de Meta. Lo usan: metaFeed (functions-metafeed/feed.js es una COPIA
// idéntica, ver functions-metafeed/README.md; un test verifica que no se desvíen) y el botón
// "Sync WhatsApp" (syncCatalogBatch). IDs = SKU de variante (o ID de producto sin variantes).
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
    if (!p.active || p.deleted || p.unlisted) continue;
    const brand = brands[p.brandId] || "Aquí Pauli";
    const imgs = (p.images||[]).filter(u => /^https:\/\//.test(u));
    const vs = (variants[p.id]||[]).filter(v => v.active !== false).sort((a,b)=>(a.order||0)-(b.order||0));
    const ci = catInfo(p, cats);
    const base = { ...ci, title: p.name, description: cleanDesc(p.description) || `${p.name} - ${brand}. Disponible en Aquí Pauli, Costa Rica.`,
      condition: "new", link: `${SITE}/producto/${p.id}`, brand };
    const list = vs.length ? vs.map(v => ({ ...base, id: v.sku || `${p.id}-${v.id}`, item_group_id: vs.length>1 ? p.id : "",
        title: vs.length>1 && v.name ? `${p.name} - ${v.name}` : p.name,
        availability: avail(v), price: v.price || p.basePrice, image_link: v.imageUrl || imgs[0], additional_image_link: imgs.filter(u=>u!==(v.imageUrl||imgs[0])).slice(0,10).join(",") }))
      // Sin variantes no se puede comprar: fuera de stock (no mostrar como disponible en Meta/WhatsApp)
      : [{ ...base, id: p.id, item_group_id: "", availability: "out of stock", price: p.basePrice, image_link: imgs[0], additional_image_link: imgs.slice(1,11).join(",") }];
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

// Lee Firestore y arma las filas del feed (la MISMA función la usan metaFeed y el botón Sync).
async function loadFeedRows(db) {
  const [ps, bs, cs] = await Promise.all([db.collection("products").get(), db.collection("brands").get(), db.collection("categories").get()]);
  const cats = {}; cs.forEach(d => cats[d.id] = { name: d.get("name"), active: d.get("active"), parentId: d.get("parentId") || null });
  const brands = {}; bs.forEach(d => brands[d.id] = d.get("name"));
  const products = ps.docs.map(d => ({ id: d.id, ...d.data(), brandId: d.get("brandRef")?.id,
    categoryIdList: (d.get("categoryRefs") || []).map(r => r.id).concat(d.get("categoryIds") || []) }));
  const variants = {};
  await Promise.all(products.map(async p => {
    const s = await db.collection("products").doc(p.id).collection("variants").get();
    variants[p.id] = s.docs.map(d => ({ id: d.id, ...d.data() }));
  }));
  return buildRows(products, variants, brands, cats);
}

// Fila del feed → item del items_batch de Meta (mismos campos, mismos IDs).
function rowToBatchItem(r) {
  const item = {};
  for (const h of HEAD) {
    let v = (r[h] ?? "").toString().trim();
    if (!v) continue;
    if (h === "additional_image_link") { item[h] = v.split(/,(?=https:\/\/)/).map(u => u.trim()).filter(Boolean) /* las URLs pueden contener comas */; continue; }
    item[h] = v;
  }
  return item;
}

module.exports = { buildRows, toCsv, loadFeedRows, rowToBatchItem };
