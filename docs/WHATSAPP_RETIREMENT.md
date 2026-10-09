# WA-RETIRE-001 — Retirada de WhatsApp de la tienda Aquí Pauli

| ID | Área | Requisito aprobado | Regla verificable | Prioridad | Estado | Evidencia |
|---|---|---|---|---|---|---|
| WA-RETIRE-001 | WhatsApp / tienda | Retirar el canal WhatsApp de Aquí Pauli para reservar el remitente elegido a reportes de MotelOps. | Por defecto el backend no envía ni procesa WhatsApp, no crea sus automatizaciones y la web no invita al canal; pagos, pedidos, Telegram y catálogo Meta conservan su comportamiento. | Alta | Preparación autorizada; despliegue y retirada de acceso externo pendientes. | 2026-10-09: Carlos indicó que quitará el número de la página Facebook y «después resuelves lo de aquí Pauli», tras confirmar retiro de la tienda custom. |

## Fuente y coordinación

Fuente oficial: `caja2506/aqui-pauli`, main d50998962b3f4162fd152ef32751bfa79a7c751b. Rama `codex/retire-store-whatsapp`; sin PR previo abierto. La autoría final se realiza por conector GitHub con SHA y lease. Los artefactos en `/workspace/aqui-pauli-review` sirven para revisar el candidato. Root mantiene rama/docs/CI; agentes separados preparan backend y frontend; revisor independiente no edita.

El número y receptor confirmados se conservan fuera de los documentos nuevos; no se copian tokens de la tienda a MotelOps. El caso MotelOps WA-001 está preparado en borrador#104 y depende de conservar reportes seguros del borrador#100.

## Estado inicial

La tienda programa WhatsApp mediante Meta Cloud API: emisor del bot, emisor interno del webhook vigente, callable `sendWhatsAppMessage` y `processScheduledAutomations` cada60 minutos. El webhook modular sobrescribe al legado al reexportarse en `functions/index.js`. Además hay enlaces públicos de atención/comprobantes y soporte manual. Los modos IA de la UI no constituyen un interruptor global.

`META_CATALOG_ID`/`META_SYSTEM_USER_TOKEN` se usan para catálogo de comercio; no se retiran por inferir que todo Meta es WhatsApp. SINPE/IBAN y registros de pedidos/pagos tampoco cambian en este bloque.

## Implementación prevista

- Backend: `STORE_WHATSAPP_ENABLED` solo habilita cuando es exactamente `true`; ausente/falso/malformado se retira el canal. Guardas antes de secretos, red y efectos de bot/OCR/pedidos/CRM.
- Callable retirado: error `failed-precondition`, sin declarar envío exitoso. Webhook retirado: POST200 sin procesar; GET403; otros métodos405. Emisores internos devuelven resultado retirado. Esto se aplica a nuevas invocaciones después de publicar la versión; no recupera efectos ya realizados.
- Schedulers de WhatsApp y creación de sus automatizaciones se detienen antes de escrituras; históricos y pendientes se conservan. Otros procesos/Telegram permanecen activos. Revisar pendientes antes de reactivar para no enviar avisos antiguos.
- Web: `VITE_STORE_WHATSAPP_ENABLED` solo habilita cuando es exactamente `true`; omisión/falso retira enlaces/invitaciones a este canal. No inventar un teléfono o método alternativo para comprobar pagos.
- Frontend/backend pueden desplegarse en distintos momentos: un cliente antiguo debe recibir rechazo del backend retirado; el soporte no debe resolver un contacto si no existe confirmación real de envío.

## Publicación y límites pendientes

Preparar/probar el código no desconecta el runtime. No se publica Functions/Hosting ni se cambia Meta en esta preparación. Antes de una ejecución: comprobar versión efectiva y acceso a Firebase `aqui-pauli`, coordinar backend antes de web, identificar token/app/activos dedicados y retirar acceso de la tienda sin afectar la futura conexión de MotelOps. Quitar el vínculo de Facebook o desuscribir un webhook por sí solo no bloquea emisores salientes que aún conserven token/permisos. No borrar el número ni la cuenta WhatsApp.

Verificar nuevas invocaciones retiradas, bot sin procesamiento y ausencia de nuevos envíos; revisar solicitudes en vuelo y la credencial antigua. El acceso directo a Meta/Firebase y esa comprobación productiva siguen pendientes. No afirmar número libre para MotelOps hasta completar la retirada y verificarla.
