// ==============================================
// BUSINESS RULES — Reglas de negocio centralizadas
// Fuente de verdad para el bot, reemplaza hardcodes
// Leído por: contextBuilder, orchestrator, responseFormatter, chatOrder, toolExecutor
// Editado desde: Admin Panel → WhatsApp → Reglas de Negocio
// ==============================================

const { db } = require("../utils");

const RULES_DOC = "whatsapp_config/business_rules";

// ── DEFAULTS (usados si Firestore no tiene config) ──
const DEFAULT_RULES = {
  // ── IDENTIDAD DEL BOT ──
  bot: {
    name: "Pauli",
    role: "asistente de ventas de Aquí Pauli",
    tone: "WhatsApp natural, cálido y profesional, tico/costarricense",
    personality: "Siempre positiva, empática. Usa emojis con moderación.",
    greeting: "¡Hola! Soy Pauli, tu asistente de Aquí Pauli 🛍️",
  },

  // ── PAGOS ──
  payment: {
    methods: [
      { id: "sinpe", label: "SINPE Móvil", number: "7095-6070", enabled: true },
      { id: "transfer", label: "Transferencia Bancaria", iban: "CR15081400011020004961", enabled: true },
      { id: "paypal", label: "PayPal", email: "", enabled: false },
    ],
    currencySymbol: "₡",
    currencyCode: "CRC",
    autoConfirmPayment: false,
    requireProof: true,
    proofMessage: "Enviame el comprobante cuando lo hagás 😊🎉",
  },

  // ── ENVÍOS ──
  shipping: {
    standardCost: 2500,
    freeShippingThreshold: 0, // 0 = nunca gratis
    estimatedDays: "2-5 días hábiles",
    coverage: "Todo Costa Rica",
    notas: "Envío estándar a todo el país. Zonas rurales pueden tardar más.",
  },

  // ── BAJO PEDIDO ──
  bajoPedido: {
    enabled: true,
    depositPercent: 20,
    deliveryEstimate: "15-20 días hábiles",
    requireDeposit: true,
    depositMessage: "Este producto es bajo pedido. Requiere un anticipo del {percent}% (₡{amount}). El saldo se paga al recibir. Entrega estimada: {estimate}.",
    allowWithoutStock: true,
    autoDetect: true, // Detectar automáticamente desde supplyType
  },

  // ── PEDIDOS ──
  orders: {
    prefix: "AP",
    requireAddress: true,
    requireName: true,
    requirePhone: false, // Ya lo tenemos de WhatsApp
    maxItemsPerOrder: 20,
    confirmationRequired: true, // Pedir confirmación antes de crear
    showSummaryBeforeCreate: true,
  },

  // ── CATÁLOGO ──
  catalog: {
    showPricesInChat: true,
    showStockInChat: true,
    maxProductsInMessage: 0, // 0 = nunca listar en texto
    preferCatalogButton: true,
    catalogUrl: "https://wa.me/c/50670956070",
  },

  // ── ESCALAMIENTO ──
  escalation: {
    lowConfidenceThreshold: 0.3,
    maxLowConfidenceStreak: 3,
    maxTurnsBeforeEscalation: 15,
    escalationMessage: "Te voy a conectar con alguien del equipo que te puede ayudar mejor. ¡Ya te contactan! 🙏",
    humanAgentNotification: true,
  },

  // ── HORARIOS ──
  schedule: {
    enabled: false, // Si true, fuera de horario usa autoReply
    timezone: "America/Costa_Rica",
    workingHours: { start: "08:00", end: "18:00" },
    workingDays: [1, 2, 3, 4, 5], // Lunes a Viernes
    outOfHoursMessage: "¡Hola! En este momento estamos fuera de horario. Te responderemos mañana a primera hora. 😊",
  },

  // ── RESTRICCIONES ──
  restrictions: {
    blockedWords: [],
    maxMessageLength: 1000,
    rateLimitPerMinute: 10,
    blockRepeatedMessages: true,
    blockAfterHumanHandoff: true, // No responder bot después de escalar
  },

  // ── MENSAJES DEL SISTEMA ──
  systemMessages: {
    welcome: "¡Hola! Soy Pauli, tu asistente de Aquí Pauli 🛍️ ¿En qué te puedo ayudar hoy?",
    farewell: "¡Gracias por contactarnos! Si necesitás algo más, aquí estamos. 😊💕",
    outOfStock: "Lo siento, ese producto no está disponible en este momento. ¿Te gustaría ver otras opciones?",
    orderCreated: "✅ ¡Pedido confirmado! Tu número de pedido es {orderNumber}.",
    paymentReceived: "✅ ¡Pago recibido y verificado! Tu pedido está en preparación.",
    errorFallback: "Disculpá, tuve un problemita procesando eso. ¿Me podés repetir qué necesitás? 😊",
    productNotFound: "No encontré ese producto en nuestro catálogo. ¿Me podés dar más detalles? 😊",
  },
};

/**
 * Obtener reglas de negocio (Firestore + defaults como fallback)
 * Cache en memoria por 5 minutos para no leer Firestore en cada turno
 */
let _cachedRules = null;
let _cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

