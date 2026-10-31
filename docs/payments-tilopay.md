# Tilopay: implementación revisada de pagos en CRC

Preparación de producción sobre `caja2506/aqui-pauli`, commit `d5c08ac043ef2dd78788dc813639ba140c72325a`. Conserva las protecciones del PR #2 y añade apartado del 50%, cotización del servidor, procesamiento de inventario/CRM y conciliación programada. Esta actualización de código no cambia automáticamente `config/payments` ni el ambiente de la cuenta Tilopay, y no ejecuta pagos reales.

**No implementa webhook/OrderHash ni captura separada.** Un pago autorizado sin captura permanece en revisión; no habilita entrega. La conciliación programada consulta pagos existentes y recupera el cierre de la pestaña del comprador; nunca crea o captura otro cobro.

## 1. Configuración por ambiente

| Ubicación | Dato | Regla |
|---|---|---|
| Firebase Secret Manager | `TILOPAY_API_USER` | Usuario de la integración del comercio. |
| Firebase Secret Manager | `TILOPAY_API_PASSWORD` | Contraseña de la integración. |
| Firebase Secret Manager | `TILOPAY_KEY` | Key de la integración. No se guarda en Firestore ni en React. |
| Parámetro de Functions | `TILOPAY_RETURN_BASE` | Origen HTTPS y eventual ruta base del sitio. Valor existente por defecto: `https://aquipauli.com`. |
| `config/payments.tilopay` | `enabled` | Booleano; solo `true` habilita el inicio de pagos. |
| `config/payments.tilopay` | `mode` | Cadena explícita `test` o `live`. Configuración ausente/inválida deshabilita el inicio. |
| `config/payments.tilopay` | `merchantId` | Obligatorio en live: cadena con el ID real del comercio. En test es opcional y no se compara con `consult`. No usar un ID de ejemplo para live. |
| `config/payments.tilopay` | `orderPrefix` | Obligatorio y no vacío en live: prefijo real sin el guion separador final, por ejemplo el `PFC…` confirmado para la integración. Opcional en test. |
| `users_roles/{uid}` | `role` | `admin` o `tester` para iniciar/consultar intentos de prueba. El parámetro de URL `tilopay_test=1` no concede permisos. |

La configuración mínima de prueba es `{ "enabled": true, "mode": "test" }`. No hace falta inventar `merchantId` ni `orderPrefix` para usarla. Solo los usuarios `admin` o `tester` pueden iniciar o consultar estos intentos; el pago se registra como `test_paid` sin efectos comerciales. En live, ambos identificadores son obligatorios: una configuración incompleta deshabilita nuevos inicios.

El modo de la aplicación no cambia el ambiente de Tilopay. Hay que verificar que la integración del proveedor esté en el ambiente correspondiente. El servidor contrasta el ambiente observado con el almacenado al crear el intento.

Se conservan las funciones existentes y se añaden una cotización sin secretos y un trabajo programado privado. La cotización tiene invocador público, pero exige una sesión Firebase (también admite el usuario anónimo del checkout); no requiere rol admin/tester.

| Función | Entrada | Salida relevante |
|---|---|---|
| `tilopayGetConfig` | Ninguna | `{ enabled, mode }`, sin secretos. |
| `tilopayGetQuote` | `{ items: [{ productId, variantId, quantity }], canton, shippingType }`, sesión Firebase | Cotización CRC calculada con catálogo: total, pago inicial, apartado y saldo. Solo lee Firestore, sin credenciales ni peticiones a Tilopay. |
| `tilopayCreatePayment` | `{ orderId, expectedQuote? }`, sesión Firebase | URL del mismo intento o estado del pedido, con su cotización guardada. Puede devolver otro `orderId` propio si ya existe un checkout equivalente pendiente. |
| `tilopayConfirm` | `{ orderId }`, sesión Firebase | `paid`, `already_paid`, `test_paid`, `pending`, `review` o `declined`. En esta entrega `retry` siempre es `false`. |
| `tilopayReconcilePayments` | Cloud Scheduler, cada cinco minutos | Consulta intentos live de la cola privada y reintenta el procesamiento de inventario/CRM. No es un callable de clientes. |

