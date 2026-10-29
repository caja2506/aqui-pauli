// Entrada compatible con el script anterior. La suite canónica vive en
// functions/test/firestore-payments.emulator.test.js y requiere un emulador local.
// Uso desde la raíz: firebase emulators:exec --only firestore
//   --project demo-aqui-pauli-audit --config firebase.tilopay-emulator.json
//   "node scripts/firestore-rules.test.mjs"
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('./test-tilopay.cjs', import.meta.url));
const result = spawnSync(process.execPath, [runner, '--rules'], {
  stdio: 'inherit',
  env: process.env,
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
