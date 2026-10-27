import { createAuthClient } from 'better-auth/react';
import { usernameClient } from 'better-auth/client/plugins';

const baseURL = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';

export const authClient = createAuthClient({
  baseURL,
  basePath: '/api/auth',
  plugins: [usernameClient()],
  fetchOptions: { credentials: 'include' },
});

export const { useSession } = authClient;

export async function signOut(...args: Parameters<typeof authClient.signOut>) {
  return authClient.signOut(...args);
}
