# Sorteo de perfumes · octubre y noviembre de 2026

## Accesos y fechas

- Participación: `/sorteo`; bases de inscripción: `/sorteo/bases`.
- Administración: `/admin/sorteo`, protegida por el rol real de Firestore `users_roles/{uid}.role == 'admin'`.
- Inicio: 29 de octubre de 2026, 00:00, Costa Rica (`2026-10-29T06:00:00.000Z`).
- Cierre de inscripciones: sábado 28 de noviembre de 2026, 20:00, Costa Rica (`2026-11-29T02:00:00.000Z`). El límite de cierre es exclusivo.
- Fecha del sorteo: domingo 29 de noviembre de 2026, Costa Rica. No se ha fijado una hora para el sorteo.
- La definición compartida por navegador y servidor está en `functions/lib/giveawayConfig.json`.

El banner aparece en inicio y catálogo durante el período. El formulario exige una cuenta registrada; una sesión anónima de compra no es suficiente. El login existente conserva el retorno a `/sorteo`.

## Premio del catálogo

La selección fija de dos perfumes fue reemplazada por un selector con búsqueda de productos cargados de Firestore. `functions/lib/giveawayCatalog.mjs` es la política única utilizada por el navegador y la función del servidor:

- Producto activo, publicado, no borrado y no marcado `unlisted`.
- Categoría de perfumes, colonias o fragancias, o una subcategoría de estas. Se usan las categorías reales de Firestore y sus relaciones `parentId`, no palabras del nombre del producto.
- Precio de venta positivo y **estrictamente inferior a ₡50 000**. El banner conserva el texto comercial solicitado «hasta ₡50 000», pero formulario y bases aclaran que ₡50 000 exactos no califican.
- Se usa el precio de la tarjeta del catálogo: primera variante activa según `order` y, en empate, ID del documento; su `price` con el fallback existente a `basePrice`. No se escoge la variante más barata. Sin variantes activas se usa el precio base mostrado.
- No se filtra por stock, abastecimiento o estado comercial: también califican productos bajo pedido o sin stock. Un error de lectura de variantes muestra un error y no habilita un precio base potencialmente incorrecto.
- Como la tienda muestra colones enteros, un precio que se redondea a ₡50 000 también queda excluido.

La lista se carga al abrir el formulario y permite actualizar colonias y precios. El servidor vuelve a leer producto, variantes y categorías dentro de la transacción de inscripción. Si el catálogo cambia entre lecturas y escritura, la transacción reintenta y valida de nuevo. El cliente envía únicamente `productId`, nunca el nombre o precio como autoridad.

Las nuevas entradas guardan `productId`, `productName`, `productPrice`, la variante canónica y `schemaVersion: 2`, con la versión de bases `2026-10-29-catalog-v2`. Los valores corresponden al catálogo al inscribirse; no se recalculan al consultar la participación.

Las inscripciones anteriores conservan su número, premio y consentimientos. No se migra su elección, no se resetea el contador y no se asigna un precio inventado a los premios de la primera versión. El admin, CSV y comprobante usan el nombre guardado, con `prizeLabel` como compatibilidad para esas entradas.

La confirmación destaca el número y pide comentarlo en la publicación del sorteo en Instagram `@aqui.paulina`. El enlace abre el perfil porque no se proporcionó una URL de publicación. La aplicación no publica comentarios automáticamente.

## Encender y apagar

El botón del panel admin escribe el booleano `enabled` en `config/giveaway`, conservando los demás campos. También se puede cambiar ese campo desde la consola de Firestore:

```json
{ "enabled": false }
```

Un `false` explícito oculta el banner y detiene nuevas inscripciones. `true` habilita la campaña únicamente dentro de sus fechas. Si el documento aún no existe, la campaña está habilitada dentro del plazo. No es necesario un seed ni cambiar permisos de cuentas de servicio para encenderla. Un error al leer Firestore no permite inscribir.

