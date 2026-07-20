import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: 'AIzaSyBXlf0tidwgnJemq_xHL0Pus14LokQK2cw',
  authDomain: 'iiit-surat-app-6643d.firebaseapp.com',
  projectId: 'iiit-surat-app-6643d',
  storageBucket: 'iiit-surat-app-6643d.firebasestorage.app',
  messagingSenderId: '568691830636',
  appId: '1:568691830636:web:4be7fd34f4098d1d994d49',
};

const firebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);

export const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp);