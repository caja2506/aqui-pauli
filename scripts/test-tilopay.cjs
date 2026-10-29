"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--rules") || args.length > 1) {
  console.error("Uso: node scripts/test-tilopay.cjs [--rules]");
  process.exit(2);
}
const rules = args.includes("--rules");
if (rules && !/^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST || "")) {
  console.error("Las reglas requieren un Firestore Emulator localhost. Usá firebase emulators:exec con el proyecto demo.");
  process.exit(2);
}
const files = rules ? ["firestore-payments.emulator.test.js"] : [
  "paymentMoney.test.js", "tilopayApi.test.js", "tilopayUrl.test.js",
  "inventoryStock.test.js", "fix-reserved-stock.test.js", "pricing-security.test.js",
  "order-payment-integration.test.js", "paid-review-email.test.js", "tilopay.test.js",
];
for (const file of files) {
  const result = spawnSync(process.execPath, [path.join(root, "functions", "test", file)], {
    cwd: root, stdio: "inherit", env: process.env,
  });
  if (result.error || result.status !== 0) {
    if (result.error) console.error(result.error.message);
    process.exit(result.status || 1);
  }
}