async function getBusinessRules() {
  const now = Date.now();
  if (_cachedRules && (now - _cacheTimestamp) < CACHE_TTL) {
    return _cachedRules;
  }

  try {
    const docRef = db.doc(RULES_DOC);
    const snap = await docRef.get();

    if (snap.exists) {
      // Merge Firestore data con defaults (Firestore gana)
      _cachedRules = _deepMerge(DEFAULT_RULES, snap.data());
    } else {
      // No hay documento en Firestore — crear uno con defaults
      console.log("[BusinessRules] No config found, using defaults");
      _cachedRules = { ...DEFAULT_RULES };
      // Guardar defaults en Firestore para que admin pueda editarlos
      await docRef.set(DEFAULT_RULES).catch(() => {});
    }

    _cacheTimestamp = now;
    return _cachedRules;
  } catch (err) {
    console.error("[BusinessRules] Error loading rules:", err.message);
    // En caso de error, usar defaults
    return DEFAULT_RULES;
  }
}

/**
 * Invalidar cache (llamado cuando admin guarda cambios)
 */
function invalidateCache() {
  _cachedRules = null;
  _cacheTimestamp = 0;
}

/**
 * Construir bloque de reglas para el prompt de Gemini
 * Reemplaza las reglas hardcodeadas en contextBuilder.js
 */
async function getRulesForPrompt() {
  const rules = await getBusinessRules();
  const paymentMethods = rules.payment.methods
    .filter(m => m.enabled)
    .map(m => {
      if (m.id === "sinpe") return `SINPE Móvil ${m.number}`;
      if (m.id === "transfer") return `IBAN: ${m.iban}`;
      if (m.id === "paypal") return `PayPal: ${m.email}`;
      return m.label;
    })
    .join(" / ");

  let prompt = `[REGLAS DE NEGOCIO — FUENTE DE VERDAD]
- Tu nombre: ${rules.bot.name}
- Tu rol: ${rules.bot.role}
- Tono: ${rules.bot.tone}
- ${rules.bot.personality}

[MÉTODOS DE PAGO]
- ${paymentMethods}
- Moneda: ${rules.payment.currencySymbol} (${rules.payment.currencyCode})
- ${rules.payment.requireProof ? "SIEMPRE pedir comprobante de pago" : "No es necesario pedir comprobante"}
- NUNCA confirmes pagos — solo el sistema puede confirmar pagos.

[ENVÍOS]
- Costo estándar: ${rules.payment.currencySymbol}${rules.shipping.standardCost.toLocaleString()}
- Cobertura: ${rules.shipping.coverage}
- Tiempo estimado: ${rules.shipping.estimatedDays}
${rules.shipping.freeShippingThreshold > 0 ? `- Envío gratis en pedidos mayores a ${rules.payment.currencySymbol}${rules.shipping.freeShippingThreshold.toLocaleString()}` : ""}

[BAJO PEDIDO]
${rules.bajoPedido.enabled ? `- Si un producto es "bajo_pedido": anticipo del ${rules.bajoPedido.depositPercent}% del subtotal.
- Entrega estimada: ${rules.bajoPedido.deliveryEstimate}
- SIEMPRE informar al cliente ANTES de confirmar: anticipo requerido, monto, plazo de entrega.
- El sistema calcula el monto de anticipo y saldo automáticamente.` : "- Productos bajo pedido: DESHABILITADO. No aceptar pedidos bajo pedido."}

[REGLAS DE CATÁLOGO]
${rules.catalog.maxProductsInMessage === 0 ? "- NUNCA listes productos como texto plano. Usá el botón de catálogo." : `- Máximo ${rules.catalog.maxProductsInMessage} productos por mensaje.`}
- ${rules.catalog.preferCatalogButton ? "Invitá al cliente a usar el botón 'Ver Catálogo'" : "Podés mencionar productos en el texto"}
- ${rules.catalog.showPricesInChat ? "SÍ mostrar precios cuando mencionés un producto" : "NO mostrar precios en chat"}

[PEDIDOS]
- Prefijo: ${rules.orders.prefix}-XXXXXX
- ${rules.orders.requireAddress ? "SIEMPRE pedir dirección de envío" : "Dirección opcional"}
- ${rules.orders.requireName ? "SIEMPRE pedir nombre del cliente" : "Nombre opcional"}
- NUNCA pedir teléfono (ya lo tenemos de WhatsApp)
- ${rules.orders.confirmationRequired ? "Mostrar resumen y PEDIR CONFIRMACIÓN antes de crear el pedido" : "Crear pedido sin confirmación explícita"}

[ESCALAMIENTO]
- Si no podés resolver después de ${rules.escalation.maxLowConfidenceStreak} intentos, escalar a humano
- Mensaje de escalamiento: "${rules.escalation.escalationMessage}"`;

  if (rules.schedule.enabled) {
    prompt += `\n\n[HORARIO]
- Horario de atención: ${rules.schedule.workingHours.start} - ${rules.schedule.workingHours.end}
- Fuera de horario: "${rules.schedule.outOfHoursMessage}"`;
  }

  return prompt;
}

/**
 * Deep merge helper (b overwrites a)
 */
function _deepMerge(a, b) {
  const result = { ...a };
  for (const key of Object.keys(b)) {
    if (b[key] && typeof b[key] === "object" && !Array.isArray(b[key]) && a[key]) {
      result[key] = _deepMerge(a[key], b[key]);
    } else {
      result[key] = b[key];
    }
  }
  return result;
}

module.exports = {
  getBusinessRules,
  getRulesForPrompt,
  invalidateCache,
  DEFAULT_RULES,
};
