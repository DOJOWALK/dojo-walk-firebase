import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const email = process.argv[2]?.trim();
if (!email || !email.includes('@')) {
  console.error('Usage: npm run set-admin-claim -- admin@example.com');
  process.exit(1);
}
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error('Set GOOGLE_APPLICATION_CREDENTIALS to a trusted service-account JSON file path.');
  process.exit(1);
}

initializeApp({
  credential: applicationDefault(),
  projectId: 'dojo-platform-b68a3',
});

const auth = getAuth();
const user = await auth.getUserByEmail(email);
await auth.setCustomUserClaims(user.uid, {
  ...user.customClaims,
  admin: true,
});
console.log('Admin claim assigned to:', user.email, 'UID:', user.uid);
console.log('The user must sign out and sign in again (or refresh the ID token) before the claim appears.');
