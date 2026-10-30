import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './domain/schema.ts',
  out: './domain/migrations',
  schemaFilter: ['domain'],
  migrations: { schema: 'domain_migrations', table: '__drizzle_migrations' },
  dbCredentials: { url: process.env.DATABASE_URL! },
});
