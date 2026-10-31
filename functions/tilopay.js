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
const complete = (handler) => async (request) => completeTilopayPayment({ db,
  result: await handler(request), crmDefaults: CRM_DEFAULT_FIELDS });
const reconciler = createTilopayReconciler({ db, reconcile: service.reconcile, crmDefaults: CRM_DEFAULT_FIELDS });

exports.tilopayGetConfig = onCall(publicOptions, service.getConfig);
exports.tilopayGetQuote = onCall(publicOptions, service.getQuote);
exports.tilopayCreatePayment = onCall(options, complete(service.create));
exports.tilopayConfirm = onCall(options, complete(service.confirm));
exports.tilopayReconcilePayments = onSchedule({ schedule: "every 5 minutes", region: "us-central1",
  timeZone: "America/Costa_Rica", timeoutSeconds: 540, maxInstances: 1,
  secrets: [API_USER, API_PASSWORD, KEY] }, async () => {
  try {
    await require("./lib/tilopayActivationCheck").inspectAndSave({ db, projectId: db.projectId,
      api: require("./lib/tilopayApi"),
      credentials: () => ({ apiUser: API_USER.value(), password: API_PASSWORD.value(), key: KEY.value() }) });
  } catch { console.warn("[tilopayActivationCheck] report unavailable"); }
  const result = await reconciler.run();
  console.info("[tilopayReconcilePayments]", result);
  return result;
});
