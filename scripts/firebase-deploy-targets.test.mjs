import test from 'node:test';
import assert from 'node:assert/strict';
import { firebaseDeployTargets } from './firebase-deploy-targets.mjs';

const before = 'const orders = require("./orders");\nmodule.exports = {\n  ...orders,\n};\n';
const after = 'const orders = require("./orders");\nconst giveaway = require("./giveaway");\nmodule.exports = {\n  ...orders,\n  ...giveaway,\n};\n';
const isolated = 'firestore:rules,functions:default:enterGiveaway';

test('sorteo aislado publica únicamente su función y reglas aunque incluya frontend y workflow', () => {
  assert.equal(firebaseDeployTargets(['functions/giveaway.js', 'functions/lib/giveawayConfig.json',
    'functions/index.js', 'functions/test/giveaway.test.js', 'functions/test/firestore-giveaway.emulator.test.js',
    'firestore.rules', 'src/App.jsx', '.github/workflows/firebase-functions-deploy.yml'], before, after), isolated);
});

test('correcciones del sorteo y sus reglas conservan el despliegue aislado', () => {
  assert.equal(firebaseDeployTargets(['functions/giveaway.js', 'firestore.rules']), isolated);
  assert.equal(firebaseDeployTargets(['functions/giveaway.js', 'functions/lib/giveawayCatalog.mjs',
    'functions/lib/giveawayConfig.json', 'functions/test/giveaway.test.js']), isolated);
  assert.equal(firebaseDeployTargets(['functions/lib/giveawayPhone.mjs']), isolated);
  assert.equal(firebaseDeployTargets(['functions/lib/catalogPrice.mjs',
    'functions/lib/giveawayCatalog.mjs', 'src/utils/productPrice.js']), isolated);
  assert.equal(firebaseDeployTargets(['functions/giveaway.js', 'functions/lib/giveawayPhone.mjs',
    'functions/test/giveaway.test.js', 'src/pages/store/GiveawayPage.jsx']), isolated);
});

test('cambios de funciones compartidas, dependencias o endpoints existentes conservan el deploy original', () => {
  for (const path of ['functions/utils.js', 'functions/paypal.js',
    'functions/package-lock.json', 'functions/lib/pricing.js']) {
    const result = firebaseDeployTargets(['functions/giveaway.js', path]);
    assert.ok(result.includes('functions:default:paypalCaptureOrder'), path);
    assert.ok(result.includes('functions:default:tilopayConfirm'), path);
    assert.ok(result.includes('functions:default:enterGiveaway'), path);
  }
});

test('notas y pedidos publican sus callables y reglas sin desplegar pasarelas', () => {
  const orders = 'firestore:rules,functions:default:createOrderWithReservation,functions:default:deleteOrder';
  for (const path of ['functions/orders.js', 'functions/lib/customerNotes.mjs',
    'functions/test/order-payment-integration.test.js', 'functions/test/firestore-payments.emulator.test.js']) {
    assert.equal(firebaseDeployTargets([path, 'firestore.rules', 'src/services/orderService.js']), orders);
  }
  assert.equal(firebaseDeployTargets(['functions/orders.js', 'functions/giveaway.js']), `${orders},functions:default:enterGiveaway`);
});

test('otros cambios del entry point o historial incompleto no se confunden con el sorteo', () => {
  for (const oldIndex of ['', before.replace('orders', 'payments')]) {
    assert.ok(firebaseDeployTargets(['functions/giveaway.js', 'functions/index.js'], oldIndex, after)
      .includes('functions:default:paypalCreateOrder'));
  }
  assert.ok(firebaseDeployTargets([]).includes('functions:default:createOrderWithReservation'));
  assert.ok(firebaseDeployTargets(['firestore.rules']).includes('functions:default:cleanExpiredReservations'));
});
