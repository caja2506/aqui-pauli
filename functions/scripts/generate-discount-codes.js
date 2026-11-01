"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { generateBatch, makeCards, validateBatch } = require("../lib/cardBatches");
const { cardState } = require("../lib/promotions.mjs");

async function main() {
  const { values: v } = parseArgs({ options: { n: { type:"string" }, dias: { type:"string", default:"60" },
    lote: { type:"string" }, salida: { type:"string", default:"/workspace/tarjetas" },
    "dry-run": { type:"boolean" }, commit: { type:"boolean" }, reporte: { type:"boolean" } } });
  if (v.commit && (v["dry-run"] || v.reporte)) throw new Error("Elegí una sola modalidad.");
  const args = { n: Number(v.n || (v.reporte ? 1 : 0)), dias: Number(v.dias), lote:v.lote };
  validateBatch(args);
  let db;
  if (v.commit || v.reporte) {
    const { initializeApp, applicationDefault } = require("firebase-admin/app");
    const { getFirestore } = require("firebase-admin/firestore");
    db = getFirestore(initializeApp({ credential:applicationDefault(),
      projectId:process.env.FIRESTORE_EMULATOR_HOST ? "demo-aqui-pauli-giveaway" : "aqui-pauli" }));
  }
  const byLot = async () => (await db.collection("discountCodes").where("batchId","==",args.lote).get()).docs.map(d=>d.data());
  if (v.reporte) {
    const rows = await byLot();
    const counts = { Usados:0, Vigentes:0, Vencidos:0 };
    for (const row of rows) { const status=cardState(row); counts[status === "Usados" || status === "Vencidos" ? status : "Vigentes"]++; }
    console.table(counts); return;
  }
  const { cardPdf } = await import("../../src/utils/cardPdf.mjs");
  const rows = v.commit ? await generateBatch(db,args) : makeCards(args);
  const dir = path.join(v.salida, ...(v.commit ? [] : ["simulacion"]), args.lote);
  await fs.mkdir(dir,{recursive:true,mode:0o700});
  const csv = ["codigo,vence,lote,estado", ...rows.map(c=>[c.code,c.expiresAt,c.batchId,cardState(c)].join(","))].join("\n")+"\n";
  await fs.writeFile(path.join(dir,"codigos_"+args.lote+".csv"),csv,{mode:0o600});
  await fs.writeFile(path.join(dir,"tarjetitas_"+args.lote+".pdf"),await cardPdf(rows),{mode:0o600});
  console.log(v.commit ? "Lote guardado." : "Simulación. Estos códigos no están activos.");
  if (!v.commit) console.log(csv);
  console.log(dir);
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
