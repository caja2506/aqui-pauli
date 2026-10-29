# PayPal Checkout (sandbox → live)

## Flujo y apartado del 50%

1. Checkout lista los métodos desde `src/services/payments/registry.js`. PayPal sigue siendo la opción recomendada; SINPE y transferencia mantienen sus instrucciones.
2. `PaypalPanel` pide `paypalGetQuote`. El servidor consulta los precios y `supplyType` del catálogo y calcula el mismo apartado que `createOrderWithReservation`:
   - Productos en stock: 100%.
   - Productos `bajo_pedido`: 50% de su subtotal, con el redondeo de `lib/backorderDeposit.js`.
   - Envío: completo; la política vigente lo incluye en el precio (₡0 adicional).
3. La cotización distingue el total del pedido (`crcTotal`), lo que se paga ahora (`crcPayNow`), el saldo (`crcBalanceDue`), el subtotal Bajo pedido y su apartado. **`usdTotal` es la conversión de `crcPayNow`, no de `crcTotal`.**
4. El panel muestra «Pagás ahora ₡X (apartado 50%)», el equivalente USD y el saldo pendiente. Al crear la orden PayPal, envía la cotización que vio el comprador (`expectedQuote`). El servidor recalcula y rechaza una cotización desactualizada antes de contactar a PayPal; se debe mostrar y aceptar la cotización actualizada.
5. `paypalCreateOrder` fija un intento con `schemaVersion: 2`, importes y líneas canónicas inmutables. Reintentos concurrentes o de red reutilizan el identificador de idempotencia y la misma orden PayPal.
6. `paypalCaptureOrder` comprueba propietario, método, intento, moneda e importe de la orden **y de la captura**. Una captura `PENDING` permanece en revisión y todavía no acredita el apartado.
7. Con captura completada y saldo pendiente, el pedido guarda `paymentStatus: "parcial"`, `status: "pendiente_pago"`, `paymentAmount: crcPayNow`, `remainingTotal: crcBalanceDue`, `depositStatus: "pagado"` y `remainingStatus: "pendiente"`; marca el apartado como pagado en el resumen y las líneas. No dispara el flujo de pedido totalmente pagado ni vuelve a cobrar el apartado al reintentar.
8. Si no queda saldo (solo stock), mantiene `paymentStatus/status: "pagado"` y el flujo normal de inventario, avisos y CRM. La captura del apartado no implementa un segundo cobro automático del saldo.

Ejemplos con envío incluido:

| Carrito | Total | A pagar ahora | Saldo |
| --- | ---: | ---: | ---: |
| Rasasi Bajo pedido | ₡32.000 | ₡16.000 | ₡16.000 |
| Colonia en stock ₡47.000 + Rasasi Bajo pedido ₡32.000 | ₡79.000 | ₡63.000 | ₡16.000 |
| Solo colonia en stock | ₡47.000 | ₡47.000 | ₡0 |

Los intentos PayPal anteriores a esta versión, que cotizaban el total completo, no se capturan ni se sustituyen automáticamente. El servidor pide volver al checkout y crear un pedido nuevo para aprobar el importe correcto. Los pagos ya acreditados conservan su evidencia; no se modifica ni reembolsa un pago real automáticamente.

Las rutas de comprobante/aprobación manual no acreditan ni sobrescriben pedidos PayPal. La limpieza de reservas legacy excluye los pedidos e intentos PayPal, incluidos apartados con saldo pendiente.

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
5. Verificar los despliegues, `deployment.json` y los importes visibles sin aprobar un pago real. Las pruebas automatizadas utilizan dobles de transporte; una transacción real requiere autorización aparte.

## Pruebas
- `cd functions && npm test`: conversión, precios, FX, verificación de órdenes/capturas e integración de los handlers con Firestore en memoria.
- `node functions/test/order-payment-integration.test.js`: casos de apartado, carrito mixto y stock; manipulación de precios/abastecimiento; moneda e importe incorrectos; dueño ajeno; intentos legacy; cambios de método; captura pendiente; concurrencia e idempotencia; protección frente a aprobación manual y expiración.
- `npm run test:checkout`: renderizado del checkout y confirmación, sin crear pedidos ni llamar a PayPal.

Los importes de las pruebas se obtienen de productos de prueba y un tipo de cambio fijo. No se usan credenciales ni se ejecutan pagos reales.

