# Tilopay (tarjeta, cobro en colones) — apagado por defecto

Estado: **código listo, sin desplegar y sin activar**. Faltan la afiliación de Carlos en Tilopay, las credenciales y las pruebas.

## Flujo (Hosted Payment Page)
1. Checkout muestra "Tarjeta (Tilopay)" solo si `tilopayGetConfig` devuelve `enabled: true`
   (`src/services/payments/tilopayProvider.js`). Si las funciones no están desplegadas, la opción no aparece.
2. Botón "Pagar con tarjeta" (`TilopayPanel`): valida el formulario → crea el pedido pendiente (`orders`, `paymentMethod: "tilopay"`) →
   `tilopayCreatePayment({orderId})`.
3. `tilopayCreatePayment` (servidor):
   - Recalcula el total en **colones** con `functions/lib/pricing.js` (ignora cualquier precio del cliente; si difiere, corrige el pedido y guarda `priceCorrectedByServer`).
   - `POST /api/v1/login` → token (cache en memoria) → `POST /api/v1/processPayment` con `currency: "CRC"`, `amount` con 2 decimales,
     `orderNumber = <orderNumber>-T<intento>` (único por intento), `redirect = <TILOPAY_RETURN_BASE>/tilopay/retorno/<orderId>`.
   - Guarda `orders/{id}.tilopay = { mode, attempts, orderNumber, orderNumbers[], crcTotal, currency }` y devuelve la `url`.
4. El navegador va a la página de pago de Tilopay y vuelve a `/tilopay/retorno/:orderId` (`TilopayReturnPage`).
5. `tilopayConfirm` (servidor) **no usa lo que vuelve en la URL**: llama `POST /api/v1/consult` por cada `orderNumber` del pedido y exige:
   transacción tipo Payment, `code == "1"`, `currency == "CRC"`, `amount == total del servidor`, y entorno coherente con el modo
   (en `live` se rechaza `environment` "Test"). Si todo cuadra, marca `paymentStatus/status = "pagado"` en una transacción (idempotente), lo que
   dispara `onOrderStatusChange` (inventario, correo de pago, CRM) igual que PayPal. Si algo no cuadra: `revision_manual`.
   Resultados: `paid | already_paid | review | declined | not_found`.

## Funciones (us-central1, `functions/tilopay.js`)
| Función | Qué hace |
|---|---|
| `tilopayGetConfig` | `{enabled, mode}` desde Firestore (sin secretos) |
| `tilopayCreatePayment` | autenticado, dueño del pedido; devuelve URL de pago |
| `tilopayConfirm` | autenticado, dueño del pedido; confirma con `consult` |

## Configuración
- **Secrets de Firebase** (aún NO creados): `TILOPAY_API_USER`, `TILOPAY_API_PASSWORD`, `TILOPAY_KEY`
  (del Panel de Tilopay → "Integración con plataformas"). Crearlos con `firebase functions:secrets:set <NOMBRE>` **antes** de desplegar
  `tilopayCreatePayment` y `tilopayConfirm`. Nunca pegarlos en chat ni en el repo.
- Param opcional `TILOPAY_RETURN_BASE` (por defecto `https://aquipauli.com`). No se toma del cliente.
- Firestore `config/payments`: `{ tilopay: { enabled: false, mode: "test" } }`.
  - `enabled` debe ser exactamente `true` para mostrarse.
  - `mode: "test"` → la opción solo aparece en `/checkout?tilopay_test=1` (como el sandbox de PayPal).
  - `mode: "live"` (valor por defecto si falta) → aparece para todos y se rechazan transacciones de entorno "Test".

## Puesta en marcha (cuando Tilopay apruebe a Carlos)
1. Registro de developer en https://tilopay.com/developers/registro (credenciales de pruebas) o usar el modo de pruebas de la cuenta aprobada.
2. Crear los 3 secrets.
3. `firebase deploy --only functions:tilopayGetConfig,functions:tilopayCreatePayment,functions:tilopayConfirm` (CI solo despliega Hosting).
4. En Firestore: `config/payments.tilopay = { enabled: true, mode: "test" }`; probar en `/checkout?tilopay_test=1` con las tarjetas de
   https://tilopay.com/developers/tarjetas-de-prueba. Verificar un pago aprobado, uno rechazado y uno abandonado.
5. Cambiar el modo de la cuenta a producción en el panel de Tilopay, poner `mode: "live"`, hacer una compra real pequeña y reembolsarla desde el panel.

## Pendientes / por verificar con Tilopay
- Especificación del webhook de `processPayment` y algoritmo de `OrderHash` (pedir a soporte@tilopay.com). Hoy se confirma solo con `consult`.
- Si `orderNumber` acepta guiones y el formato `AP-…-T1` (se asume que sí; ver en modo de pruebas).
- Valor exacto de `environment` en producción en `consult` (en docs solo aparece "Test"); el código solo depende de reconocer "test".
- Códigos de estado de `billToState` (se envía `CR-A`, `CR-SJ`, etc.).
- Plazo de liquidación y comisiones: 4,25 % + US$0,35 por transacción con tarjeta (https://tilopay.com/tarifas).

## Pruebas
`cd functions && npm test` (incluye `test/tilopay.test.js`: payload en CRC, `consult`, rechazo de monto/moneda/entorno distinto, pedido ajeno,
precio del cliente ignorado, pago de un intento anterior, idempotencia).
