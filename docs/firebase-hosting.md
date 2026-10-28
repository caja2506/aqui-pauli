# Publicación de Aquí Pauli

El workflow `Publish Firebase Hosting` compila y publica la rama `main` en
https://aqui-pauli.web.app. Se ejecuta cuando se actualiza `main` y también desde
GitHub → Actions → Publish Firebase Hosting → Run workflow, seleccionando `main`.

Publica exclusivamente Firebase Hosting del proyecto `aqui-pauli`. Las Functions,
las reglas de Firestore, los índices y las reglas de Storage conservan su gestión
separada. La acción oficial utiliza `firebase deploy --only hosting`.

## Autorización inicial

Crear o utilizar una cuenta de servicio dedicada al proyecto `aqui-pauli` con:

- Firebase Hosting Admin (`roles/firebasehosting.admin`).
- API Keys Viewer (`roles/serviceusage.apiKeysViewer`), requerido por Firebase CLI.

Guardar su JSON de autenticación únicamente como un secreto de GitHub Actions en
este repositorio: Settings → Secrets and variables → Actions → New repository secret.
Nombre exacto: `FIREBASE_SERVICE_ACCOUNT_AQUI_PAULI`.

No guardar el JSON en archivos del repositorio ni compartirlo por chat. No usar la
cuenta de servicio de Motel Ops. Esta integración no necesita permisos para
administrar Functions, Firestore o Storage, ni para comentar pull requests.

Como alternativa guiada, un administrador autenticado puede ejecutar
`firebase init hosting:github --project aqui-pauli` desde una copia del repositorio
y revisar el resultado: el asistente oficial configura la cuenta de servicio y el
secreto. Conservar este workflow y su alcance de Hosting; no habilitar publicación
de otros servicios ni previews si no se desean.

Si el secreto falta o pertenece a otro proyecto, el flujo se detiene antes de
publicar y muestra un mensaje explícito. Tras configurar el secreto, volver a
ejecutar el workflow sobre `main`.

## Verificación

La compilación utiliza el `package-lock.json` con `npm ci` y `npm run build`.
El workflow publica `deployment.json` con el SHA del commit y comprueba que la
versión pública, el HTML y los archivos JavaScript/CSS coincidan con la compilación.
También comprueba la ruta `/catalogo`. Esta comprobación valida la entrega de la
aplicación; no prueba compras, autenticación ni funciones del backend.

Referencias oficiales:

- https://firebase.google.com/docs/hosting/github-integration
- https://github.com/FirebaseExtended/action-hosting-deploy
- https://github.com/FirebaseExtended/action-hosting-deploy/blob/main/docs/service-account.md
