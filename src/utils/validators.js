/**
 * Valida email
 */
export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Valida teléfono costarricense (8 dígitos)
 */
export function isValidPhone(phone) {
  const clean = phone.replace(/[\s\-\(\)]/g, '');
  return /^\+?506?\d{8}$/.test(clean) || /^\d{8}$/.test(clean);
}

/**
 * Valida que la dirección de checkout esté completa
 */
export function validateAddress(address) {
  const errors = {};
  if (!address.provincia) errors.provincia = 'Selecciona una provincia';
  if (!address.canton) errors.canton = 'Selecciona un cantón';
  if (!address.distrito) errors.distrito = 'Selecciona un distrito';
  if (!address.señas || address.señas.trim().length < 10) {
    errors.señas = 'Agrega señas más detalladas (mínimo 10 caracteres)';
  }
  return errors;
}

/**
 * Valida datos de checkout
 */
export function validateCheckout({ name, email, phone, address, paymentMethod }) {
  const errors = {};

  if (!name || name.trim().length < 2) errors.name = 'Nombre requerido';
  if (!email || !isValidEmail(email)) errors.email = 'Email válido requerido';
  if (!phone || !isValidPhone(phone)) errors.phone = 'Teléfono válido de 8 dígitos';
  if (!paymentMethod) errors.paymentMethod = 'Selecciona un método de pago';

  const addressErrors = validateAddress(address || {});
  if (Object.keys(addressErrors).length > 0) {
    errors.address = addressErrors;
  }

  return errors;
}
