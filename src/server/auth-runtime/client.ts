import { createAuthClient } from 'better-auth/react';
import { usernameClient } from 'better-auth/client/plugins';

// Same-origin browser client only. No server configuration is imported here.
export const authClient = createAuthClient({ plugins: [usernameClient()] });
