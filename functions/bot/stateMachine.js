// ==============================================
// MÁQUINA DE ESTADOS CONVERSACIONAL
// Define etapas, transiciones válidas y prompts por etapa
// ==============================================

const STAGES = {
  greeting: {
    label: "Saludo",
    description: "Primer contacto, saludar e invitar a ver el catálogo",
    allowedTools: ["getCustomerProfile", "getProductBySku", "getProductCatalog"],
    requiredEntities: [],
    prompt: "El cliente acaba de saludar. Presentate como Pauli, saludá con calidez. NO listes productos en texto. Invitá al cliente a explorar nuestro catálogo usando el botón que el sistema le va a mostrar. Preguntá si busca algo en especial.",
    uiConfig: {
      buttonsEnabled: true,
      buttonMode: "fixed", // "fixed" | "ai" | "hybrid" | "off"
      fixedButtons: [
        { id: "order_web", title: "Pedir en Web 🌐" },
        { id: "view_catalog", title: "Ver Catálogo 📋" },
      ],
      catalogEnabled: true,
      allowFreeText: true,
      humanEscalationEnabled: true,
    },
    fallbackBehavior: "contextual", // "contextual" | "escalate" | "retry"
    autoAdvanceOn: {
      intents: ["product_inquiry", "price_check", "purchase"],
      targetStage: "discovery",
    },
  },
  discovery: {
    label: "Exploración",
    description: "Cliente está explorando, preguntando por categorías o productos",
    allowedTools: ["getProductCatalog", "getProductBySku", "checkStock", "getCustomerProfile"],
    requiredEntities: [],
    prompt: "El cliente está explorando productos. Si pregunta por algo específico, usá getProductBySku o getProductCatalog para buscar. Si no tiene algo específico, invitalo a ver el catálogo con el botón. NO listes productos como texto plano.",
    uiConfig: {
      buttonsEnabled: true,
      buttonMode: "hybrid",
      fixedButtons: [
        { id: "order_web", title: "Pedir en Web 🌐" },
        { id: "view_catalog", title: "Ver Catálogo 📋" },
      ],
      catalogEnabled: true,
      allowFreeText: true,
      humanEscalationEnabled: true,
    },
    fallbackBehavior: "contextual",
    autoAdvanceOn: {
      hasEntity: "selectedProduct",
      targetStage: "product_selection",
    },
  },
  product_selection: {
    label: "Selección de producto",
    description: "Cliente mostró interés en un producto específico",
    allowedTools: ["getProductBySku", "checkStock", "getCustomerProfile"],
    requiredEntities: ["selectedProduct"],
    prompt: "El cliente mostró interés en un producto. Confirmá precio, disponibilidad y variantes. Preguntá talla/color/cantidad si aplica.",
    uiConfig: {
      buttonsEnabled: true,
      buttonMode: "hybrid",
      fixedButtons: [],
      catalogEnabled: true,
      allowFreeText: true,
      humanEscalationEnabled: true,
    },
    fallbackBehavior: "contextual",
    autoAdvanceOn: {
      hasEntity: "selectedVariant",
      targetStage: "variant_selection",
    },
  },
  variant_selection: {
    label: "Selección de variante",
    description: "Cliente necesita elegir talla, color u otra variante",
    allowedTools: ["getProductBySku", "checkStock"],
    requiredEntities: ["selectedProduct", "selectedVariant"],
    prompt: "El cliente necesita elegir variante (talla/color). Mostrá las opciones disponibles con stock real.",
    uiConfig: {
      buttonsEnabled: true,
      buttonMode: "hybrid",
      fixedButtons: [],
      catalogEnabled: false,
      allowFreeText: true,
      humanEscalationEnabled: true,
    },
    fallbackBehavior: "contextual",
    autoAdvanceOn: null,
  },
  address_capture: {
    label: "Captura de dirección",
    description: "Se necesita la dirección de envío",
    allowedTools: ["getCustomerProfile", "saveCustomerAddress"],
    requiredEntities: ["selectedProduct", "address"],
    prompt: "Ya tenemos producto seleccionado. Para la dirección de envío seguí este flujo paso a paso: 1) Si el cliente ya tiene dirección guardada, preguntá si desea usarla. 2) Si no, pedí PRIMERO la provincia. 3) Luego el cantón. 4) Luego el distrito. 5) Luego las señas exactas (texto libre). 6) Al final confirmá la dirección completa. El sistema genera las listas interactivas automáticamente — NO las listes en texto. Solo hacé UNA pregunta por turno.",
    uiConfig: {
      buttonsEnabled: true,
      buttonMode: "hybrid",
      fixedButtons: [],
      catalogEnabled: false,
      allowFreeText: true,
      humanEscalationEnabled: true,
    },
    fallbackBehavior: "contextual",
    autoAdvanceOn: {
      hasEntity: "address",
      targetStage: "delivery_validation",
    },
  },
  delivery_validation: {
    label: "Validación de entrega",
    description: "Confirmar que la dirección tiene cobertura",
    allowedTools: ["getCustomerProfile"],
    requiredEntities: ["selectedProduct", "address"],
    prompt: "Tenemos dirección. Confirmá datos de envío (₡2,500 estándar a todo Costa Rica). Mostrá resumen del pedido y preguntá si procede.",
    uiConfig: {
      buttonsEnabled: true,
      buttonMode: "fixed",
      fixedButtons: [
        { id: "confirm_yes", title: "✅ Sí, confirmar" },
        { id: "confirm_no", title: "❌ No, cambiar" },
      ],
      catalogEnabled: false,
      allowFreeText: true,
      humanEscalationEnabled: true,
    },
    fallbackBehavior: "contextual",
    autoAdvanceOn: null,
  },
  payment_pending: {
    label: "Pendiente de pago",
    description: "Pedido creado, esperando comprobante",
    allowedTools: ["getOrderStatus"],
    requiredEntities: ["orderNumber"],
    prompt: "El pedido ya fue creado. El cliente necesita hacer el pago. Recordá los métodos: SINPE 7095-6070 / IBAN CR15081400011020004961. Pedí el comprobante.",
    uiConfig: {
      buttonsEnabled: true,
      buttonMode: "fixed",
      fixedButtons: [
        { id: "pay_sinpe", title: "📱 SINPE Móvil" },
        { id: "pay_transfer", title: "🏦 Transferencia" },
      ],
      catalogEnabled: false,
      allowFreeText: true,
      humanEscalationEnabled: true,
    },
    fallbackBehavior: "contextual",
    autoAdvanceOn: null,
  },
  payment_verification: {
    label: "Verificación de pago",
    description: "Comprobante recibido, verificando",
    allowedTools: ["getOrderStatus"],
    requiredEntities: ["orderNumber"],
    prompt: "El comprobante fue recibido y está siendo verificado. Informá al cliente que el equipo lo está revisando.",
    uiConfig: {
      buttonsEnabled: false,
      buttonMode: "off",
      fixedButtons: [],
      catalogEnabled: false,
      allowFreeText: true,
      humanEscalationEnabled: true,
    },
    fallbackBehavior: "contextual",
    autoAdvanceOn: null,
  },
  order_confirmation: {
    label: "Orden confirmada",
    description: "Pedido confirmado y pagado",
    allowedTools: ["getOrderStatus"],
    requiredEntities: ["orderNumber"],
    prompt: "El pedido está confirmado y pagado. Agradecé al cliente, dale el número de pedido y ofrecé ayuda adicional.",
    uiConfig: {
      buttonsEnabled: true,
      buttonMode: "fixed",
      fixedButtons: [
        { id: "order_web", title: "Pedir en Web 🌐" },
        { id: "view_catalog", title: "Ver Catálogo 📋" },
      ],
      catalogEnabled: true,
      allowFreeText: true,
      humanEscalationEnabled: false,
    },
    fallbackBehavior: "contextual",
    autoAdvanceOn: null,
  },
  handoff_human: {
    label: "Escalamiento a humano",
    description: "Se requiere atención humana",
    allowedTools: ["handoffToHuman"],
    requiredEntities: [],
    prompt: "No es posible resolver automáticamente. Informá al cliente que alguien del equipo lo va a contactar pronto.",
    uiConfig: {
      buttonsEnabled: false,
      buttonMode: "off",
      fixedButtons: [],
      catalogEnabled: false,
      allowFreeText: false,
      humanEscalationEnabled: false,
    },
    fallbackBehavior: "escalate",
    autoAdvanceOn: null,
  },
  closed: {
    label: "Cerrada",
    description: "Conversación finalizada",
    allowedTools: [],
    requiredEntities: [],
    prompt: "La conversación está cerrada. Si el cliente escribe de nuevo, tratá como nueva conversación.",
    uiConfig: {
      buttonsEnabled: false,
      buttonMode: "off",
      fixedButtons: [],
      catalogEnabled: false,
      allowFreeText: true,
      humanEscalationEnabled: false,
    },
    fallbackBehavior: "contextual",
    autoAdvanceOn: null,
  },
};

