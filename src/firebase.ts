import { FirebaseError, initializeApp } from 'firebase/app';
import { initializeAuth, inMemoryPersistence } from 'firebase/auth';
import type { Auth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import type { Firestore } from 'firebase/firestore';

const values = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY?.trim(),
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN?.trim(),
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID?.trim(),
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET?.trim(),
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID?.trim(),
  appId: import.meta.env.VITE_FIREBASE_APP_ID?.trim(),
};

function connect(): { auth: Auth | null; db: Firestore | null; setupError?: string } {
  if (!values.apiKey || !values.projectId || !values.appId) {
    return { auth: null, db: null };
  }

  try {
    const app = initializeApp(values);
    const auth = initializeAuth(app, { persistence: inMemoryPersistence });
    return { auth, db: getFirestore(app) };
  } catch {
    return { auth: null, db: null, setupError: 'Firebase could not start. Check the web app values in .env.local and restart the app.' };
  }
}

export const { auth, db, setupError } = connect();

export function signInMessage(error: unknown): string {
  if (error instanceof FirebaseError) {
    switch (error.code) {
      case 'auth/network-request-failed':
        return 'Could not reach Firebase. Check your internet connection and try again.';
      case 'auth/too-many-requests':
        return 'Too many sign-in attempts. Wait and try again.';
      case 'auth/operation-not-allowed':
        return 'Enable Email/Password sign-in in Firebase Authentication and try again.';
      case 'auth/invalid-api-key':
      case 'auth/app-not-authorized':
        return 'Firebase rejected the app configuration. Check the web app settings and API key restrictions.';
      case 'auth/user-disabled':
        return 'This account is disabled in Firebase Authentication.';
    }
  }
  return 'Sign-in failed. Check your email and password.';
}
