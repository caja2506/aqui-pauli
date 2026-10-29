# Tilopay: implementación revisada de pagos en CRC

Base de esta entrega: `caja2506/aqui-pauli`, commit `2e8de4ab00ee337bc693ac2f98a3d4175eda95ef`, con las correcciones del PR #2 y su revisión posterior. No se ejecutaron cobros, envíos, migraciones en producción, cambios de configuración ni despliegues durante esta revisión.

Esta versión corrige el flujo de inicio, consulta, autorización, inventario y retorno del navegador. **No implementa webhook/OrderHash ni captura separada**, conforme al alcance acordado. Un pago autorizado sin captura permanece en revisión; no habilita entrega.

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

Se mantienen los nombres de las tres funciones públicas y sus argumentos:

| Función | Entrada | Salida relevante |
|---|---|---|
| `tilopayGetConfig` | Ninguna | `{ enabled, mode }`, sin secretos. |
| `tilopayCreatePayment` | `{ orderId }`, sesión Firebase | URL del mismo intento o estado del pedido. Puede devolver otro `orderId` propio si ya existe un checkout equivalente pendiente. |
| `tilopayConfirm` | `{ orderId }`, sesión Firebase | `paid`, `already_paid`, `test_paid`, `pending`, `review` o `declined`. En esta entrega `retry` siempre es `false`. |

El `functions/index.js` y el cliente `tilopayClient` del commit base ya exportan/consumen estas funciones: no requieren reemplazo. No hay nuevas dependencias de producción. Los nuevos helpers usan módulos nativos de Node y dependencias Firebase ya existentes.

## 2. Inicio del pago y monto inmutable

El cliente proporciona el identificador del pedido. El servidor verifica su dueño; si aparecen `uid` y `customerUid`, deben coincidir. Un pedido de otro método, cerrado, con PayPal adjunto o ya pagado no puede abrir un pago Tilopay nuevo.

Una transacción de Firestore lee el padre, la colección real de items y el catálogo. Valida entre 1 y 50 líneas, cantidades enteras de 1 a 99, identificadores y ausencia de variantes duplicadas. Precio, nombre, imagen y `supplyType` vienen del catálogo. Las operaciones de dinero usan centavos enteros, sin redondear importes inválidos. **Se conserva la política existente de envío incluido**; esta entrega no introduce un cobro de envío.

La transacción escribe siempre los items y el resumen canónicos, aunque el total enviado por el navegador coincida por casualidad. Guarda un snapshot con dueño, productos, cantidades, precios, moneda, total, dirección y contacto. El intento conserva su huella SHA-256, importe, ambiente, comercio, prefijo y huella de la key utilizada.

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

El trigger mantiene `retry: true`, pero descarta eventos con más de una hora desde su `CloudEvent.time` original, o con fecha inválida, antes de producir efectos. Actualizar `updatedAt` del pedido no reinicia ese plazo. Tras agotarlo, un caso pendiente requiere revisión operativa: no se promete reintento ilimitado.

El trigger de pago lee el estado actual, no asume que el evento recibido es el último. Inventario, consumo de reserva, CRM, interacción determinista y marcador `fulfillment.state=applied` se escriben en una sola transacción. Un evento duplicado o concurrente no repite esos efectos. Una cancelación concurrente impide preparar el pedido.

Para Tilopay, los productos y datos de entrega se toman del snapshot live capturado. Se exige concordancia de intento, ID de transacción, importe y huella, sin alertas de revisión. `reservedStock` solo disminuye por una reserva identificada de ese pedido; no consume reservas de otros compradores.

El navegador del administrador no puede marcar pagado ni adelantar `pagado → por_preparar`. Solo puede gestionar `por_preparar → enviado → entregado` después del fulfillment verificado y mientras no haya alertas. Las notas y el tracking sin cambio de estado conservan su permiso.

Un pedido con pago acreditado que pasa a `revision_manual` avisa por Telegram y correo **«Pagado pero requiere revisión»**, aunque `fulfillment.state` no sea `applied`. Para Tilopay se exige evidencia de captura live del intento principal, monto validado e ID asociado al pago; una autorización o un pago test no disparan ese aviso. La alerta incluye motivo y transacción y no prepara ni entrega productos. Sus reclamaciones son independientes de las del aviso normal (`paidEffects.review` y `paidReviewEmail`), para no ocultar una alerta posterior a la venta ni impedir el aviso normal tras resolver la revisión.

Correo y Telegram tienen reclamaciones persistentes por canal. No existe una transacción atómica entre Firestore y esos servicios: ante un envío ambiguo se conserva `sending` o `needs_review` sin reenviarlo automáticamente. Puede hacer falta recuperar un aviso manualmente. No se afirma entrega externa «exactamente una vez».

Los callables de comprobantes/aprobación manual y PayPal rechazan pedidos Tilopay o cualquier pedido con datos `.tilopay`, y vuelven a verificar los datos en sus transacciones. La modificación de PayPal está acotada a este cruce de métodos; no constituye una auditoría integral de PayPal.

## 7. Inventario histórico, migración y despliegue coordinado

Los intentos del diff anterior no tienen `schemaVersion: 2` ni snapshot completo. Se pueden consultar para diagnóstico, pero quedan en revisión. No se fabrica un snapshot usando el carrito actual para acreditar una transacción histórica. Tampoco se abre otro pago para ocultar el legado.

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