`functions/index.js` exporta el módulo Tilopay mediante spread. El cliente `tilopayClient` incorpora `tilopayGetQuote`. No hay nuevas dependencias de producción.

## 2. Inicio del pago y monto inmutable

El cliente proporciona el identificador del pedido. El servidor verifica su dueño; si aparecen `uid` y `customerUid`, deben coincidir. Un pedido de otro método, cerrado, con PayPal adjunto o ya pagado no puede abrir un pago Tilopay nuevo.

Una transacción de Firestore lee el padre, la colección real de items y el catálogo. Valida entre 1 y 50 líneas, cantidades enteras de 1 a 99, identificadores y ausencia de variantes duplicadas. Precio, nombre, imagen y `supplyType` vienen del catálogo. Las operaciones de dinero usan centavos enteros, sin redondear importes inválidos. **Se conserva la política existente de envío incluido**; esta entrega no introduce un cobro de envío.

La transacción escribe siempre los items y el resumen canónicos, aunque el total enviado por el navegador coincida por casualidad. Guarda un snapshot con dueño, productos, cantidades, precios, moneda, total, dirección y contacto. El intento conserva su huella SHA-256, importe, ambiente, comercio, prefijo y huella de la key utilizada.

Los nuevos snapshots usan `version: 2`: `totalMinor` es el total completo y `amountMinor` el cobro inicial. `paymentPlan.version: 1` congela la política del 50% sobre líneas Bajo pedido, con redondeo a colones y reparto por línea concordante con `computeBackorder`. Las líneas en stock se pagan completas; el envío, cuando exista, también se paga completo. El saldo es únicamente la parte no pagada de las líneas Bajo pedido. Una política futura necesita otra versión: no reinterpreta intentos existentes. Los snapshots históricos `version: 1` conservan el cobro completo original, sin convertirlo retroactivamente en apartado.

La cotización pública y las respuestas de inicio/confirmación usan `currency`, `crcTotal`, `crcSubtotal`, `crcShipping`, `crcPayNow`, `crcBalanceDue`, `crcDepositTotal`, `crcBackorderSubtotal` y `hasBackorder`. `crcTotal` nunca significa el apartado. El cliente muestra «Calculando…» hasta obtener una cotización válida y la invalida si cambia carrito o envío. Envía `expectedQuote` para detectar cambios de precio antes de reservar o llamar al proveedor; el servidor vuelve a calcular dentro de la transacción. El argumento es opcional para compatibilidad con el frontend anterior, pero nunca se usa como autoridad financiera.

En live se reserva inventario con un marcador `inventoryReservation` creado por servidor. En test no se reserva inventario real. El snapshot y las reservas quedan protegidos de escrituras del navegador, incluso del administrador.

La referencia externa es `AP-<token aleatorio generado por servidor>-T1`. Se reserva antes de llamar a Tilopay. No se deriva de un `orderNumber` editable por cliente ni se sobrescribe con la referencia recibida. El número visible del pedido sigue siendo el del comercio.

## 3. Referencias, prefijo del comercio y registro de pagos

En **live**, para un intento enviado como `ORDEN-T1`, la coincidencia permitida es exactamente `ORDEN-T1` o exactamente `<orderPrefix>-ORDEN-T1`. Si el prefijo configurado es `PFC123`, se acepta `PFC123-ORDEN-T1`; no se acepta `PFC999-ORDEN-T1`, un sufijo parcial ni un prefijo deducido de la propia respuesta. El `merchantId` también debe coincidir y no puede faltar.

En **test**, se acepta la referencia exacta o un único prefijo alfanumérico de hasta 64 caracteres seguido por `-` y la referencia completa; también se acepta el prefijo explícito si está configurado. No se compara el comercio y `consult` no envía `merchantId`. El resto de las comprobaciones —referencia completa, monto, CRC, ID, respuesta y ambiente de prueba— se mantiene. Un intento conserva este contexto aunque después cambie la configuración del proyecto.

Se conserva `orderNumber` como identidad enviada y `returnedOrderNumber` como evidencia recibida. `consult` usa siempre la referencia enviada. Cambiar la configuración actual no altera el contexto histórico de un intento.

Colecciones protegidas, solo servidor:

