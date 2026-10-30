// --- CONFIGURACIÓN DE FIREBASE (aqui-pauli) ---
import { initializeApp } from 'firebase/app';
import { initializeFirestore } from 'firebase/firestore';
import { getFunctions } from 'firebase/functions';
import { getAuth, GoogleAuthProvider, FacebookAuthProvider } from 'firebase/auth';
import { getStorage } from 'firebase/storage';

const firebaseConfig = {
  apiKey: "AIzaSyCH_Lv64Iy6SGeqgk8WFLwMbUuRCSPMyAU",
  authDomain: "aqui-pauli.firebaseapp.com",
  projectId: "aqui-pauli",
  storageBucket: "aqui-pauli.firebasestorage.app",
  messagingSenderId: "1030890568878",
  appId: "1:1030890568878:web:5a45a76ef0ef611d23c13f",
  measurementId: "G-16HVYX5B9J"
};

const app = initializeApp(firebaseConfig);
// Detecta automáticamente redes/proxies que bloquean el streaming (WebChannel) y cae a long polling
export const db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
export const functions = getFunctions(app);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
// Facebook Login habilitado; config/auth.facebookEnabled=false oculta el botón.
export const facebookProvider = new FacebookAuthProvider();
facebookProvider.addScope('email');
facebookProvider.addScope('public_profile');
export const storage = getStorage(app);
