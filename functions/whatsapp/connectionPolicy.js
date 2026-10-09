"use strict";

// Store integration retirement is separate from the MotelOps report channel.
// Only an explicit backend opt-in can resume the existing store integration.
function storeWhatsAppEnabled(env = process.env) {
  return env?.STORE_WHATSAPP_ENABLED === "true";
}

function whatsappRetiredResult() {
  return { status: "retired", channel: "whatsapp",
    reason: "WhatsApp de la tienda está desactivado." };
}

function respondToRetiredWhatsAppWebhook(req, res) {
  if (storeWhatsAppEnabled()) return false;
  if (req.method === "POST") res.status(200).send("OK");
  else if (req.method === "GET") res.status(403).send("Forbidden");
  else res.status(405).send("Method not allowed");
  return true;
}

module.exports = {
  storeWhatsAppEnabled,
  whatsappRetiredResult,
  respondToRetiredWhatsAppWebhook,
};

