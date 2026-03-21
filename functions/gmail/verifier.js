// ==============================================
// Gmail — Payment Verifier
// Busca emails bancarios para verificar pagos SINPE
// Disparado por trigger cuando llega comprobante por WhatsApp
// ==============================================
const { google } = require("googleapis");
const { defineSecret } = require("firebase-functions/params");
const { getFirestore } = require("firebase-admin/firestore");

const GMAIL_CLIENT_ID = defineSecret("GMAIL_CLIENT_ID");
const GMAIL_CLIENT_SECRET = defineSecret("GMAIL_CLIENT_SECRET");
const GMAIL_REFRESH_TOKEN = defineSecret("GMAIL_REFRESH_TOKEN");

const db = getFirestore();

/**
 * Verifica un pago buscando el email bancario correspondiente
 * Disparado por el webhook de WhatsApp cuando recibe un comprobante con # transacción
 *
 * @param {string} orderId - ID de la orden en Firestore
 * @param {object} ocrData - Datos extraídos por OCR: { transactionId, amount, phone, bank }
 */
async function verifyWithGmail(orderId, ocrData) {
  if (!ocrData?.transactionId && !ocrData?.amount) {
    console.log("⚠️ Gmail: Sin datos suficientes para verificar");
    return { verified: false, reason: "sin_datos" };
  }

  try {
    const auth = new google.auth.OAuth2(
      GMAIL_CLIENT_ID.value(),
      GMAIL_CLIENT_SECRET.value()
    );
    auth.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN.value() });

    const gmail = google.gmail({ version: "v1", auth });

    // Construir query de búsqueda
    const searchTerms = [];
    if (ocrData.transactionId) searchTerms.push(ocrData.transactionId);
    if (ocrData.amount) searchTerms.push(ocrData.amount.toString());
    searchTerms.push("SINPE OR transferencia OR crédito OR abono");

    // Buscar en las últimas 24 horas
    const after = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
    const query = `{${searchTerms.join(" ")}} after:${after}`;

    console.log(`🔍 Gmail search: ${query}`);

    const response = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: 10,
    });

    const messages = response.data.messages || [];
    console.log(`📧 Encontrados ${messages.length} emails`);

    if (messages.length === 0) {
      // Programar reintento en 2 minutos
      await scheduleRetry(orderId, ocrData);
      return { verified: false, reason: "sin_emails" };
    }

    // Analizar cada email
    for (const msg of messages) {
      const email = await gmail.users.messages.get({
        userId: "me",
        id: msg.id,
        format: "full",
      });

      const emailData = parsePaymentEmail(email.data);

      if (emailData) {
        const isMatch = matchPaymentData(emailData, ocrData);

        if (isMatch) {
          // ✅ Match confirmado — actualizar orden
          await db.collection("orders").doc(orderId).update({
            paymentStatus: "verificado",
            status: "pagado",
            gmailVerification: {
              emailId: msg.id,
              emailSubject: emailData.subject,
              emailAmount: emailData.amount,
              emailTransactionId: emailData.transactionId,
              emailBank: emailData.bank,
              verifiedAt: new Date().toISOString(),
            },
            updatedAt: new Date().toISOString(),
          });

          console.log(`✅ Pago verificado via Gmail para orden ${orderId}`);
          return { verified: true, emailData };
        }
      }
    }

    // No hubo match exacto
    await db.collection("orders").doc(orderId).update({
      gmailVerification: {
        status: "sin_match",
        searchQuery: query,
        emailsFound: messages.length,
        checkedAt: new Date().toISOString(),
      },
    });

    return { verified: false, reason: "sin_match" };
  } catch (error) {
    console.error("❌ Gmail verification error:", error.message);

    // Si es error de auth, marcar para revisión manual
    if (error.message.includes("invalid_grant") || error.message.includes("Token")) {
      console.error("⚠️ Gmail OAuth token inválido. Necesita re-autorización.");
    }

    return { verified: false, reason: "error", error: error.message };
  }
}

/**
 * Parsea un email bancario para extraer datos de pago
 */
function parsePaymentEmail(emailData) {
  const headers = emailData.payload?.headers || [];
  const subject = headers.find(h => h.name === "Subject")?.value || "";
  const from = headers.find(h => h.name === "From")?.value || "";

  // Obtener body del email
  let body = "";
  if (emailData.payload?.body?.data) {
    body = Buffer.from(emailData.payload.body.data, "base64").toString("utf-8");
  } else if (emailData.payload?.parts) {
    for (const part of emailData.payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        body += Buffer.from(part.body.data, "base64").toString("utf-8");
      }
    }
  }

  if (!body && !subject) return null;

  const fullText = subject + " " + body;

  // Extraer datos
  const amount = extractAmountFromEmail(fullText);
  const transactionId = extractTransactionIdFromEmail(fullText);
  const bank = detectBankFromEmail(from, subject);

  if (!amount && !transactionId) return null;

  return {
    subject,
    from,
    amount,
    transactionId,
    bank,
  };
}

/**
 * Extrae monto del email
 */
function extractAmountFromEmail(text) {
  const patterns = [
    /[₡¢]\s*([\d.,]+)/gi,
    /CRC\s*([\d.,]+)/gi,
    /[Mm]onto[:\s]*[₡¢]?\s*([\d.,]+)/gi,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      const raw = match[1].replace(/\./g, "").replace(",", ".");
      const num = parseFloat(raw);
      if (num > 100 && num < 50000000) return num;
    }
  }
  return null;
}

/**
 * Extrae # transacción del email
 */
function extractTransactionIdFromEmail(text) {
  const patterns = [
    /[Rr]eferencia[:\s#]*(\d{6,20})/g,
    /[Nn][oú]m?\.?\s*[Tt]ransacci[oó]n[:\s#]*(\d{6,20})/g,
    /[Cc]omprobante[:\s#]*(\d{6,20})/g,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match[1];
  }
  return null;
}

/**
 * Detecta banco del email
 */
function detectBankFromEmail(from, subject) {
  const text = (from + " " + subject).toUpperCase();
  if (text.includes("BCR")) return "BCR";
  if (text.includes("NACIONAL") || text.includes("BNCR")) return "BN";
  if (text.includes("BAC")) return "BAC";
  if (text.includes("SCOTIABANK")) return "Scotiabank";
  if (text.includes("DAVIVIENDA")) return "Davivienda";
  return null;
}

/**
 * Compara datos del email con datos del OCR
 */
function matchPaymentData(emailData, ocrData) {
  // Match por # transacción (más confiable)
  if (emailData.transactionId && ocrData.transactionId) {
    if (emailData.transactionId === ocrData.transactionId) {
      console.log("✅ Match por # transacción");
      return true;
    }
  }

  // Match por monto (con tolerancia)
  if (emailData.amount && ocrData.amount) {
    const diff = Math.abs(emailData.amount - ocrData.amount);
    if (diff < 100) { // Tolerancia ₡100
      console.log(`✅ Match por monto: email=${emailData.amount}, ocr=${ocrData.amount}`);
      return true;
    }
  }

  return false;
}

/**
 * Programa un reintento de verificación Gmail
 * (el email del banco puede tardar unos minutos)
 */
async function scheduleRetry(orderId, ocrData) {
  await db.collection("gmail_retries").doc(orderId).set({
    orderId,
    ocrData,
    retryCount: 0,
    maxRetries: 3,
    nextRetryAt: new Date(Date.now() + 2 * 60 * 1000).toISOString(), // 2 min
    createdAt: new Date().toISOString(),
  });
  console.log(`⏳ Reintento Gmail programado para orden ${orderId}`);
}

module.exports = { verifyWithGmail };