// Transiciones válidas: desde → [posibles destinos]
const TRANSITIONS = {
  greeting: ["discovery", "product_selection", "variant_selection", "address_capture", "delivery_validation", "handoff_human"],
  discovery: ["product_selection", "variant_selection", "address_capture", "payment_pending", "handoff_human", "greeting"],
  product_selection: ["variant_selection", "address_capture", "delivery_validation", "discovery", "handoff_human"],
  variant_selection: ["address_capture", "delivery_validation", "product_selection", "handoff_human"],
  address_capture: ["delivery_validation", "payment_pending", "variant_selection", "handoff_human"],
  delivery_validation: ["payment_pending", "address_capture", "handoff_human"],
  payment_pending: ["payment_verification", "order_confirmation", "handoff_human"],
  payment_verification: ["order_confirmation", "payment_pending", "handoff_human"],
  order_confirmation: ["discovery", "closed", "handoff_human"],
  handoff_human: ["greeting", "discovery", "closed"],
  closed: ["greeting"],
};

/**
 * Obtener las transiciones válidas desde una etapa
 */
function getValidTransitions(stage) {
  return TRANSITIONS[stage] || ["greeting"];
}

/**
 * Verificar si una transición es válida
 */
function canTransition(fromStage, toStage) {
  const valid = TRANSITIONS[fromStage] || [];
  return valid.includes(toStage);
}

