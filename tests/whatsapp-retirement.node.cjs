"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ROOT = path.resolve(__dirname, "..");

function harness(flag, allowIO = false) {
  const env = {};
  if (flag !== undefined) env.STORE_WHATSAPP_ENABLED = flag;
  const effects = { db: [], requests: [], secretReads: [], timers: 0, serviceCalls: [] };
  const cache = new Map();
  const contexts = new Map();
  const fail = (kind) => { throw new Error("Unexpected " + kind + " while retired"); };
  const fetch = async (url, options) => {
    effects.requests.push({ url, options });
    if (!allowIO) fail("network call");
    return { ok: true, status: 200, json: async () => ({
      messages: [{ id: "fixture-provider-id" }], ok: true,
    }) };
  };
  function collection(name) {
    effects.db.push({ op: "collection", name });
    if (!allowIO) fail("database operation");
    const query = {
      where() { return query; },
      limit() { return query; },
      get: async () => ({ empty: true, docs: [], size: 0 }),
      add: async (data) => {
        effects.db.push({ op: "add", name, data });
        return { id: "fixture-document-id" };
      },
      doc(id) {
        return {
          get: async () => ({ exists: false }),
          update: async (data) => { effects.db.push({ op: "update", name, id, data }); },
          set: async (data) => { effects.db.push({ op: "set", name, id, data }); },
          collection: (child) => collection(name + "/" + id + "/" + child),
        };
      },
    };
    return query;
  }
  const db = { collection };
  function service(name) {
    return async () => {
      effects.serviceCalls.push(name);
      fail("OCR/CRM/order/AI/storage service");
    };
  }
  const crm = new Proxy({}, { get: (_, name) => service("crm." + String(name)) });
  const stubs = {
    "firebase-functions/v2/https": {
      onCall: (_, handler) => handler,
      onRequest: (_, handler) => handler,
      HttpsError: class HttpsError extends Error {
        constructor(code, message) { super(message); this.code = code; }
      },
    },
    "firebase-functions/v2/scheduler": { onSchedule: (_, handler) => handler },
    "firebase-functions/params": {
      defineSecret: (name) => ({
        value() {
          effects.secretReads.push(name);
          if (!allowIO) fail("secret access");
          return name.endsWith("CHAT_ID") ? "123456789" : "fixture-secret";
        },
      }),
    },
    "firebase-admin/firestore": {
      getFirestore: () => db,
      FieldValue: { increment: (n) => n, serverTimestamp: () => "fixture-time" },
    },
    "firebase-admin/storage": { getStorage: service("storage") },
    "node-fetch": fetch,
  };
  const appStubPaths = new Map([
    ["functions/crm.js", crm],
    ["functions/conversation.js", {
      processInboundMessage: service("ai"),
      geminiApiKey: { value: service("gemini-secret") },
    }],
    ["functions/ocr/paymentReader.js", { extractPaymentData: service("ocr") }],
    ["functions/gmail/verifier.js", { verifyWithGmail: service("gmail") }],
    ["functions/whatsapp/audioTranscriber.js", { transcribeAudio: service("audio") }],
    ["functions/whatsapp/processWhatsAppOrder.js", { processWhatsAppOrder: service("order") }],
  ]);
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    if (appStubPaths.has(file)) return appStubPaths.get(file);
    const module = { exports: {} };
    cache.set(file, module.exports);
    const context = {
      module, exports: module.exports, process: { env }, fetch,
      console: { log() {}, error() {}, warn() {} },
      Buffer, Date, URL, URLSearchParams, setTimeout(callback) {
        effects.timers++;
        if (!allowIO) fail("typing delay");
        callback();
        return 0;
      },
      clearTimeout() {},
      require(specifier) {
        if (Object.hasOwn(stubs, specifier)) return stubs[specifier];
        if (!specifier.startsWith(".")) throw new Error("Unstubbed dependency: " + specifier);
        let target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
        if (!target.endsWith(".js")) target += ".js";
        return load(target);
      },
    };
    contexts.set(file, context);
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, file), "utf8"), context, { filename: file });
    cache.set(file, module.exports);
    return module.exports;
  }
  return { env, effects, load, contexts };
}

