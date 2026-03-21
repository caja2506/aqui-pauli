// ==============================================
// AQUÍ PAULI — Cloud Functions Entry Point
// Re-exporta módulos por dominio
// ==============================================

const { initializeApp } = require("firebase-admin/app");
initializeApp();

// --- Módulos por dominio ---
const orders = require("./orders");
const payments = require("./payments");
const crm = require("./crm");
const messaging = require("./messaging");
const schedulers = require("./schedulers");

// Re-exportar todo
module.exports = {
  ...orders,
  ...payments,
  ...crm,
  ...messaging,
  ...schedulers,
};
