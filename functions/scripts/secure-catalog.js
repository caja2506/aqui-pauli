#!/usr/bin/env node
"use strict";
const { isFullPerfume, minimumCatalogPrice } = require('../lib/catalogSafety.mjs');
const { getVariantPrice } = require('../lib/catalogPrice.mjs');
// Convenciones de los productos técnicos; no se publica un inventario de IDs reales.
const isTestProduct = (id, product) => /^(prueba-|zz-tilopay-)/.test(id)
  || (product.active === false && /^(test|prueba)$/i.test(String(product.name || '').trim()));

function planProduct(id, product, variants) {
  const productPatch = {};
  const changes = [];
  const test = isTestProduct(id, product);
  const badBase = getVariantPrice(product, {}) === null;
  if ((test || badBase) && product.active !== false) productPatch.active = false;
  for (const variant of variants) {
    const patch = {};
    if ((test || getVariantPrice(product, variant) === null) && variant.active !== false) patch.active = false;
    if (isFullPerfume(product)) {
      const stock = variant.stock ?? 0, reserved = variant.reservedStock ?? 0;
      if (!Number.isSafeInteger(stock) || stock < 0 || !Number.isSafeInteger(reserved) || reserved < 0 || reserved > stock || reserved > 1) {
        // Nunca descartar reservas ni inventar stock ante datos ambiguos.
        if (variant.active !== false) patch.active = false;
      } else {
        if (stock > 1) patch.stock = 1;
        if (variant.supplyType !== 'stock_propio') patch.supplyType = 'stock_propio';
        const status = stock === 0 ? 'agotado' : 'disponible';
        if (variant.commercialStatus !== status) patch.commercialStatus = status;
      }
    }
    if (Object.keys(patch).length) changes.push({ id: variant.id, patch });
  }
  return { productPatch, changes, minimumPrice: minimumCatalogPrice(product) };
}

async function secureCatalog({ db, apply = false, onEvent = console.log }) {
  const products = await db.collection('products').get();
  const summary = { products: products.size, variants: 0, perfumes: 0, productChanges: 0, variantChanges: 0, applied: apply };
  for (const initial of products.docs) {
    const result = await db.runTransaction(async tx => {
      const productSnap = await tx.get(initial.ref);
      if (!productSnap.exists) return null;
      const variantSnaps = await tx.get(initial.ref.collection('variants'));
      const product = productSnap.data();
      const variants = variantSnaps.docs.map(doc => ({ ...doc.data(), id: doc.id }));
      const plan = planProduct(initial.id, product, variants);
      if (apply && (Object.keys(plan.productPatch).length || plan.changes.length)) {
        // Evidencia privada anterior a cada cambio. Ningún precio se reescribe.
        const audit = db.collection('catalog_safety_audit').doc();
        tx.set(audit, { productId: initial.id, recordedAt: new Date().toISOString(),
          before: { active: product.active ?? true, variants: variants.map(v => ({
            id: v.id, stock: v.stock ?? null, reservedStock: v.reservedStock ?? null,
            active: v.active ?? true, supplyType: v.supplyType ?? null, commercialStatus: v.commercialStatus ?? null,
          })) }, changes: plan });
        if (Object.keys(plan.productPatch).length) tx.update(initial.ref, plan.productPatch);
        for (const change of plan.changes) tx.update(initial.ref.collection('variants').doc(change.id), change.patch);
      }
      return { variants: variants.length, perfume: isFullPerfume(product), plan };
    });
    if (!result) continue;
    summary.variants += result.variants;
    summary.perfumes += Number(result.perfume);
    summary.productChanges += Number(Object.keys(result.plan.productPatch).length > 0);
    summary.variantChanges += result.plan.changes.length;
    // Los detalles quedan únicamente en la auditoría privada de Firestore.
  }
  onEvent(JSON.stringify(summary));
  return summary;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args[0] !== '--project' || args[1] !== 'aqui-pauli' || !['--apply', '--dry-run', '--verify'].includes(args[2])) {
    throw new Error('Uso: secure-catalog.js --project aqui-pauli --dry-run|--apply|--verify');
  }
  const { initializeApp, applicationDefault } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  initializeApp({ projectId: 'aqui-pauli', credential: applicationDefault() });
  secureCatalog({ db: getFirestore(), apply: args[2] === '--apply' }).then(summary => {
    if (args[2] === '--verify' && (summary.productChanges || summary.variantChanges)) process.exitCode = 1;
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { planProduct, secureCatalog };
