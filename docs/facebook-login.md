# Continuar con Facebook (Firebase Auth) — apagado por defecto

Código listo y desplegado, **oculto** hasta que `config/auth.facebookEnabled === true` (documento Firestore `config/auth`, lectura pública, escritura solo admin). Si el documento no existe, el botón no se muestra.

Dónde aparece (cuando el flag está encendido): `/login` ("Continuar con Facebook"), checkout y confirmación de pedido para invitados ("Guardar mi cuenta con Facebook", `linkWithPopup`/`linkWithRedirect` → conserva el uid del invitado).

- Scopes: `email`, `public_profile` (`src/firebase.js`).
- Móvil y navegadores in-app (FB/Instagram/Messenger): `signInWithRedirect` / `linkWithRedirect`; el resultado se procesa con `getRedirectResult` en `AuthContext`.
- `auth/account-exists-with-different-credential` y otros errores: mensajes en español (`socialAuthErrorMessage`).

## Para habilitarlo
1. Meta (app "Aquí Pauli ads", ID 1021156950994409): producto Facebook Login (Web) con URI de redirección válida `https://aqui-pauli.firebaseapp.com/__/auth/handler`; dominios de app `aquipauli.com` y `aqui-pauli.firebaseapp.com`; URL de política de privacidad, URL de eliminación de datos, ícono, correo de contacto; app en modo Live.
2. Firebase Console → Authentication → Sign-in method → Facebook → pegar App ID y App Secret.
3. Firestore: crear `config/auth` con `{ facebookEnabled: true }`.
