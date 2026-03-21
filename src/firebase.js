// --- CONFIGURACIÓN DE FIREBASE (aqui-pauli) ---
import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getFunctions } from 'firebase/functions';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
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
export const db = getFirestore(app);
export const functions = getFunctions(app);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
export const storage = getStorage(app);
