# WA-RETIRE-001 — Retirar WhatsApp de Aquí Pauli

| ID | Requisito | Regla verificable | Estado |
|---|---|---|---|
| WA-RETIRE-001 | Retirar WhatsApp de la tienda para reservar el remitente elegido a reportes de MotelOps. | Backend apagado por defecto; sin envíos, procesamiento ni nuevas automatizaciones WhatsApp. Web sin invitaciones al canal. | Código preparado en [borrador1](https://github.com/caja2506/aqui-pauli/pull/1); retirada productiva pendiente. |

Carlos indicó el 2026-10-09 que quitará el número de la página Facebook y «después resuelves lo de aquí Pauli», tras confirmar el retiro de la tienda custom. Ese cambio de Facebook lo realiza él; no se ha verificado aquí.

## Fuente y revisión

Fuente oficial: `caja2506/aqui-pauli`, main `d50998962b3f4162fd152ef32751bfa79a7c751b`. Rama `codex/retire-store-whatsapp`. Root publica mediante el conector GitHub con SHA y lease; agentes prepararon backend y web, y otro agente revisó de forma independiente. Los artefactos de `/workspace/aqui-pauli-review` son para revisión. El código revisado es `efe5a5a51b35c1e80747295749c2198fbffa9495`; los siguientes cambios ajustan CI y documentación.

No se incorporan tokens ni el receptor privado a estos documentos. No se reutilizan credenciales de la tienda en MotelOps. Reportes MotelOps están en [borrador104](https://github.com/caja2506/motelops/pull/104), con la coordinación de seguridad del [borrador100](https://github.com/caja2506/motelops/pull/100) pendiente.

## Comportamiento preparado

- Backend: `STORE_WHATSAPP_ENABLED` habilita únicamente con el texto exacto `true`. Ausente, falso o malformado apaga el canal.
- Los emisores se frenan antes de leer secretos o hacer peticiones. El callable `sendWhatsAppMessage` rechaza con `failed-precondition`; los internos devuelven estado `retired`.
- Ambos webhooks se frenan antes de leer contenido, procesar OCR/comprobantes, audio, pedidos, CRM o IA. POST responde200 sin procesamiento; GET403; otros métodos405. El webhook modular es el vigente porque sobrescribe al legado en `functions/index.js`.
- Los schedulers de WhatsApp y la creación de sus automatizaciones se frenan antes de escrituras. Históricos y pendientes se conservan. Los carritos no quedan marcados como notificados sin envío. Revisar pendientes antes de cualquier reactivación.
- Web: `VITE_STORE_WHATSAPP_ENABLED` tiene el mismo opt-in exacto, aplicado al compilar. Se ocultan enlaces públicos, invitaciones a comprobantes/actualizaciones y el acceso al centro WhatsApp.
- Soporte permite consultar el historial y bloquea respuestas WhatsApp. Un cliente con canal habilitado solo resuelve el contacto si el backend confirma estado `sent`, no ante `retired`, `disabled`, `stub_logged` o respuesta desconocida.

La lógica de pedidos, pagos, SINPE/IBAN, Telegram, limpieza de reservas y catálogo Meta permanece intacta. El sincronizador del catálogo usa `META_CATALOG_ID`/`META_SYSTEM_USER_TOKEN`, independientes de este interruptor.

Se elimina el comprobante por WhatsApp; no se incorpora un canal sustituto ni un nuevo formulario público. La confirmación indica conservar el comprobante y consultar el pedido. No se verificó un cobro real ni la atención alternativa de comprobantes.

## Validación del candidato

[CI inicial37983371968](https://github.com/caja2506/aqui-pauli/actions/runs/37983371968), sobre el código indicado:

| Comprobación | Resultado | Alcance |
|---|---|---|
| Backend Node20 | 17/17 pasan | Guardas, ausencia de efectos, pendientes conservados, opt-in y canales ajenos. Firebase/Meta simulados. |
| Web Node24 | 16/16 pasan | Render de componentes y callbacks de soporte con fixtures. No es una prueba de navegador contra producción. |
| Compilación | Pasa | `npm ci` y `npm run build`, con canal web apagado. |
| Lint general | Falla por2 errores existentes | `RoleContext.jsx` (setState en efecto) y `WhatsAppPage.jsx` (Date.now durante render). Archivos, configuración y lockfile intactos frente a main. |

El nuevo CI comprueba explícitamente los nueve archivos web modificados con las reglas existentes, además de las dos suites y build. No se suprimen reglas ni se cambia `npm run lint`. El resultado del último SHA está en el borrador y sus checks. Se verificó que los18 archivos de implementación/CI publicados coinciden con los candidatos de revisión iniciales. La revisión independiente no encontró bloqueantes del retiro; la deuda de lint general permanece.

## Secuencia de publicación pendiente

1. Coordinar la ventana con Carlos después de su cambio de Facebook. Desde el checkout oficial del SHA aceptado, verificar acceso a Firebase `aqui-pauli` y configuración efectiva. No copiar secretos a GitHub.
2. Publicar backend con `STORE_WHATSAPP_ENABLED=false` en el entorno del proyecto. Omitir la variable también apaga la versión nueva, pero no debe quedar un valor `true` heredado. Los exports necesarios son `sendWhatsAppMessage`, `whatsappWebhook`, `processScheduledAutomations`, `processAbandonedCarts` y `onOrderStatusChange`; este último incluye el helper compartido que deja de crear automatizaciones WhatsApp. Confirmar que todos usan la revisión nueva.
3. Verificar rechazos del callable, webhook sin procesamiento y schedulers sin envíos/escrituras. Comprobar que pedidos, Telegram, limpieza de reservas y catálogo siguen operando. Las invocaciones ya en vuelo pueden completar efectos: el código no los revierte.
4. Compilar la web con `VITE_STORE_WHATSAPP_ENABLED=false` y publicar Hosting después del backend. Revisar confirmación, Mis pedidos, pie de página y soporte en el sitio servido. Un cliente web antiguo queda protegido por el rechazo del backend nuevo.
5. Identificar la app, cuenta WhatsApp, remitente técnico y credencial usados por la tienda. Detener cualquier emisor externo y retirar solo el acceso dedicado de Aquí Pauli. Si hay permisos/credenciales compartidos con catálogo u otros servicios, separarlos antes de revocar. No borrar el número, la cuenta WhatsApp ni la app móvil.
6. Revisar registros de nuevas invocaciones y acceso efectivo de la app antigua. Solo tras completar esa retirada y verificarla se puede declarar terminado el uso de Aquí Pauli; la puesta en marcha de reportes MotelOps requiere su configuración/plantilla propias.

Quitar el enlace de Facebook no detiene los emisores del servidor. Desuscribir una app de webhooks tampoco revoca el token ni permisos de envío. La API oficial `DELETE /{WABA_ID}/subscribed_apps` retira suscripciones entrantes; no debe presentarse como revocación de acceso saliente. Fuentes Meta: [desuscripción](https://www.postman.com/meta/whatsapp-business-platform/request/3r2bl1m/unsubscribe-app-from-waba-s-webhooks), [consultar suscripciones](https://www.postman.com/meta/whatsapp-business-platform/request/tl2wk2j/get-all-subscriptions-for-a-waba).

## Estado externo

No se ha desplegado Functions/Hosting, retirado una credencial ni cambiado Meta desde esta entrega. El acceso directo y la verificación del runtime están pendientes. El borrador no acredita que el número esté libre para MotelOps ni que sus reportes ya estén activos.
