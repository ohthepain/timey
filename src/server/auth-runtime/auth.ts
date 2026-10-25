import { betterAuth } from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { username } from 'better-auth/plugins';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { z } from 'zod';
import * as schema from '../../../auth/schema';
import { passwordResetDelivery } from './mail';

let instance: ReturnType<typeof createAuth> | undefined;

function createAuth() {
  const config = z
    .object({
      AUTH_DATABASE_URL: z.url(),
      BETTER_AUTH_SECRET: z.string().min(32),
      BETTER_AUTH_URL: z.url(),
    })
    .parse(process.env);
  const url = authOrigin(config.BETTER_AUTH_URL);
  const pool = new pg.Pool({ connectionString: config.AUTH_DATABASE_URL });
  return betterAuth({
    secret: config.BETTER_AUTH_SECRET,
    baseURL: url.origin,
    trustedOrigins: [url.origin],
    database: drizzleAdapter(drizzle({ client: pool }), { provider: 'pg', schema }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: passwordResetDelivery(),
    },
    session: { cookieCache: { enabled: false } },
    plugins: [username()],
  });
}

/** Loaded only through the framework's server-only facade; never accepts client configuration. */
export function authInstance() {
  instance ??= createAuth();
  return instance;
}

function authOrigin(value: string) {
  const url = new URL(value);
  if (value.replace(/\/$/, '') !== url.origin) throw new Error('BETTER_AUTH_URL must be an origin');
  const allowedProtocols = ['https:'];
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) allowedProtocols.push('http:');
  if (!allowedProtocols.includes(url.protocol)) throw new Error('Authentication requires HTTPS outside loopback');
  return url;
}
