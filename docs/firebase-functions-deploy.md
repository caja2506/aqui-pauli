# Despliegue de Functions y reglas de Firestore

El workflow `.github/workflows/firebase-functions-deploy.yml` despliega al proyecto **`aqui-pauli`** después de un `push` a **`main`** que cambie `functions/**`, `firestore.rules` o el propio workflow. Un push a `chatgpt/tilopay-hardening` y las actualizaciones del PR no disparan este despliegue. No tiene ejecución manual ni eventos de pull request.

## Alcance exacto

`scripts/firebase-deploy-targets.mjs` selecciona el alcance según el diff. Cambios aislados de sorteo, pedidos o comprobantes usan sus endpoints; cambios compartidos o un historial incompleto usan `firestore:rules` junto con esta lista general de Functions:

```text
functions:default:tilopayGetConfig
functions:default:tilopayGetQuote
functions:default:tilopayCreatePayment
functions:default:tilopayConfirm
functions:default:tilopayReconcilePayments
functions:default:createOrderWithReservation
functions:default:deleteOrder
functions:default:manageCashOnDeliveryOrder
functions:default:submitPaymentProof
functions:default:approvePaymentManually
functions:default:paypalCreateOrder
functions:default:paypalCaptureOrder
functions:default:paypalGetQuote
functions:default:cleanExpiredReservations
functions:default:enterGiveaway
```

