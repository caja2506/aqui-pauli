// --- Roles ---
export const ROLES = {
  ADMIN: 'admin',
  CLIENTE: 'cliente',
};

// --- Estados de pedido ---
export const ORDER_STATUS = {
  PENDIENTE_PAGO: 'pendiente_pago',
  REVISION_MANUAL: 'revision_manual',
  PAGADO: 'pagado',
  POR_PREPARAR: 'por_preparar',
  PREPARANDO: 'preparando',
  ENVIADO: 'enviado',
  ENTREGADO: 'entregado',
  CANCELADO: 'cancelado',
};

export const ORDER_STATUS_LABELS = {
  pendiente_pago: 'Pendiente de Pago',
  revision_manual: 'Revisión Manual',
  pagado: 'Pagado',
  por_preparar: 'Por Preparar',
  preparando: 'Preparando',
  enviado: 'Enviado',
  entregado: 'Entregado',
  cancelado: 'Cancelado',
};

export const ORDER_STATUS_COLORS = {
  pendiente_pago: { bg: 'bg-yellow-100', text: 'text-yellow-700', border: 'border-yellow-200' },
  revision_manual: { bg: 'bg-orange-100', text: 'text-orange-700', border: 'border-orange-200' },
  pagado: { bg: 'bg-green-100', text: 'text-green-700', border: 'border-green-200' },
  por_preparar: { bg: 'bg-blue-100', text: 'text-blue-700', border: 'border-blue-200' },
  preparando: { bg: 'bg-indigo-100', text: 'text-indigo-700', border: 'border-indigo-200' },
  enviado: { bg: 'bg-purple-100', text: 'text-purple-700', border: 'border-purple-200' },
  entregado: { bg: 'bg-emerald-100', text: 'text-emerald-700', border: 'border-emerald-200' },
  cancelado: { bg: 'bg-red-100', text: 'text-red-700', border: 'border-red-200' },
};

// --- Estados de pago ---
export const PAYMENT_STATUS = {
  PENDIENTE: 'pendiente',
  VERIFICANDO: 'verificando',
  PAGADO: 'pagado',
  RECHAZADO: 'rechazado',
};

// --- Métodos de pago ---
export const PAYMENT_METHODS = {
  PAYPAL: 'paypal',
  SINPE: 'sinpe',
  TRANSFERENCIA: 'transferencia',
};

export const PAYMENT_METHOD_LABELS = {
  paypal: 'PayPal',
  sinpe: 'SINPE Móvil',
  transferencia: 'Transferencia Bancaria',
};

// --- Estados comerciales de variante ---
export const COMMERCIAL_STATUS = {
  DISPONIBLE: 'disponible',
  AGOTADO: 'agotado',
  BAJO_PEDIDO: 'bajo_pedido',
};

export const COMMERCIAL_STATUS_LABELS = {
  disponible: 'Disponible',
  agotado: 'Agotado',
  bajo_pedido: 'Bajo Pedido',
};

// --- Tipos de abastecimiento ---
export const SUPPLY_TYPES = {
  STOCK_PROPIO: 'stock_propio',
  BAJO_PEDIDO: 'bajo_pedido',
};

// --- Envío ---
export const SHIPPING_TYPES = {
  NORMAL: 'normal',
  EXPRESS: 'express',
};

// --- Etapas del embudo CRM ---
export const CRM_FUNNEL_STAGES = [
  { key: 'visitante', label: 'Visitante', color: 'slate' },
  { key: 'interesado', label: 'Interesado', color: 'blue' },
  { key: 'carrito', label: 'Carrito', color: 'amber' },
  { key: 'comprador', label: 'Comprador', color: 'green' },
  { key: 'recurrente', label: 'Recurrente', color: 'purple' },
  { key: 'inactivo', label: 'Inactivo', color: 'red' },
];

// --- Anticipo bajo pedido ---
export const BACKORDER_DEPOSIT_PERCENT = 0.20;

// --- Provincias de Costa Rica ---
export const PROVINCIAS = [
  'San José', 'Alajuela', 'Cartago', 'Heredia', 'Guanacaste', 'Puntarenas', 'Limón'
];

// --- Cantones del GAM (Gran Área Metropolitana) ---
// Lista simplificada — se usa para determinar si cobra tarifa GAM o fuera del GAM
export const GAM_CANTONES = [
  // San José
  'San José', 'Escazú', 'Desamparados', 'Goicoechea', 'Alajuelita',
  'Vásquez de Coronado', 'Tibás', 'Moravia', 'Montes de Oca', 'Curridabat',
  'Santa Ana',
  // Alajuela
  'Alajuela', 'Atenas', 'Poás', 'Grecia',
  // Cartago
  'Cartago', 'Paraíso', 'La Unión', 'Oreamuno', 'El Guarco', 'Alvarado',
  // Heredia
  'Heredia', 'Barva', 'Santo Domingo', 'Santa Bárbara', 'San Rafael',
  'San Isidro', 'Belén', 'Flores', 'San Pablo',
];

// --- Express solo para Grecia ---
export const EXPRESS_CANTONES = ['Grecia'];

// --- Carrier por defecto ---
export const DEFAULT_CARRIER = 'Correos de Costa Rica';
export const CORREOS_CR_TRACKING_URL = 'https://www.correos.go.cr/rastreo/';
