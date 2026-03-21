// ==============================================
// Gmail OAuth2 — Setup Script
// Ejecutar una vez para obtener el refresh_token
//
// Uso:
//   node functions/gmail/setup.js
//
// Requisitos:
//   1. Crear proyecto en Google Cloud Console
//   2. Habilitar Gmail API
//   3. Crear credenciales OAuth2 (tipo "Desktop App")
//   4. Descargar el JSON de credenciales
// ==============================================
const { google } = require("googleapis");
const readline = require("readline");

// ⚠️ REEMPLAZA con tus credenciales OAuth2 de Google Cloud Console
const CLIENT_ID = "TU_CLIENT_ID.apps.googleusercontent.com";
const CLIENT_SECRET = "TU_CLIENT_SECRET";
const REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob";

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

async function setup() {
  const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });

  console.log("\n🔗 Abre esta URL en tu navegador para autorizar:");
  console.log(authUrl);
  console.log("\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  rl.question("Pega aquí el código de autorización: ", async (code) => {
    const { tokens } = await oauth2Client.getToken(code);

    console.log("\n✅ Tokens obtenidos:");
    console.log("---");
    console.log(`GMAIL_REFRESH_TOKEN: ${tokens.refresh_token}`);
    console.log("---");
    console.log("\n📋 Ahora guarda estos secrets en Firebase:");
    console.log(`  firebase functions:secrets:set GMAIL_CLIENT_ID`);
    console.log(`  firebase functions:secrets:set GMAIL_CLIENT_SECRET`);
    console.log(`  firebase functions:secrets:set GMAIL_REFRESH_TOKEN`);

    rl.close();
  });
}

setup().catch(console.error);