`firebase.json` configura el directorio `functions` como codebase `default`. El segmento `default` hace explícita esa selección y evita incluir otro codebase si se agrega, por ejemplo, `functions-metafeed`. Una carpeta suelta no constituye un codebase desplegable: debe estar declarada en `firebase.json`. La [sintaxis oficial del CLI](https://github.com/firebase/firebase-tools/blob/v15.34.2/src/commands/deploy.ts) admite `functions:codebase:función`; Firebase explica la separación entre codebases en [Organize multiple functions](https://firebase.google.com/docs/functions/organize-functions).

`onOrderStatusChange` queda excluida porque aún faltan `GMAIL_SMTP_USER` y `GMAIL_SMTP_APP_PASSWORD`. Publicar este workflow no actualiza el trigger que ya esté desplegado: sus cambios de avisos y caducidad de reintentos requieren un despliegue posterior de esa función cuando sus secretos estén preparados. El nuevo flujo Tilopay aplica inventario/CRM desde sus callables y su conciliador, sin depender del trigger ni publicar el estado intermedio `status: pagado` que pudiera activar una versión antigua. Esta actualización no añade avisos externos. Tampoco se despliegan Hosting, índices, `paypalGetConfig`, funciones de catálogo/CRM ni otras funciones añadidas al código. Para ampliar la lista hace falta modificar y probar el selector.

`cleanExpiredReservations` sí se actualiza, y se añade `tilopayReconcilePayments` cada cinco minutos. Al desplegar una función `onSchedule`, Firebase crea o actualiza su función HTTP y su trabajo de Cloud Scheduler. Los crons quedan sujetos a sus horarios declarados; no se ejecutan como comandos dentro del workflow. Un push de la rama del PR tampoco los publica ni los invoca. El conciliador consulta exclusivamente intentos live en la cola privada `tilopayReconciliation`, con lease y límite por ejecución; no crea pagos ni captura autorizaciones. El workflow no ejecuta la migración `functions/scripts/fix-reserved-stock.js`, no cambia `config/payments.tilopay.mode` y no realiza cobros. Véase [Schedule functions](https://firebase.google.com/docs/functions/schedule-functions).

## Credencial, versiones y parámetros

Se reutiliza el secreto de GitHub **`FIREBASE_SERVICE_ACCOUNT_AQUI_PAULI`**. Debe contener el JSON completo de una cuenta de servicio de `aqui-pauli`. El workflow valida el tipo y el proyecto sin imprimir el JSON, lo escribe en `runner.temp` con permisos `0600`, configura `GOOGLE_APPLICATION_CREDENTIALS` únicamente en el paso de despliegue y elimina el archivo con un paso `always()`. La clave no se coloca en el repositorio, caché, outputs ni artefactos. Es el mecanismo de [Application Default Credentials recomendado por Firebase para CI](https://firebase.google.com/docs/cli#cli-ci-systems).

Se ejecutan `npm ci --prefix functions` y `npm --prefix functions test` antes de cargar la credencial. Node usa la versión mayor **22**, igual que `functions/package.json`; `firebase-tools` está fijado en **15.34.2**. Las acciones de checkout y setup-node conservan los mismos SHA completos del workflow de Hosting. El job tiene concurrencia única y no cancela un despliegue en curso.

El archivo de parámetros no secretos `functions/.env` debe conservar los valores del proyecto para `PAYPAL_ENV`, `PAYPAL_APP_CLIENT_ID`, `TILOPAY_RETURN_BASE` y `META_CATALOG_ID`. No se copian sus valores a esta guía. El CLI 15.34.2 resuelve los parámetros declarados del codebase antes del filtro por endpoint y, en modo `--non-interactive`, exige que los parámetros de texto estén resueltos; un `default` en `defineString` no sustituye aquí el archivo de entorno. No borrar este archivo ni regenerarlo con valores de ejemplo al desplegar. Documentación: [configuración mediante parámetros y archivos dotenv](https://firebase.google.com/docs/functions/config-env).

Los secretos de pago viven en **Google Cloud Secret Manager**, separados del secreto de GitHub que autentica al deployer. Deben existir versiones habilitadas de `TILOPAY_API_USER`, `TILOPAY_API_PASSWORD`, `TILOPAY_KEY` y `PAYPAL_SECRET`. Además, el CLI descubre las declaraciones `defineSecret` de otros módulos del mismo codebase aunque el endpoint no esté seleccionado; declaraciones de Telegram/Meta pueden requerir consultar sus metadatos. Los secretos de Gmail se enlazan al trigger por nombre, sin declarar parámetros globales que bloqueen la selección parcial. No se introducen valores ficticios de secretos para lograr el despliegue.

## IAM: qué cuenta necesita cada permiso

No se ha inspeccionado la política IAM de `aqui-pauli` ni la clave del secreto de GitHub. Por eso no puede afirmarse cuáles de estos permisos faltan actualmente. Que la cuenta pueda desplegar Hosting no demuestra que pueda desplegar Functions, reglas o Scheduler.

| Identidad | Rol o permiso que revisar | Alcance y motivo |
| --- | --- | --- |
| Cuenta de servicio usada por GitHub Actions | `roles/cloudfunctions.admin` | En `aqui-pauli`, para crear/actualizar las funciones y gestionar los permisos de invocación requeridos por sus callables públicos. Es la recomendación de Firebase junto con Service Account User. |
| Cuenta de servicio usada por GitHub Actions | `roles/iam.serviceAccountUser` | Sobre las cuentas de servicio **reales** de runtime y build que usa el despliegue, para `iam.serviceAccounts.actAs`; preferir bindings en esas cuentas concretas. |
| Cuenta de servicio usada por GitHub Actions | `roles/firebaserules.admin` | En `aqui-pauli`, para publicar las reglas. Los permisos de Hosting o Cloud Functions no reemplazan los de Firebase Rules. |
| Cuenta de servicio usada por GitHub Actions | `roles/cloudscheduler.admin`, o rol personalizado con los permisos de creación/consulta/actualización del job | Necesario por `cleanExpiredReservations`; no lo aporta Secret Accessor. Revisar también la identidad que invoca el servicio y sus permisos. |
| Cuenta de servicio usada por GitHub Actions | `roles/secretmanager.viewer`, o permisos equivalentes de metadatos/IAM de los secretos pertinentes | El CLI consulta existencia, versiones y bindings de secretos. Si el binding del runtime aún no existe y se espera que el CLI lo cree, también necesita `secretmanager.secrets.setIamPolicy`; un administrador puede preparar ese binding antes. |
| Cuenta de servicio de **runtime** | `roles/secretmanager.secretAccessor` | Sobre cada secreto que la función tiene enlazado. Este rol concede acceso al valor; asignarlo al deployer no concede acceso al runtime. La cuenta también necesita los permisos de Firestore/otros servicios que usa el código en ejecución. |
| Cuenta de servicio de **Cloud Build** | `roles/cloudbuild.builds.builder`, o los permisos de build equivalentes ajustados a sus recursos | Para construir la imagen, leer la fuente y publicar los artefactos/logs. Es la cuenta que ejecuta el build, que puede ser distinta de la de GitHub y de runtime. |

Fuentes de la tabla: [Firebase IAM y despliegue de Functions](https://firebase.google.com/docs/projects/iam/permissions#functions), [cuentas de runtime/build y Service Account User](https://docs.cloud.google.com/functions/docs/reference/iam/roles), [Firebase Rules Admin](https://docs.cloud.google.com/iam/docs/roles-permissions/firebaserules), [Cloud Scheduler](https://docs.cloud.google.com/iam/docs/roles-permissions/cloudscheduler) y [roles de Secret Manager](https://docs.cloud.google.com/iam/docs/roles-permissions/secretmanager).

**Secret Accessor no basta para administrar un despliegue con secretos**: permite leer sus valores, no consultar todos sus metadatos ni conceder acceso a otras cuentas. La opción de menor privilegio es preparar previamente los secretos y los bindings del runtime, y dar al deployer los permisos de consulta que necesita. Si el CLI necesita cambiar bindings o limpiar versiones sin uso, revisar el permiso específico que solicita; no conceder automáticamente Secret Manager Admin sobre todo el proyecto. La comprobación de bindings y los permisos de metadatos se contrastaron con el código de `firebase-tools` 15.34.2 (`deploy/functions/ensure`, `deploy/functions/params` y `gcp/secretManager`).

En Functions de segunda generación, la cuenta de runtime predeterminada suele ser `PROJECT_NUMBER-compute@developer.gserviceaccount.com`, pero hay que verificar la configuración efectiva. La cuenta predeterminada de Cloud Build cambió en proyectos afectados por los cambios de 2024; no asumir que siempre es `PROJECT_NUMBER@cloudbuild.gserviceaccount.com`. Véanse [cambios de Cloud Build](https://docs.cloud.google.com/build/docs/cloud-build-service-account-updates) y [proceso de build y roles por recurso](https://docs.cloud.google.com/functions/docs/building).

También deben estar habilitadas las APIs usadas por Firebase, Cloud Functions, Cloud Build, Artifact Registry, Cloud Run, Secret Manager y Cloud Scheduler. La preparación de Functions de segunda generación también comprueba Eventarc, Pub/Sub y Cloud Storage. Si la CLI necesita habilitar una API nueva o generar/configurar un service agent, el administrador debe preparar ese recurso o autorizar específicamente esa operación. No hace falta convertir la cuenta de GitHub en Owner/Editor para resolverlo. Mantener los roles administrados de los service agents de Google en sus identidades correspondientes; no copiarlos a la cuenta de GitHub. Referencias: [permisos de proyecto/API requeridos por Firebase](https://firebase.google.com/docs/projects/iam/permissions#required_permissions) e [identidades administrativas de Cloud Functions](https://docs.cloud.google.com/functions/docs/concepts/iam).

## Antes del primer push a main que lo active

Una persona con acceso administrativo debe comprobar los permisos efectivos de la cuenta del secreto de GitHub, los bindings de runtime/build y los metadatos de los secretos requeridos. Puede hacerlo sin mostrar claves privadas ni leer el contenido de los secretos. La configuración de Gmail y el despliegue de `onOrderStatusChange` quedan para el paso separado acordado.

El despliegue de reglas y varias funciones no es una transacción atómica: un fallo puede dejar una parte publicada. Ante un error, revisar qué recursos informa el CLI como desplegados y corregir el permiso/configuración concreta antes de volver a ejecutar. La migración de stock y el cambio de Tilopay a live requieren sus propios pasos operativos; añadir este workflow o actualizar la rama no los realiza.
