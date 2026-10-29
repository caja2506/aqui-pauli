// ==============================================
// AQUÍ PAULI — Cloud Functions Entry Point
// Re-exporta módulos por dominio
// ==============================================

const { initializeApp } = require("firebase-admin/app");
initializeApp();

// --- Módulos por dominio ---
const orders = require("./orders");
const payments = require("./payments");
const paypal = require("./paypal");
const tilopay = require("./tilopay");
const crm = require("./crm");
const schedulers = require("./schedulers");
const catalogBatch = require("./whatsapp/catalogBatchSync");

// Re-exportar todo
module.exports = {
  ...orders,
  ...payments,
  ...paypal,
  ...tilopay,
  ...crm,
  ...schedulers,
  ...catalogBatch,
};
