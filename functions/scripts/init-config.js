const { initializeApp, applicationDefault } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

// Use Firebase CLI credentials
process.env.GOOGLE_APPLICATION_CREDENTIALS = "";
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: "aqui-pauli" });
process.env.GCLOUD_PROJECT = "aqui-pauli";

initializeApp({ projectId: "aqui-pauli", credential: require("firebase-admin").credential.cert ? undefined : undefined });

// Try with ADC from gcloud or firebase login
const admin = require("firebase-admin");
if (!admin.apps.length) {
  admin.initializeApp({ projectId: "aqui-pauli" });
}
const db = admin.firestore();

const cfg = {
  reviewLink: "",
  cartAbandonmentHours: 24,
  reviewRequestDays: 3,
  backorderReminderDays: 1,
  automationToggles: {
    cartAbandoned: true,
    reviewRequest: true,
    backorderPayment: true,
    trackingUpdate: true,
  },
  whatsappDefaults: {
    businessName: "Aqui Pauli",
    greeting: "Hola! Soy Aqui Pauli",
  },
  messageTemplates: {
    cartAbandoned: "Hola {name}! Notamos que dejaste productos en tu carrito.",
    reviewRequest: "Gracias por tu compra, {name}! Podrias dejarnos tu resena?",
    backorderPayment: "Hola {name}! Tu pedido #{orderNumber} esta listo.",
    trackingUpdate: "{name}! Tu pedido #{orderNumber} ha sido actualizado a: {status}.",
  },
};

db.collection("config").doc("app").set(cfg, { merge: true })
  .then(function() {
    console.log("OK config/app creado");
    return db.collection("config").doc("app").get();
  })
  .then(function(s) {
    console.log(JSON.stringify(s.data(), null, 2));
    process.exit(0);
  })
  .catch(function(e) {
    console.error("Error:", e.message);
    process.exit(1);
  });