El navegador escucha el flag y programa el cierre mientras la página está abierta. El servidor comprueba de nuevo el flag y su propio reloj en la transacción; cambiar la hora del teléfono no permite inscribirse fuera de plazo. Las participaciones existentes siguen siendo consultables después del cierre o de una pausa.

## Datos y numeración

La callable `enterGiveaway` recibe únicamente nombre, teléfono, correo, `productId` y las tres elecciones de consentimiento. Usa el UID autenticado como ID de `giveawayEntries/{uid}`. Cuando la cuenta tiene correo, ese correo es la autoridad; para proveedores sin correo, el formulario permite completar uno válido.

La creación de la inscripción y el incremento de `giveawayCounters/2026-10-perfumes.lastNumber` ocurren en una sola transacción. Los números empiezan en 1. Dos envíos del mismo usuario devuelven la inscripción original; varios usuarios concurrentes obtienen números distintos. El cliente no puede aportar UID, número, fecha o campaña, ni escribir el contador.

Cada entrada guarda los datos solicitados, premio, número, campaña, UID, `createdAt` y `consentAcceptedAt` como Timestamp de Firestore generado en el servidor, textos/versiones de las declaraciones y el consentimiento promocional separado. No se copian participantes al CRM ni se envían promociones o mensajes automáticamente.

Las reglas permiten `get` del propio documento a usuarios registrados y lectura/listado al admin. Toda creación se hace mediante la callable autenticada: las escrituras directas del navegador están denegadas, incluso para administradores, para proteger la numeración y la constancia del consentimiento. El contador es exclusivo del servidor. No se deben reiniciar contadores o borrar entradas para corregir un número.

## Administración y privacidad

La lista muestra número, nombre, teléfono, correo, colonia escogida, precio al inscribirse, fecha de Costa Rica y autorización promocional. El CSV incluye esos campos y el ID del producto, codificación UTF-8 con BOM y protección contra fórmulas de hojas de cálculo. La descarga ocurre localmente por acción del administrador. Las filas anteriores sin precio registrado lo dejan vacío en el CSV.

Las solicitudes de acceso, rectificación, revocación o eliminación se reciben por DM a `@aqui.paulina`, como indica el consentimiento. La atención de esas solicitudes corresponde al responsable; esta entrega no agrega un botón de borrado masivo ni un flujo de mensajes. Si se atiende una eliminación en las herramientas administrativas del proyecto, se conserva el contador sin renumerar a las demás personas y se revisan también las copias CSV exportadas.

Las bases publicadas documentan la inscripción y la fecha del sorteo, el domingo 29 de noviembre de 2026. No se programó una extracción automática de ganadores ni se fijaron hora del sorteo, cantidad de ganadores o condiciones de entrega que no se habían indicado en la solicitud.

## Pruebas y despliegue

```sh
node functions/test/giveaway.test.js
npm run test:giveaway
node scripts/checkout-render.test.mjs
npm --prefix functions test
npm run build
```

Las pruebas de reglas usan exclusivamente un emulador local y un proyecto `demo-*`; no crean participantes en producción. Con `firebase-tools`, Java 21, `@firebase/rules-unit-testing` y su Firebase compatible instalados:

```sh
firebase emulators:exec --only firestore --project demo-aqui-pauli-giveaway --config firebase.tilopay-emulator.json "node functions/test/firestore-giveaway.emulator.test.js"
```

CI instala las dependencias de reglas fuera del proyecto y ejecuta esa suite antes de cargar credenciales. Hosting ejecuta los tests de render, formularios y CSV antes de publicar.

`scripts/firebase-deploy-targets.mjs` reconoce una entrega exclusiva de este sorteo y selecciona `firestore:rules,functions:default:enterGiveaway`. Los cambios de funciones compartidas o de otros dominios conservan los endpoints que ya desplegaba el proyecto, agregando el del sorteo. Un historial insuficiente conserva el despliegue completo existente. La entrega no cambia archivos de pagos o checkout.

Después del merge deben verificarse los dos workflows y que `https://aquipauli.com/deployment.json` muestre el SHA del merge. El manifiesto confirma la versión de Hosting; el éxito del workflow de Functions confirma la función y reglas.
