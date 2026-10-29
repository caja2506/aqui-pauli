// Prueba de reglas con el emulador (requiere Java). Uso:
//   mkdir /tmp/rt && cd /tmp/rt && npm i @firebase/rules-unit-testing firebase && cp <repo>/scripts/firestore-rules.test.mjs . && firebase emulators:exec --only firestore --project demo-aqp 'node firestore-rules.test.mjs'
// (firebase.json de /tmp/rt apunta a firestore.rules del repo, puerto 8080)
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { readFileSync } from 'fs';
import { doc, setDoc, getDoc, updateDoc, writeBatch, deleteDoc } from 'firebase/firestore';
import assert from 'node:assert/strict';
const env = await initializeTestEnvironment({ projectId: 'demo-aqp', firestore: { rules: readFileSync('/workspace/aqui-pauli-deploy/firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 } });
await env.withSecurityRulesDisabled(async (c) => {
  const d = c.firestore();
  await setDoc(doc(d, 'users_roles/admin1'), { role: 'admin' });
  await setDoc(doc(d, 'users_roles/u1'), { role: 'cliente' });
  await setDoc(doc(d, 'users_roles/u2'), { role: 'cliente' });
  await setDoc(doc(d, 'orders/o1'), { uid: 'u1', total: 1000, paymentStatus: 'pendiente', status: 'pendiente_pago', paymentProofUrl: '' });
  await setDoc(doc(d, 'orders/paid'), { uid: 'u1', total: 1000, paymentStatus: 'pagado', status: 'pagado' });
  await setDoc(doc(d, 'orders/paid/items/item_0'), { productId: 'p' });
  await setDoc(doc(d, 'orders/o1/items/item_0'), { productId: 'p' });
});
const u1 = env.authenticatedContext('u1').firestore();
const u2 = env.authenticatedContext('u2').firestore();
const adm = env.authenticatedContext('admin1').firestore();
const anon = env.unauthenticatedContext().firestore();
const baseOrder = { uid: 'u1', total: 5000, subtotal: 5000, paymentMethod: 'sinpe', paymentStatus: 'pendiente', status: 'pendiente_pago', paymentProofUrl: '' };
const ok = [], bad = [];
const t = async (name, p, expectOk) => { try { await (expectOk ? assertSucceeds(p) : assertFails(p)); ok.push(name); } catch (e) { bad.push(name); } };

// flujo normal del cliente: batch crear pedido + items
const b = writeBatch(u1); b.set(doc(u1, 'orders/n1'), baseOrder); b.set(doc(u1, 'orders/n1/items/item_0'), { productId: 'p', quantity: 1 });
await t('cliente crea pedido+items (batch)', b.commit(), true);
await t('cliente lee su pedido', getDoc(doc(u1, 'orders/o1')), true);
await t('cliente lee items propios', getDoc(doc(u1, 'orders/o1/items/item_0')), true);
await t('otro cliente NO lee pedido', getDoc(doc(u2, 'orders/o1')), false);
await t('anon NO lee', getDoc(doc(anon, 'orders/o1')), false);
await t('cliente NO crea pedido a nombre de otro', setDoc(doc(u1, 'orders/x1'), { ...baseOrder, uid: 'u2' }), false);
await t('cliente NO crea pedido ya pagado', setDoc(doc(u1, 'orders/x2'), { ...baseOrder, paymentStatus: 'pagado' }), false);
await t('cliente NO crea con status pagado', setDoc(doc(u1, 'orders/x3'), { ...baseOrder, status: 'pagado' }), false);
await t('cliente NO crea con campo paypal', setDoc(doc(u1, 'orders/x4'), { ...baseOrder, paypal: { x: 1 } }), false);
await t('cliente NO crea con paymentAmount', setDoc(doc(u1, 'orders/x5'), { ...baseOrder, paymentAmount: 5000 }), false);
await t('cliente NO agrega item a pedido pagado', setDoc(doc(u1, 'orders/paid/items/item_9'), { productId: 'p' }), false);
await t('cliente NO agrega item a pedido ajeno', setDoc(doc(u2, 'orders/o1/items/item_9'), { productId: 'p' }), false);
await t('cliente NO modifica item', updateDoc(doc(u1, 'orders/o1/items/item_0'), { quantity: 0 }), false);
await t('cliente NO marca pagado (paymentStatus)', updateDoc(doc(u1, 'orders/o1'), { paymentStatus: 'pagado' }), false);
await t('cliente NO cambia status', updateDoc(doc(u1, 'orders/o1'), { status: 'pagado' }), false);
await t('cliente NO cambia total', updateDoc(doc(u1, 'orders/o1'), { total: 1 }), false);
await t('cliente NO escribe paypal', updateDoc(doc(u1, 'orders/o1'), { paypal: { captureId: 'x' } }), false);
await t('cliente NO escribe paymentAmount', updateDoc(doc(u1, 'orders/o1'), { paymentAmount: 1000 }), false);
await t('cliente NO edita pedido pagado', updateDoc(doc(u1, 'orders/paid'), { paymentProofUrl: 'x' }), false);
await t('cliente NO borra', deleteDoc(doc(u1, 'orders/o1')), false);
await t('otro cliente NO actualiza', updateDoc(doc(u2, 'orders/o1'), { paymentProofUrl: 'x' }), false);
await t('cliente SÍ sube comprobante', updateDoc(doc(u1, 'orders/o1'), { paymentProofUrl: 'https://x', paymentPhone: '8888', paymentStatus: 'verificando', updatedAt: 'now' }), true);
await t('admin actualiza estado/pago', updateDoc(doc(adm, 'orders/o1'), { paymentStatus: 'pagado', status: 'por_preparar', total: 2 }), true);
await t('admin crea pedido', setDoc(doc(adm, 'orders/a1'), { uid: 'u1', total: 1 }), true);
await t('admin crea item', setDoc(doc(adm, 'orders/o1/items/item_5'), { a: 1 }), true);
await t('admin borra pedido', deleteDoc(doc(adm, 'orders/a1')), true);
await t('admin lee todo', getDoc(doc(adm, 'orders/paid/items/item_0')), true);
await t('admin lee crm', getDoc(doc(adm, 'crm_contacts/u1')), true);
await t('cliente NO lee crm ajeno', getDoc(doc(u1, 'crm_contacts/u2')), false);
await t('cliente escribe su crm (checkout)', setDoc(doc(u1, 'crm_contacts/u1'), { uid: 'u1' }, { merge: true }), true);
await t('config lectura pública', getDoc(doc(anon, 'config/shipping')), true);
await t('cliente NO escribe config', setDoc(doc(u1, 'config/exchangeRate'), { compra: 1 }), false);
console.log('OK:', ok.length); console.log('FALLARON:', bad);
await env.cleanup();
process.exit(bad.length ? 1 : 0);
