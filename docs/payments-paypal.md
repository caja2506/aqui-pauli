# PayPal Checkout (sandbox → live)

## Flujo
1. Checkout (`src/pages/store/CheckoutPage.jsx`) lista los métodos desde `src/services/payments/registry.js`.
   - `manual` (SINPE, transferencia): flujo de siempre (botón "Confirmar Pedido", comprobante por WhatsApp).
   - `online` (PayPal; Tilopay después): el método trae su `Panel` y su `getAvailability()`.
2. PayPal: `PaypalPanel` pide `paypalGetQuote` (total USD + tipo de cambio, calculado en el servidor) y muestra los botones del JS SDK (USD).
3. Al pulsar el botón: se crea el pedido en Firestore (`orders`, `paymentMethod: "paypal"`, `pendiente_pago`) → `paypalCreateOrder` recalcula precios/envío desde Firestore, convierte a USD y crea la orden PayPal.
4. Tras aprobar el comprador: `paypalCaptureOrder` verifica la orden contra lo guardado, captura y marca `paymentStatus/status = "pagado"` con ids de PayPal en `orders/{id}.paypal`.
   Eso dispara `onOrderStatusChange` (inventario, Telegram, CRM) igual que los otros métodos.

## Tipo de cambio
`functions/lib/fx.js`: API pública de Hacienda (`api.hacienda.go.cr/indicadores/tc/dolar`, tipo de cambio de referencia BCCR), valor de **compra**, caché 6 h en `config/exchangeRate`.
Override en `config/payments`: `{ fx: { fixedRate, bufferPct, maxAgeHours, staleMaxHours } }`; `{ paypal: { enabled: false } }` apaga PayPal.

## Config
- `functions/.env`: `PAYPAL_ENV` (`sandbox`|`live`), `PAYPAL_APP_CLIENT_ID` (público).
- Secret: `firebase functions:secrets:set PAYPAL_SECRET`.
- En sandbox, la opción solo aparece al entrar a `/checkout?paypal_sandbox=1` (se recuerda en la sesión).

## Pasar a Live
1. App Live en developer.paypal.com → copiar Client ID y Secret.
2. `functions/.env`: `PAYPAL_ENV=live`, `PAYPAL_APP_CLIENT_ID=<live client id>`.
3. `firebase functions:secrets:set PAYPAL_SECRET` (secret live).
4. `firebase deploy --only functions:paypalGetConfig,functions:paypalGetQuote,functions:paypalCreateOrder,functions:paypalCaptureOrder`.
5. Probar con una compra real pequeña (se puede reembolsar desde PayPal).

## Pruebas
`cd functions && npm test` (unit tests de conversión, precios, FX y verificación de órdenes).
