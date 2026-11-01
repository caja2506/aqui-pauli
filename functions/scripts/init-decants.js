"use strict";
const config = require("./decants.json");
async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(a => !["--commit", "--dry-run"].includes(a))) throw new Error("Usá --dry-run o --commit.");
  const data = { ...config, updatedAt: new Date().toISOString() };
  if (!args.includes("--commit")) { console.log(JSON.stringify(data, null, 2)); return; }
  const { initializeApp, applicationDefault } = require("firebase-admin/app");
  const { getFirestore } = require("firebase-admin/firestore");
  const projectId = process.env.FIRESTORE_EMULATOR_HOST ? "demo-aqui-pauli-giveaway" : "aqui-pauli";
  const db = getFirestore(initializeApp({ credential: applicationDefault(), projectId }));
  await db.doc("config/decants").create(data);
  console.log("config/decants creado.");
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