function untouched(effects) {
  assert.equal(effects.db.length, 0);
  assert.equal(effects.requests.length, 0);
  assert.equal(effects.secretReads.length, 0);
  assert.equal(effects.timers, 0);
  assert.equal(effects.serviceCalls.length, 0);
}

function response() {
  return {
    statusCode: null, text: null,
    status(code) { this.statusCode = code; return this; },
    send(text) { this.text = text; return this; },
    sendStatus(code) { this.statusCode = code; return this; },
  };
}

function dangerousRequest(method) {
  return { method,
    get body() { throw new Error("Webhook body must not be inspected while retired"); },
    get query() { throw new Error("Webhook verification must not read query while retired"); },
  };
}

test("store policy defaults to retired and requires exact backend string true", () => {
  for (const flag of [undefined, "", "false", "TRUE", " true ", "1", true]) {
    const h = harness(flag);
    const policy = h.load("functions/whatsapp/connectionPolicy.js");
    assert.equal(policy.storeWhatsAppEnabled(), false);
  }
  const h = harness("true");
  assert.equal(h.load("functions/whatsapp/connectionPolicy.js").storeWhatsAppEnabled(), true);
});

test("all exported bot senders stop before parsing inputs, delay, secrets and HTTP", async () => {
  const h = harness();
  const sender = h.load("functions/whatsapp/sender.js");
  const invocations = [
    ["sendWhatsAppMessage", [null, null]],
    ["sendWhatsAppMessageImmediate", [null, null]],
    ["sendInteractiveButtons", [null, null, null]],
    ["sendInteractiveList", [null, null, null, null]],
    ["sendQuickConfirmation", ["fixture-phone", "fixture-text"]],
    ["sendPaymentMethodButtons", ["fixture-phone", "fixture-text"]],
    ["sendOrderConfirmation", ["fixture-phone", "fixture-order", 10]],
    ["sendPaymentReceived", ["fixture-phone", "fixture-order"]],
    ["sendPaymentVerified", ["fixture-phone", "fixture-order"]],
    ["sendOrderStatusUpdate", ["fixture-phone", "fixture-order", "enviado"]],
  ];
  for (const [name, args] of invocations) {
    const result = await sender[name](...args);
    assert.equal(result.status, "retired", name);
  }
  untouched(h.effects);
});

test("core payload sender is protected even when a caller bypasses public entry guards", async () => {
  const h = harness();
  h.load("functions/whatsapp/sender.js");
  const result = await h.contexts.get("functions/whatsapp/sender.js")._sendPayload({
    get to() { throw new Error("Do not inspect payload while retired"); },
  });
  assert.equal(result.status, "retired");
  untouched(h.effects);
});

test("legacy callable rejects failed-precondition before request data and side effects", async () => {
  const h = harness();
  const messaging = h.load("functions/messaging.js");
  await assert.rejects(() => messaging.sendWhatsAppMessage({
    get data() { throw new Error("Do not read callable data while retired"); },
  }), (error) => error.code === "failed-precondition" &&
    error.message === "WhatsApp de la tienda está desactivado.");
  untouched(h.effects);
});

for (const file of ["functions/whatsapp/webhook.js", "functions/messaging.js"]) {
  test("retired webhook short-circuits payment/order/CRM/AI before body: " + file, async () => {
    const h = harness();
    const handler = h.load(file).whatsappWebhook;
    const res = response();
    await handler(dangerousRequest("POST"), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.text, "OK");
    untouched(h.effects);
  });
  test("retired webhook refuses verification without secret/query reads: " + file, async () => {
    const h = harness();
    const handler = h.load(file).whatsappWebhook;
    const res = response();
    await handler(dangerousRequest("GET"), res);
    assert.equal(res.statusCode, 403);
    untouched(h.effects);
    const other = response();
    await handler(dangerousRequest("PUT"), other);
    assert.equal(other.statusCode, 405);
    untouched(h.effects);
  });
}