| Colección | Propósito |
|---|---|
| `tilopayReferences` | Reserva única de referencia externa y asociación con pedido/intento/dueño. |
| `tilopayTx` | Asociación única de comercio + ambiente + ID de transacción. En test el comercio se sustituye por una huella estable de la key de integración, porque el ID del comercio no se valida. El ID del documento es un hash, sin eliminar caracteres ni crear colisiones por sanitización. |
| `tilopayCheckoutLocks` | Bloqueo de compras equivalentes del mismo dueño mientras un intento permanece sin resolver. |
| `tilopayReconciliation` | Trabajo pendiente por pedido live, fecha de siguiente consulta y lease de ejecución. No admite lecturas ni escrituras desde clientes, ni siquiera administradores. |

El bloqueo del checkout depende de dueño, variantes y cantidades. No cambia al modificar precio, dirección o modo test/live. No pretende impedir compras distintas legítimas. Un pago liquidado permite una compra posterior de los mismos productos; una incertidumbre mantiene el bloqueo.

## 4. Timeouts y reintentos

`processPayment` ocurre fuera de las transacciones de Firestore y se invoca una sola vez por reserva. Dos llamadas simultáneas al mismo pedido no crean dos solicitudes al proveedor. React añade una exclusión inmediata de clics, conserva el pedido en la sesión antes de llamar a la función y adopta el pedido original si el servidor lo indica.

Backend y React aceptan URLs HTTPS de cualquier subdominio válido de `.tilopay.com`, incluidas etiquetas anidadas. Se comprueba el hostname completo: `pago.tilopay.com` pasa; `tilopay.com.ejemplo.com`, `eviltilopay.com`, credenciales embebidas, etiquetas inválidas y puertos distintos de 443 no pasan. La página raíz `tilopay.com` no es un subdominio. Los dos componentes de React comparten el mismo helper y una prueba comprueba su concordancia con el servidor.

Timeout, HTTP 500, JSON ilegible o respuesta sin URL válida dejan el intento para conciliación. No equivalen a un fallo definitivo. Una consulta vacía puede significar que aún no se pagó una HPP existente; no invalida por sí sola la página externa.

Esta versión no abandona intentos por edad ni crea `T2` automáticamente. Puede reutilizar una URL abierta del mismo intento si el pedido y su snapshot siguen intactos, tras consultar su estado. Un rechazo, un intento sin URL recuperable o un resultado incierto pueden requerir resolución administrativa. No borrar `.tilopay`, registros, bloqueos ni reservas para forzar un nuevo pago.

La ausencia de caducidad automática también implica que una reserva de inventario abandonada puede permanecer retenida. Su liberación requiere resolver/cancelar el pedido desde el servidor; no se libera el bloqueo de pago por un plazo local. La aplicación administrativa actual no incorpora un flujo nuevo de cancelación Tilopay: las reglas bloquean cancelar/eliminar un pedido con intento iniciado desde el navegador.

## 5. Consulta y acreditación

Una respuesta aceptable exige un sobre `type=200`, lista `response`, ausencia de error y filas bien formadas. Un error que contiene «not found» no prueba ausencia de pago. Se validan identidad, ambiente, ID transaccional, moneda CRC, decimal exacto y monto del intento; en live también se exige el comercio configurado.

| Evidencia del proveedor | Efecto |
|---|---|
| `Payment`, código `1`, `Capture`, identidad y monto coherentes, live | Puede acreditar el pedido si snapshot, referencia, registro global y estado del negocio también son válidos. |
| La misma evidencia en test | `test_paid`; no prepara, descuenta inventario ni envía avisos de venta. |
| `Authorize` | `pending_capture`; no marca pagado. |
| Refund, modificación, tipo desconocido o filas contradictorias | Revisión; no infiere un saldo cobrado. |
| Fallo de red, respuesta incompleta o ambiente desconocido | Conciliación pendiente; no abre otro cobro. |
| Captura de un pedido cancelado o con contenido distinto | Registra evidencia para revisión; no reabre el pedido. |

Se vuelven a consultar todos los intentos históricos disponibles (hasta 100, con concurrencia limitada a 4), incluidos rechazos previos. No hay un recorte que deje invisibles los intentos posteriores al quinto ni un retorno temprano por `already_paid` que impida detectar un movimiento adicional.

