import { serverOnly } from '@tanstack/react-start';
import { getWebRequest } from '@tanstack/react-start/server';
import { getAuth } from './auth';
import { getServerPrisma } from '~/config/db';

/** Fail closed: only a validated, live database session can provision a domain profile. */
export const requireDomainUser = serverOnly(async (request: Request | undefined = getWebRequest()) => {
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
  const prisma = getServerPrisma();
  try {
    // No shared transaction with Drizzle. Preserve domain state on every retry.
    return await prisma.user.upsert({ where: { id }, create: { id, userName, email }, update: {} });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    // Empty-update upserts may race. Recover only the identical trusted ID;
    // an email collision with another identity still fails closed.
    return prisma.user.findUniqueOrThrow({ where: { id } });
  }
}

function isUniqueConstraintError(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
