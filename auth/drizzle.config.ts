import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './auth/schema.ts',
  out: './auth/migrations',
  schemaFilter: ['auth'],
  migrations: { schema: 'auth_migrations', table: '__drizzle_migrations' },
  dbCredentials: { url: process.env.AUTH_DATABASE_URL! },
});
