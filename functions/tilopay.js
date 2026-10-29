"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");
const { db } = require("./utils");
const { createTilopayService } = require("./lib/tilopayService");

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

exports.tilopayGetConfig = onCall({ region: "us-central1", cors: true, invoker: "public" }, service.getConfig);
exports.tilopayCreatePayment = onCall(options, service.create);
exports.tilopayConfirm = onCall(options, service.confirm);
