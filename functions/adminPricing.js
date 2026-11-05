"use strict";
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { db } = require('./utils');
const { createPricingHandlers, PricingAdminError } = require('./lib/supplierPricing');
const handlers = createPricingHandlers({ db });
const options = { cors: true, invoker: 'public', maxInstances: 3, timeoutSeconds: 30 };
for (const [name, handler] of Object.entries(handlers)) {
  exports[name] = onCall(options, async req => {
    try { return await handler(req); }
    catch (error) {
      if (error instanceof PricingAdminError) throw new HttpsError(error.code, error.message);
      throw new HttpsError('unavailable', 'No pudimos completar la consulta. Conservamos tus datos; podés reintentar o ingresar el precio manualmente.');
    }
  });
}