La evidencia consultada se liga a una huella del contexto del intento. Si ese contexto cambia durante la consulta, no se acredita la respuesta anterior. Una autorización/rechazo tardío no reemplaza el ID ni la captura de un pago ya acreditado. Una transacción adicional conserva el pago original y activa revisión. Las contradicciones de integridad, duplicidad o legado no se borran automáticamente por una consulta posterior limpia.

## 6. Inventario, CRM y avisos

Tilopay aplica inventario y CRM directamente después de conciliar una captura, tanto en el callable como en el trabajo programado. No depende de que esté desplegado `onOrderStatusChange` ni de sus secretos Gmail. Si la ejecución se interrumpe después de acreditar el dinero, la cola vuelve a intentar los efectos pendientes.

El procesamiento lee el estado actual. Inventario, consumo de reserva, CRM, interacción determinista y marcador `fulfillment.state=applied` se escriben en una sola transacción. Una invocación duplicada o concurrente no repite esos efectos. Una cancelación concurrente impide preparar el pedido.

Una captura completa escribe inicialmente `paymentStatus: pagado` manteniendo `status: pendiente_pago`, y el procesamiento cambia directamente a `por_preparar`. No se publica el estado intermedio `status: pagado`, para evitar que un trigger antiguo vuelva a descontar inventario. Un apartado escribe `paymentStatus: parcial`, conserva `status: pendiente_pago`, deja `paymentAmount` igual a lo capturado y `remainingTotal` igual al saldo. Consume solo el inventario propio de sus líneas en stock y registra en CRM únicamente el importe recibido, sin sumar el saldo como dinero cobrado. Las reglas impiden despachar un apartado con saldo o acreditar ese saldo desde el navegador. Esta entrega no añade un segundo cobro automático del saldo.

Para Tilopay, los productos y datos de entrega se toman del snapshot live capturado. Se exige concordancia de intento, ID de transacción, importe y huella, sin alertas de revisión. `reservedStock` solo disminuye por una reserva identificada de ese pedido; no consume reservas de otros compradores.

El navegador del administrador no puede marcar pagado ni adelantar `pagado → por_preparar`. Solo puede gestionar `por_preparar → enviado → entregado` después del fulfillment verificado y mientras no haya alertas. Las notas y el tracking sin cambio de estado conservan su permiso.

El código de avisos existente pertenece al trigger, cuyo despliegue continúa separado hasta configurar Gmail. Los callables y el conciliador nuevos no envían correo ni Telegram. Por ello esta actualización no promete notificaciones de venta o revisión; la evidencia y el estado sí quedan visibles en el pedido. Si se despliega posteriormente el trigger, habrá que revisar su suscripción al flujo directo y a los apartados antes de afirmar que están notificados.

Correo y Telegram tienen reclamaciones persistentes por canal. No existe una transacción atómica entre Firestore y esos servicios: ante un envío ambiguo se conserva `sending` o `needs_review` sin reenviarlo automáticamente. Puede hacer falta recuperar un aviso manualmente. No se afirma entrega externa «exactamente una vez».

Los callables de comprobantes/aprobación manual y PayPal rechazan pedidos Tilopay o cualquier pedido con datos `.tilopay`, y vuelven a verificar los datos en sus transacciones. La modificación de PayPal está acotada a este cruce de métodos; no constituye una auditoría integral de PayPal.

## 7. Inventario histórico, migración y despliegue coordinado

Los intentos anteriores al hardening del PR #2 pueden no tener `schemaVersion: 2` ni snapshot completo. Se pueden consultar para diagnóstico, pero quedan en revisión. No se fabrica un snapshot usando el carrito actual para acreditar una transacción histórica. Esto es distinto de un intento `schemaVersion: 2` con snapshot `version: 1`: ese formato íntegro sigue admitiendo su cobro completo original. Tampoco se abre otro pago para ocultar el legado.

