// ==============================================
// Transcriptor de Audio — Gemini Multimodal
// Convierte notas de voz de WhatsApp a texto
// ==============================================
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { defineSecret } = require("firebase-functions/params");

const geminiApiKey = defineSecret("GEMINI_API_KEY");

/**
 * Transcribe un buffer de audio usando Gemini multimodal.
 * WhatsApp envía OGG/Opus — Gemini lo soporta nativamente.
 *
 * @param {Buffer} audioBuffer - Audio descargado de WhatsApp
 * @param {string} mimeType - MIME type del audio (ej: "audio/ogg")
 * @returns {string} Texto transcrito
 */
async function transcribeAudio(audioBuffer, mimeType = "audio/ogg") {
  const apiKey = geminiApiKey.value();
  if (!apiKey) {
    console.warn("[AudioTranscriber] No GEMINI_API_KEY, skipping transcription");
    return null;
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash-lite",
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 1024,
      },
    });

    const audioBase64 = audioBuffer.toString("base64");

    const result = await model.generateContent([
      {
        inlineData: {
          mimeType,
          data: audioBase64,
        },
      },
      {
        text: "Transcribí este audio de WhatsApp al español. Devolvé SOLO el texto hablado, sin marcas de tiempo, sin comentarios, sin formato extra. Si no se entiende algo, escribí [inaudible]. Si el audio está vacío o es solo ruido, respondé '[audio vacío]'.",
      },
    ]);

    const transcription = result.response.text().trim();

    if (!transcription || transcription.length < 2) {
      console.log("[AudioTranscriber] Transcripción vacía");
      return null;
    }

    console.log(`[AudioTranscriber] Transcrito (${transcription.length} chars): "${transcription.substring(0, 100)}..."`);
    return transcription;
  } catch (err) {
    console.error("[AudioTranscriber] Error:", err.message);
    return null;
  }
}

module.exports = { transcribeAudio, geminiApiKey: geminiApiKey };
