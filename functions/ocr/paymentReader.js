// ==============================================
// OCR — Payment Proof Reader
// Extrae monto, teléfono y # transacción de comprobantes SINPE
// ==============================================
const vision = require("@google-cloud/vision");
const client = new vision.ImageAnnotatorClient();

/**
 * Extrae datos de pago de una imagen de comprobante SINPE
 * @param {string} imageUrl - URL pública de la imagen
 * @returns {{ amount, phone, transactionId, bank, date, rawText }}
 */
async function extractPaymentData(imageUrl) {
  const [result] = await client.textDetection(imageUrl);
  const detections = result.textAnnotations;

  if (!detections || detections.length === 0) {
    console.log("⚠️ OCR: No se detectó texto en la imagen");
    return { amount: null, phone: null, transactionId: null, bank: null, date: null, rawText: "" };
  }

  const rawText = detections[0].description;
  console.log("📄 OCR raw text:", rawText.substring(0, 500));

  return {
    amount: extractAmount(rawText),
    phone: extractPhone(rawText),
    transactionId: extractTransactionId(rawText),
    bank: detectBank(rawText),
    date: extractDate(rawText),
    rawText: rawText.substring(0, 2000), // Limitar tamaño
  };
}

/**
 * Extrae monto en colones de texto
 * Patrones: ₡105.700 | CRC 105700 | ¢105,700.00 | Monto: 105700
 */
function extractAmount(text) {
  const patterns = [
    // ₡105.700 o ₡105,700 o ₡105700
    /[₡¢]\s*([\d.,]+)/gi,
    // CRC 105.700
    /CRC\s*([\d.,]+)/gi,
    // Monto: 105.700 | Monto ₡105.700
    /[Mm]onto[:\s]*[₡¢]?\s*([\d.,]+)/gi,
    // Total: 105700
    /[Tt]otal[:\s]*[₡¢]?\s*([\d.,]+)/gi,
  ];

  const amounts = [];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const raw = match[1].replace(/\./g, "").replace(",", ".");
      const num = parseFloat(raw);
      if (num > 100 && num < 50000000) { // Rango razonable en colones
        amounts.push(num);
      }
    }
  }

  // Retornar el monto más grande (generalmente el total)
  return amounts.length > 0 ? Math.max(...amounts) : null;
}

/**
 * Extrae número de teléfono del comprobante
 * Patrones: 8888-8888 | 88888888 | +506 8888 8888
 */
function extractPhone(text) {
  const patterns = [
    // 8888-8888 o 8888 8888
    /\b([2-8]\d{3}[-\s]?\d{4})\b/g,
    // +506 8888-8888
    /\+?506\s*([2-8]\d{3}[-\s]?\d{4})/g,
    // Teléfono: 88888888
    /[Tt]el[éeéf]*[ono]*[:\s]*\+?506?\s*([2-8]\d{7})/g,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      return match[1].replace(/[-\s]/g, "");
    }
  }
  return null;
}

/**
 * Extrae número/referencia de transacción
 * Patrones varían por banco:
 * - "Referencia: 123456789"
 * - "No. Transacción: 202603211234"
 * - "Comprobante #123456"
 */
function extractTransactionId(text) {
  const patterns = [
    // Referencia: XXXXXXX
    /[Rr]eferencia[:\s#]*(\d{6,20})/g,
    // No. Transacción: XXXXX
    /[Nn][oú]m?\.?\s*[Tt]ransacci[oó]n[:\s#]*(\d{6,20})/g,
    // Comprobante: XXXXX
    /[Cc]omprobante[:\s#]*(\d{6,20})/g,
    // ID: XXXXXX
    /\bID[:\s]*(\d{8,20})\b/g,
    // Número largo suelto (posible referencia)
    /\b(20\d{10,18})\b/g, // Formato: año + secuencia
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      return match[1];
    }
  }
  return null;
}

/**
 * Detecta el banco emisor
 */
function detectBank(text) {
  const upper = text.toUpperCase();
  if (upper.includes("BCR") || upper.includes("COSTA RICA")) return "BCR";
  if (upper.includes("NACIONAL") || upper.includes("BN ")) return "BN";
  if (upper.includes("BAC") || upper.includes("CREDOMATIC")) return "BAC";
  if (upper.includes("SCOTIABANK") || upper.includes("SCOTIA")) return "Scotiabank";
  if (upper.includes("DAVIVIENDA")) return "Davivienda";
  if (upper.includes("PROMERICA")) return "Promerica";
  if (upper.includes("SINPE")) return "SINPE"; // Genérico SINPE Móvil
  return null;
}

/**
 * Extrae fecha del comprobante
 */
function extractDate(text) {
  const patterns = [
    // 21/03/2026 o 21-03-2026
    /(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/g,
    // 2026-03-21
    /(\d{4}-\d{2}-\d{2})/g,
    // 21 de marzo de 2026
    /(\d{1,2}\s+de\s+\w+\s+de\s+\d{4})/gi,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match[1];
  }
  return null;
}

module.exports = { extractPaymentData };