El [workflow de Functions y reglas](firebase-functions-deploy.md) automatiza únicamente la lista explícita de once funciones y `firestore:rules` tras un push a main. **Excluye `onOrderStatusChange`**, conforme a la revisión, porque faltan sus secretos Gmail. Sus mejoras de inventario, avisos y reintentos no estarán activas hasta desplegar también ese trigger. Gmail se vincula por nombre y se lee en runtime, de modo que sus secretos ausentes no bloqueen el discovery de otras funciones.

No habilitar live suponiendo que ese despliegue parcial ya actualizó el fulfillment: las nuevas reglas requieren su marcador verificado antes de enviar pedidos. La configuración de los secretos y el despliegue del trigger siguen siendo pasos necesarios para completar la incorporación.

Secuencia de incorporación recomendada:

1. Deshabilitar nuevos inicios de pago durante el reemplazo. Conservar la posibilidad de conciliar los intentos abiertos y registrar cuáles quedan en revisión.
2. Copiar todos los archivos del paquete respetando sus rutas, incluidos los nuevos helpers. No reemplazar solo `functions/tilopay.js`.
3. Ejecutar las pruebas. Aplicar las reglas y Functions de forma coordinada, con el inicio de pagos todavía deshabilitado. Las funciones afectadas son `tilopayGetConfig`, `tilopayCreatePayment`, `tilopayConfirm`, `createOrderWithReservation`, `onOrderStatusChange`, `deleteOrder`, `submitPaymentProof`, `approvePaymentManually`, `paypalCreateOrder` y `paypalCaptureOrder`; `paypalGetQuote` usa el pricing compartido actualizado. También se reemplaza el cron `cleanExpiredReservations` para que no expire intentos Tilopay históricos.
4. Incorporar el frontend. Verificar la configuración real de comercio/prefijo y secretos mediante las herramientas del proyecto, sin copiar valores de las pruebas.
5. Probar test con rol autorizado y comprobar que no hay efectos comerciales. Resolver los intentos heredados antes de reabrir compras equivalentes.
6. Antes de habilitar live para clientes, confirmar con Tilopay el comportamiento de captura del comercio y validar un pago controlado y su conciliación. Esa prueba real no fue ejecutada en esta revisión.

## 8. Webhook, OrderHash y captura separada

El retorno del navegador no aporta evidencia financiera confiable. `code`, `auth`, `order`, `returnData` u otros parámetros de URL no deciden el pago. Solicitar `hashVersion: V2` no equivale a verificar `OrderHash`.

No se añadió un webhook con un algoritmo supuesto. Hace falta el contrato de `processPayment` y la especificación de firma/OrderHash de Tilopay. Sin webhook ni un conciliador programado, si el comprador paga y cierra la pestaña, el pedido puede permanecer pendiente hasta que alguien vuelva a consultar con la misma sesión. Las devoluciones posteriores tampoco se detectan espontáneamente.

La documentación de HPP define `capture: "1"` como autorización y captura. Por eso no corresponde añadir una segunda captura indiscriminada en producción. Si `consult` informa `Authorize`, la evidencia observada todavía no es una captura. Puede depender de la configuración o del procesamiento del comercio; la causa real requiere contrastar el ID con Tilopay. Esta entrega conserva el pago pendiente y no llama a `processModification`.

## 9. Pruebas reproducibles

Desde la raíz del repositorio:

```bash
node scripts/test-tilopay.cjs
```

El runner ejecuta nueve suites de seguridad: servicio, parser, URLs, dinero, inventario, migración, pricing, integración de pedidos y correo de revisión. No necesita credenciales ni hace llamadas reales a Tilopay, PayPal, SMTP o Telegram. El doble de Firestore implementa versiones, consultas, reintentos y commits atómicos para las pruebas de carreras; no sustituye al emulador.

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

Se aprobaron las **121 pruebas de lógica y compatibilidad** de esta revisión: 110 del runner y 11 originales de PayPal, Meta y correo. También pasó `npm --prefix functions test` con el script corregido `node --test test/*.test.js`. Sin `FIRESTORE_EMULATOR_HOST`, la suite de reglas se omite explícitamente; un `npm test` sin emulador no demuestra haber validado reglas. Las reglas no se modificaron en esta segunda revisión; su ejecución anterior en emulador aprobó las 11 pruebas. También se comprueba sintaxis JavaScript, se compilan los dos componentes JSX y se valida estáticamente el workflow. Esto no equivale a un build completo de Vite, una prueba de navegador de extremo a extremo, una validación del IAM real ni una captura del comercio real.

## Fuentes de contrato

- [HPP / processPayment](https://tilopay.com/developers/api/hosted-payment-page/process-payment).
- [Consulta de transacciones](https://tilopay.com/developers/api/procesos-operativos/consult).
- [Reintentos y unicidad de orderNumber](https://tilopay.com/developers/reintentos-seguros).
- [Autenticación y expires_in](https://tilopay.com/developers/api/autenticacion).
- [Webhooks](https://tilopay.com/developers/api/webhooks).
- [Firestore: eventos, orden e idempotencia](https://firebase.google.com/docs/functions/firestore-events).
- [Firestore: reglas sobre campos y SDK de servidor](https://firebase.google.com/docs/firestore/security/rules-fields).
