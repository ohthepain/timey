import { serverOnly } from '@tanstack/react-start';

// Dynamic import keeps auth configuration and database drivers out of browser bundles.
export const getAuth = serverOnly(async () => {
  const runtime = await import('./auth-runtime/auth');
  return runtime.authInstance();
});
