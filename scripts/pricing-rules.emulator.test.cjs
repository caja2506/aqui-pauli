// Local emulator only. Included in CI before publishing Firestore Rules.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

test('ganancia estándar: privada, compartida por admins y validada al guardar', { skip: !process.env.FIRESTORE_EMULATOR_HOST }, async () => {
  assert.match(process.env.FIRESTORE_EMULATOR_HOST, /^(127\.0\.0\.1|localhost):\d+$/);
  const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
  const sdk = createRequire(require.resolve('@firebase/rules-unit-testing'))('firebase/firestore');
  sdk.setLogLevel('silent');
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  const env = await initializeTestEnvironment({ projectId: 'demo-aqui-pauli-giveaway', firestore: {
    host, port: Number(port), rules: fs.readFileSync(path.join(__dirname, '../firestore.rules'), 'utf8'),
  } });
  try {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async context => {
      for (const uid of ['admin-a', 'admin-b']) await sdk.setDoc(sdk.doc(context.firestore(), 'users_roles', uid), { role: 'admin' });
      await sdk.setDoc(sdk.doc(context.firestore(), 'users_roles', 'customer'), { role: 'cliente' });
    });
    const doc = db => sdk.doc(db, 'admin_pricing', 'settings');
    const admin = env.authenticatedContext('admin-a').firestore();
    const otherAdmin = env.authenticatedContext('admin-b').firestore();
    const payload = () => ({ version: 2, markupPercent: 20, roundingStep: 100, localShippingCRC: 2900, internationalShippingCRC: 7000, updatedAt: sdk.serverTimestamp() });
    assert.equal((await assertSucceeds(sdk.getDoc(doc(admin)))).exists(), false);
    await assertSucceeds(sdk.setDoc(doc(admin), payload()));
    assert.equal((await assertSucceeds(sdk.getDoc(doc(otherAdmin)))).data().markupPercent, 20);
    await assertSucceeds(sdk.setDoc(doc(otherAdmin), { ...payload(), markupPercent: 40 }));
    for (const db of [env.unauthenticatedContext().firestore(), env.authenticatedContext('customer').firestore(), env.authenticatedContext('unknown').firestore()]) {
      await assertFails(sdk.getDoc(doc(db)));
      await assertFails(sdk.setDoc(doc(db), payload()));
      await assertFails(sdk.getDocs(sdk.collection(db, 'admin_pricing')));
    }
    for (const bad of [{ version: 1 }, { localShippingCRC: -2900 }, { internationalShippingCRC: '7000' }, { markupPercent: -1 }, { markupPercent: 1001 }, { markupPercent: '30' }, { roundingStep: 0 }, { baseCost: 20000 }, { updatedAt: 'today' }]) {
      await assertFails(sdk.setDoc(doc(admin), { ...payload(), ...bad }));
    }
    await assertFails(sdk.setDoc(sdk.doc(admin, 'admin_pricing', 'other'), payload()));
    await assertFails(sdk.deleteDoc(doc(admin)));
    await assertSucceeds(sdk.setDoc(doc(admin), { ...payload(), markupPercent: 0, roundingStep: 1 }));
    await env.withSecurityRulesDisabled(async context => {
      await sdk.setDoc(sdk.doc(context.firestore(), 'admin_supplier_catalogs', 'ls'), { products: [{ description: 'Private fixture', cashCRC: 10000, cardCRC: 11000 }] });
    });
    await assertSucceeds(sdk.getDoc(sdk.doc(otherAdmin, 'admin_supplier_catalogs', 'ls')));
    await assertFails(sdk.setDoc(sdk.doc(admin, 'admin_supplier_catalogs', 'ls'), { products: [] }));
    for (const db of [env.unauthenticatedContext().firestore(), env.authenticatedContext('customer').firestore()]) {
      await assertFails(sdk.getDoc(sdk.doc(db, 'admin_supplier_catalogs', 'ls')));
      await assertFails(sdk.getDocs(sdk.collection(db, 'admin_supplier_catalogs')));
    }
    await assertFails(sdk.setDoc(sdk.doc(admin, 'admin_pricing_requests', 'admin-a'), { lastAtMs: 0 }));
  } finally { await env.cleanup(); }
});
