import { sendPasswordResetEmail } from 'firebase/auth';
import { auth } from '../firebase';

export const PASSWORD_RESET_SUCCESS = 'Si existe una cuenta con ese correo, recibirás un enlace para restablecer tu contraseña. Revisá también la carpeta de spam.';

export async function requestPasswordReset(email) {
  const normalizedEmail = typeof email === 'string' ? email.trim() : '';
  if (normalizedEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw Object.assign(new Error('Ingresá un correo electrónico válido.'), { code: 'auth/invalid-email' });
  }
  auth.languageCode = 'es';
  try {
    // Firebase administra el enlace y el formulario para elegir la contraseña.
    // No consultamos si existe la cuenta ni guardamos correos o contraseñas.
    await sendPasswordResetEmail(auth, normalizedEmail);
  } catch (error) {
    // Conserva la respuesta neutra también en proyectos sin protección de
    // enumeración activada. Los errores operativos sí permiten reintentar.
    if (error?.code !== 'auth/user-not-found' && error?.code !== 'auth/user-disabled') throw error;
  }
}

export function passwordResetErrorMessage(error) {
  switch (error?.code) {
    case 'auth/invalid-email':
    case 'auth/missing-email':
      return 'Ingresá un correo electrónico válido.';
    case 'auth/too-many-requests':
      return 'Se hicieron demasiados intentos. Esperá unos minutos e intentá de nuevo.';
    case 'auth/network-request-failed':
      return 'No pudimos conectarnos. Revisá tu conexión e intentá de nuevo.';
    default:
      return 'No pudimos enviar el enlace. Intentá de nuevo en unos minutos.';
  }
}
