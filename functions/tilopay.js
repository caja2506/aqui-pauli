"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret, defineString } = require("firebase-functions/params");
const { db } = require("./utils");
const { CRM_DEFAULT_FIELDS } = require("./crm");
const { createTilopayService } = require("./lib/tilopayService");
const { completeTilopayPayment, createTilopayReconciler } = require("./lib/tilopayReconciliation");

const API_USER = defineSecret("TILOPAY_API_USER");
const API_PASSWORD = defineSecret("TILOPAY_API_PASSWORD");
const KEY = defineSecret("TILOPAY_KEY");
const RETURN_BASE = defineString("TILOPAY_RETURN_BASE", { default: "https://aquipauli.com" });

const service = createTilopayService({ db, HttpsError,
  credentials: () => ({ apiUser: API_USER.value(), password: API_PASSWORD.value(), key: KEY.value() }),
  returnBase: () => RETURN_BASE.value(),
});

const options = { region: "us-central1", cors: true, invoker: "public", timeoutSeconds: 540,
  secrets: [API_USER, API_PASSWORD, KEY] };
const publicOptions = { region: "us-central1", cors: true, invoker: "public" };
const complete = (operation, handler) => async (request) => {
  const orderId = typeof request.data?.orderId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(request.data.orderId)
    ? request.data.orderId : null;
  try {
    const result = await completeTilopayPayment({ db, result: await handler(request), crmDefaults: CRM_DEFAULT_FIELDS });
    console.info(JSON.stringify({ event: operation, orderId, result: result.result || (result.url ? "form_ready" : "unknown"),
      hasForm: Boolean(result.url), formReason: result.formReason || null }));
    return result;
  } catch (error) {
    console.warn(JSON.stringify({ event: operation, orderId, result: "error",
      code: /^[a-z-]{1,40}$/.test(error?.code) ? error.code : "internal" }));
    throw error;
  }
};
const reconciler = createTilopayReconciler({ db, reconcile: service.reconcile, crmDefaults: CRM_DEFAULT_FIELDS });

exports.tilopayGetConfig = onCall(publicOptions, service.getConfig);
exports.tilopayGetQuote = onCall(publicOptions, service.getQuote);
exports.tilopayCreatePayment = onCall(options, complete("tilopay_create_payment", service.create));
exports.tilopayConfirm = onCall(options, complete("tilopay_confirm", service.confirm));
exports.tilopayReconcilePayments = onSchedule({ schedule: "every 5 minutes", region: "us-central1",
  timeZone: "America/Costa_Rica", timeoutSeconds: 540, maxInstances: 1,
  secrets: [API_USER, API_PASSWORD, KEY] }, async () => {
  const result = await reconciler.run();
  console.info("[tilopayReconcilePayments]", result);
  return result;
});