El helper compartido normaliza `reservedStock` antes de cotizar, reservar, consumir o liberar: ausente, negativo, no numérico o no finito pasa a cero; una fracción positiva se redondea hacia arriba y el resultado se limita a `stock`. Los valores válidos se conservan. `stock` ausente sigue valiendo cero, pero un stock físico presente inválido se rechaza. Los avisos estructurados indican el contexto y el motivo sin copiar valores crudos ni datos personales. Una cotización solo lee; las operaciones de inventario usan el contador normalizado dentro de su transacción.

Se incluye una migración paginada e idempotente. Desde `functions/`, con credenciales de aplicación y el proyecto explícito:

```bash
node scripts/fix-reserved-stock.js --project aqui-pauli --dry-run
```

Omitir `--dry-run` también simula. Para aplicar las correcciones después de revisar el reporte:

```bash
node scripts/fix-reserved-stock.js --project aqui-pauli --apply
```

El script recorre únicamente `products/{product}/variants/{variant}`, incluidas variantes huérfanas. Relee cada documento en una transacción y modifica exclusivamente `reservedStock`, respetando reservas concurrentes. No cambia stock físico ni calcula reservas a partir de pedidos. Los documentos con stock físico inválido se informan y permanecen intactos; en ese caso el proceso termina con código 2. El reporte identifica documentos mediante hashes del path. La migración no se ejecutó en producción ni forma parte del workflow.

Las reservas históricas sin `inventoryReservation` requieren conciliación de inventario. No se supone que los subitems actuales describan una reserva anterior. Un pedido histórico que esté esperando su evento de pago sin snapshot nuevo se detendrá para revisión en el helper nuevo.

El [workflow de Functions y reglas](firebase-functions-deploy.md) selecciona endpoints mediante `scripts/firebase-deploy-targets.mjs` y siempre incluye reglas. Los cambios compartidos despliegan la lista general, ahora con `tilopayGetQuote` y `tilopayReconcilePayments`. **Excluye `onOrderStatusChange`**, conforme a la revisión, porque faltan sus secretos Gmail. El fulfillment Tilopay de esta entrega es independiente de ese trigger; sus avisos siguen fuera de este despliegue.

Secuencia de incorporación recomendada:

1. Deshabilitar nuevos inicios de pago durante el reemplazo. Conservar la posibilidad de conciliar los intentos abiertos y registrar cuáles quedan en revisión.
2. Copiar todos los archivos del paquete respetando sus rutas, incluidos los nuevos helpers. No reemplazar solo `functions/tilopay.js`.
3. Ejecutar las pruebas. Desplegar primero el backend, sus reglas, la cotización y el conciliador, conservando el modo de prueba. Confirmar la finalización del workflow de Functions antes de incorporar el nuevo frontend. La lista general actualiza también los consumidores del helper de fulfillment compartido. No despliega el trigger Gmail.
4. Incorporar el frontend. Verificar la configuración real de comercio/prefijo y secretos mediante las herramientas del proyecto, sin copiar valores de las pruebas.
5. Verificar cotizaciones de stock, Bajo pedido y carrito mixto sin crear pagos. Resolver los intentos heredados antes de reabrir compras equivalentes. El flag local `test` no asegura que la cuenta del proveedor siga en pruebas; verificar ese ambiente antes de cualquier simulación contra Tilopay.
6. Antes de habilitar live para clientes, completar el `merchantId` y prefijo reales de esa integración y confirmar el ambiente/captura del comercio. Un ensayo financiero real requiere coordinación expresa y no forma parte de esta actualización. La consulta de configuración al iniciar este trabajo encontró `enabled: true, mode: test`, sin `merchantId` ni `orderPrefix`; el código no inventa ni cambia esos valores.

### Conciliación sin retorno del navegador

Cada reserva live crea atómicamente `tilopayReconciliation/{orderId}` con `nextCheckAt` ISO. El cron consulta las entradas vencidas mediante un índice simple, con un máximo de 25 por ejecución, lease por documento y concurrencia acotada. No recorre el historial completo de pedidos. Un lease vencido vuelve a ser reclamable tras una interrupción. Los resultados pendientes se revisan a los cinco minutos; los errores usan backoff acotado; los pagos acreditados y las revisiones persistentes vuelven a consultarse diariamente para detectar movimientos tardíos. Los plazos son objetivos de programación, no una garantía de tiempo ante una caída del proveedor o una cola acumulada.