test("webhook local text sender and scheduler internal sender cannot bypass retirement", async () => {
  const h = harness();
  h.load("functions/whatsapp/webhook.js");
  const webhookResult = await h.contexts.get("functions/whatsapp/webhook.js").sendWhatsAppMessage(null, null);
  assert.equal(webhookResult.status, "retired");
  h.load("functions/schedulers.js");
  const schedulerResult = await h.contexts.get("functions/schedulers.js").sendWhatsApp(
    null, null, { token: "fixture-token", phoneId: "fixture-phone" });
  assert.equal(schedulerResult.status, "retired");
  untouched(h.effects);
});

test("retired scheduler leaves pending history untouched and produces no fake sent result", async () => {
  const h = harness();
  const scheduler = h.load("functions/schedulers.js");
  const result = await scheduler.processScheduledAutomations();
  assert.equal(result.status, "retired");
  assert.notEqual(result.status, "sent");
  untouched(h.effects);
});

test("retired abandoned-cart producer never marks a cart notified without a message", async () => {
  const h = harness();
  const result = await h.load("functions/schedulers.js").processAbandonedCarts();
  assert.equal(result.status, "retired");
  untouched(h.effects);
});

test("creating WhatsApp automation while retired is a no-op with unchanged order caller contract", async () => {
  const h = harness();
  const utils = h.load("functions/utils.js");
  assert.equal(await utils.logAutomation({ type: "post_sale_tracking", channel: "whatsapp" }), null);
  assert.equal(await utils.logAutomation({ type: "post_sale_review" }), null);
  untouched(h.effects);
});

test("retiring WhatsApp still permits automation records for other channels", async () => {
  const h = harness(undefined, true);
  const result = await h.load("functions/utils.js").logAutomation({
    type: "fixture-telegram", channel: "telegram", metadata: { fixture: true },
  });
  assert.equal(result, "fixture-document-id");
  assert.equal(h.effects.db.find((effect) => effect.op === "add").data.channel, "telegram");
  assert.equal(h.effects.requests.length, 0);
  assert.equal(h.effects.secretReads.length, 0);
});

test("Telegram sending is independent from retired store WhatsApp", async () => {
  const h = harness(undefined, true);
  const result = await h.load("functions/messaging.js").sendTelegramNotification({
    data: { message: "Fixture Telegram notification" },
  });
  assert.equal(result.status, "sent");
  assert.equal(h.effects.requests.length, 1);
  assert.equal(new URL(h.effects.requests[0].url).origin, "https://api.telegram.org");
  assert.ok(h.effects.secretReads.every((name) => name.startsWith("TELEGRAM_")));
});

test("reservation cleanup remains active while WhatsApp is retired", async () => {
  const h = harness(undefined, true);
  await h.load("functions/schedulers.js").cleanExpiredReservations();
  assert.equal(h.effects.db[0].name, "orders");
  assert.equal(h.effects.requests.length, 0);
});

test("explicit opt-in preserves bot send path and does not cache the flag", async () => {
  const h = harness("true", true);
  const sender = h.load("functions/whatsapp/sender.js");
  const accepted = await sender.sendWhatsAppMessageImmediate("50688888888", "Fixture report");
  assert.equal(accepted.messages[0].id, "fixture-provider-id");
  assert.equal(h.effects.requests.length, 1);
  assert.equal(new URL(h.effects.requests[0].url).origin, "https://graph.facebook.com");
  h.env.STORE_WHATSAPP_ENABLED = "false";
  const retired = await sender.sendWhatsAppMessageImmediate(null, null);
  assert.equal(retired.status, "retired");
  assert.equal(h.effects.requests.length, 1);
});

test("explicit opt-in allows configured webhook challenge and automation creation", async () => {
  const h = harness("true", true);
  const handler = h.load("functions/whatsapp/webhook.js").whatsappWebhook;
  const res = response();
  await handler({ method: "GET", query: { "hub.mode": "subscribe",
    "hub.verify_token": "fixture-secret", "hub.challenge": "fixture-challenge" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.text, "fixture-challenge");
  const id = await h.load("functions/utils.js").logAutomation({ type: "fixture", channel: "whatsapp" });
  assert.equal(id, "fixture-document-id");
  assert.equal(h.effects.db.find((effect) => effect.op === "add").data.channel, "whatsapp");
});

