import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Mantiene los endpoints que el proyecto ya publica. Una entrega exclusiva del
// sorteo solo despliega su endpoint y reglas, sin publicar funciones de pagos.
const existingFunctions = [
  'tilopayGetConfig', 'tilopayCreatePayment', 'tilopayConfirm',
  'createOrderWithReservation', 'deleteOrder', 'submitPaymentProof', 'approvePaymentManually',
  'paypalCreateOrder', 'paypalCaptureOrder', 'paypalGetQuote', 'cleanExpiredReservations',
];
const giveawayFiles = new Set([
  'functions/giveaway.js', 'functions/lib/giveawayConfig.json',
  'functions/lib/giveawayCatalog.mjs',
  'functions/lib/catalogPrice.mjs',
  'functions/lib/giveawayPhone.mjs',
  'functions/test/giveaway.test.js', 'functions/test/firestore-giveaway.emulator.test.js',
]);
// orders.js publica estos callables. El trigger de notificaciones conserva su
// exclusión existente hasta configurar Gmail; no requiere desplegar pasarelas.
const orderFiles = new Set([
  'functions/orders.js', 'functions/lib/customerNotes.mjs',
  'functions/test/order-payment-integration.test.js',
  'functions/test/firestore-payments.emulator.test.js',
]);

function withoutGiveawayExport(source) {
  return source.replace(/^const giveaway = require\("\.\/giveaway"\);\r?\n/gm, '')
    .replace(/^  \.\.\.giveaway,\r?\n/gm, '');
}

export function firebaseDeployTargets(changedPaths, indexBefore = '', indexAfter = '') {
  const hasGiveawayChanges = changedPaths.some((path) => giveawayFiles.has(path));
  const hasOrderChanges = changedPaths.some((path) => orderFiles.has(path));
  const otherFunctionsChanged = changedPaths.some((path) => path.startsWith('functions/')
    && path !== 'functions/index.js' && !giveawayFiles.has(path) && !orderFiles.has(path));
  const indexChanged = changedPaths.includes('functions/index.js')
    && (!indexBefore || !indexAfter || withoutGiveawayExport(indexBefore) !== withoutGiveawayExport(indexAfter));
  const names = (hasGiveawayChanges || hasOrderChanges) && !otherFunctionsChanged && !indexChanged
    ? [...(hasOrderChanges ? ['createOrderWithReservation', 'deleteOrder'] : []),
      ...(hasGiveawayChanges ? ['enterGiveaway'] : [])]
    : [...existingFunctions, 'enterGiveaway'];
  return ['firestore:rules', ...names.map((name) => `functions:default:${name}`)].join(',');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let targets;
  try {
    const before = process.env.DEPLOY_BEFORE;
    const head = process.env.DEPLOY_HEAD;
    if (!/^[a-f0-9]{40}$/.test(before || '') || !/^[a-f0-9]{40}$/.test(head || '')) {
      throw new Error('Missing revision');
    }
    const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const paths = git(['diff', '--name-only', before, head]).trim().split('\n');
    const changedIndex = paths.includes('functions/index.js');
    targets = firebaseDeployTargets(paths,
      changedIndex ? git(['show', `${before}:functions/index.js`]) : '',
      changedIndex ? git(['show', `${head}:functions/index.js`]) : '');
  } catch {
    // Un historial parcial nunca omite una actualización de funciones existente.
    targets = firebaseDeployTargets([]);
  }
  process.stdout.write(`targets=${targets}\n`);
}