Las entradas no se borran automáticamente ni liberan reservas/bloqueos por antigüedad. La consulta diaria del historial tiene un costo operativo creciente; cualquier política futura de retención debe conservar la evidencia financiera y definir cómo detectar devoluciones posteriores. Este cambio no migra automáticamente intentos live anteriores a la cola: el dueño puede usar la confirmación existente, y un operador debe revisar/backfillear los casos heredados con herramientas del servidor si existen. Los intentos test nunca se encolan ni reciben efectos comerciales.

## 8. Webhook, OrderHash y captura separada

El retorno del navegador no aporta evidencia financiera confiable. `code`, `auth`, `order`, `returnData` u otros parámetros de URL no deciden el pago. Solicitar `hashVersion: V2` no equivale a verificar `OrderHash`.

No se añadió un webhook con un algoritmo supuesto. Hace falta el contrato de `processPayment` y la especificación de firma/OrderHash de Tilopay. Para los nuevos intentos live, el conciliador programado recupera pagos sin retorno del navegador y revisa movimientos posteriores mediante `consult`. Esto no equivale a haber implementado o validado un webhook.

La documentación de HPP define `capture: "1"` como autorización y captura. Por eso no corresponde añadir una segunda captura indiscriminada en producción. Si `consult` informa `Authorize`, la evidencia observada todavía no es una captura. Puede depender de la configuración o del procesamiento del comercio; la causa real requiere contrastar el ID con Tilopay. Esta entrega conserva el pago pendiente y no llama a `processModification`.

## 9. Pruebas reproducibles

Desde la raíz del repositorio:

```bash
node scripts/test-tilopay.cjs
```

El runner ejecuta suites de seguridad del servicio, parser, URLs, dinero, inventario, migración, pricing, integración de pedidos, apartados, conciliación y correo de revisión. No necesita credenciales ni hace llamadas reales a Tilopay, PayPal, SMTP o Telegram. El doble de Firestore implementa versiones, consultas, reintentos y commits atómicos para las pruebas de carreras; no sustituye al emulador.

Pruebas de reglas, con Firebase CLI y las dependencias de desarrollo `@firebase/rules-unit-testing` y `firebase` disponibles en la resolución de módulos:

```bash
firebase emulators:exec --only firestore --project demo-aqui-pauli-audit --config firebase.tilopay-emulator.json "node scripts/test-tilopay.cjs --rules"
```

El runner de reglas exige `FIRESTORE_EMULATOR_HOST` en localhost y el proyecto de prueba es `demo-aqui-pauli-audit`. La suite borra únicamente la base del emulador. No ejecutar contra un proyecto real. El CLI utilizado para la verificación requirió Java 21.

La suite completa de Functions, incluidas las pruebas originales de PayPal, Meta y correo, se ejecuta con el comando corregido:

```bash
npm ci --prefix functions
npm --prefix functions test
```

Los resultados de cada entrega deben consultarse en su PR y ejecución de CI; las cifras de la revisión inicial no representan el conjunto actual. Sin `FIRESTORE_EMULATOR_HOST`, la suite de reglas se omite explícitamente: un `npm test` sin emulador no demuestra haber validado reglas. El gate `npm run test:checkout` incluye las pruebas de cotización/retorno Tilopay y se ejecuta junto con `npm run build` antes de publicar Hosting. Las pruebas usan proveedores simulados y no acreditan haber validado la captura del comercio real.

## Fuentes de contrato

- [HPP / processPayment](https://tilopay.com/developers/api/hosted-payment-page/process-payment).
- [Consulta de transacciones](https://tilopay.com/developers/api/procesos-operativos/consult).
- [Reintentos y unicidad de orderNumber](https://tilopay.com/developers/reintentos-seguros).
- [Autenticación y expires_in](https://tilopay.com/developers/api/autenticacion).
- [Webhooks](https://tilopay.com/developers/api/webhooks).
- [Ambientes de prueba y producción](https://tilopay.com/developers/entornos).
- [Firestore: eventos, orden e idempotencia](https://firebase.google.com/docs/functions/firestore-events).
- [Firestore: reglas sobre campos y SDK de servidor](https://firebase.google.com/docs/firestore/security/rules-fields).