/**
 * Obtener la configuración de una etapa
 */
function getStageConfig(stage) {
  return STAGES[stage] || STAGES.greeting;
}

/**
 * Obtener el prompt específico de la etapa
 */
function getStagePrompt(stage) {
  const config = STAGES[stage];
  return config ? config.prompt : STAGES.greeting.prompt;
}

/**
 * Obtener herramientas permitidas en una etapa
 */
function getAllowedTools(stage) {
  const config = STAGES[stage];
  return config ? config.allowedTools : [];
}

/**
 * Obtener todas las etapas como lista para el prompt
 */
function getStagesForPrompt() {
  return Object.entries(STAGES)
    .map(([key, val]) => `- ${key}: ${val.label} — ${val.description}`)
    .join("\n");
}

/**
 * Determinar etapa inicial basado en si es cliente nuevo o recurrente
 */
function getInitialStage(hasHistory) {
  return hasHistory ? "discovery" : "greeting";
}

/**
 * Obtener la configuración de UI de una etapa
 */
function getStageUIConfig(stage) {
  const config = STAGES[stage];
  return config ? config.uiConfig : STAGES.greeting.uiConfig;
}

/**
 * Obtener el comportamiento de fallback de una etapa
 */
function getStageFallbackBehavior(stage) {
  const config = STAGES[stage];
  return config ? config.fallbackBehavior : "contextual";
}

/**
 * Verificar si se debe auto-avanzar la etapa basándose en intent o entidades
 * @returns {string|null} — la etapa destino si debe avanzar, null si no
 */
function getAutoAdvanceTarget(stage, intent, entities) {
  const config = STAGES[stage];
  if (!config || !config.autoAdvanceOn) return null;

  const rule = config.autoAdvanceOn;

  // Regla por intent
  if (rule.intents && rule.intents.includes(intent)) {
    return rule.targetStage;
  }

  // Regla por entidad presente
  if (rule.hasEntity && entities && entities[rule.hasEntity]) {
    return rule.targetStage;
  }

  return null;
}

/**
 * Verificar si una tool está permitida en una etapa
 */
function isToolAllowed(stage, toolName) {
  const config = STAGES[stage];
  if (!config) return false;
  return config.allowedTools.includes(toolName);
}

module.exports = {
  STAGES,
  TRANSITIONS,
  getValidTransitions,
  canTransition,
  getStageConfig,
  getStagePrompt,
  getAllowedTools,
  getStagesForPrompt,
  getInitialStage,
  getStageUIConfig,
  getStageFallbackBehavior,
  getAutoAdvanceTarget,
  isToolAllowed,
};
