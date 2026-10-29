// Config compartida del sync con Meta Catalog
const { defineSecret, defineString } = require("firebase-functions/params");

// Config de Meta:
//   META_CATALOG_ID          (param, functions/.env)   catálogo "WhatsApp Product Catalog" de Cute Creations
//   META_SYSTEM_USER_TOKEN   (Firebase secret)         firebase functions:secrets:set META_SYSTEM_USER_TOKEN
const META_CATALOG_ID = defineString("META_CATALOG_ID", { default: "" });
const META_SYSTEM_USER_TOKEN = defineSecret("META_SYSTEM_USER_TOKEN");

/** Lee catálogo + token. `missing` explica en español qué falta. */
function getMetaConfig() {
  let catalogId = "";
  let token = "";
  try { catalogId = (META_CATALOG_ID.value() || "").trim(); } catch { /* sin param */ }
  try { token = (META_SYSTEM_USER_TOKEN.value() || "").trim(); } catch { /* sin secret */ }
  const missing = [];
  if (!catalogId) missing.push("el ID del catálogo de Meta (META_CATALOG_ID en functions/.env)");
  if (!token) missing.push("el token de acceso de Meta (secret META_SYSTEM_USER_TOKEN en Firebase)");
  return {
    catalogId,
    token,
    missing,
    message: missing.length
      ? `No se puede sincronizar con Meta: falta ${missing.join(" y ")}. Hay que cargarlo y volver a desplegar; mientras tanto, el catálogo sigue actualizándose desde el feed.`
      : "",
  };
}

module.exports = { getMetaConfig, META_CATALOG_ID, META_SYSTEM_USER_TOKEN };
