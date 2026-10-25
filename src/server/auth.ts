import { serverOnly } from '@tanstack/react-start';

// Dynamic import keeps secrets, database drivers and Zod 4 out of browser bundles.
export const getAuth = serverOnly(async () => {
  const runtime = await import('./auth-runtime/auth');
  return runtime.authInstance();
});
