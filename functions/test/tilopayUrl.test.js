"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isValidPaymentUrl } = require("../lib/tilopayApi");

test("backend y React aceptan subdominios HTTPS Tilopay y rechazan hosts engañosos", async () => {
  const { isValidTilopayPaymentUrl } = await import("../../src/services/payments/tilopayUrl.js");
  const accepted = [
    "https://secure.tilopay.com/htmls/order.html", "https://app.tilopay.com/payment",
    "https://payments.tilopay.com/pay", "https://cr.payments.tilopay.com/pay",
    "https://NEW-PAYMENT.TILOPAY.COM:443/pay?order=123#form",
  ];
  const rejected = [
    null, {}, "", "http://payments.tilopay.com", "//payments.tilopay.com/pay",
    "https://tilopay.com/pay", "https://nott ilopay.com", "https://nottilopay.com/pay",
    "https://payments.tilopay.com.evil.test/pay", "https://evil-tilopay.com/pay",
    "https://user:password@payments.tilopay.com/pay", "https://payments.tilopay.com@evil.test/pay",
    "https://payments.tilopay.com:8443/pay", "javascript:alert(1)",
    "https://payments..tilopay.com/pay", "https://.tilopay.com/pay",
    "https://-payments.tilopay.com/pay", "https://payments_.tilopay.com/pay",
    "https://payments.tilopay.com./pay",
  ];
  for (const validate of [isValidPaymentUrl, isValidTilopayPaymentUrl]) {
    for (const url of accepted) assert.equal(validate(url), true, String(url));
    for (const url of rejected) assert.equal(validate(url), false, String(url));
  }
});
