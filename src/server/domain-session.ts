import { createServerOnlyFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { eq } from 'drizzle-orm';
import { getAuth } from './auth';
import { getServerDb } from '~/config/db';
import { users } from '../../domain/schema';

/** Fail closed: only a validated, live database session can provision a domain profile. */
export const requireDomainUser = createServerOnlyFn(async (request: Request | undefined = getRequest()) => {
  if (!request) throw new Response('Authentication required', { status: 401 });
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) throw new Response('Authentication required', { status: 401 });

  const { id, name, email } = session.user;
  try {
    const profile = await provisionProfile(id, name, email);
    return { userId: profile.id };
  } catch {
    throw new Response('Profile unavailable; retry the request', { status: 503 });
  }
});

async function provisionProfile(id: string, userName: string, email: string) {
  const db = getServerDb();
  try {
    const inserted = await db.insert(users).values({ id, userName, email }).onConflictDoNothing().returning();
    if (inserted[0]) return inserted[0];
    const [existing] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!existing) throw new Error('Profile missing after conflict');
    return existing;
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const [existing] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!existing) throw error;
    return existing;
  }
}

function isUniqueConstraintError(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
