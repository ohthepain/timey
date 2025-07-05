import { prisma, safeQuery } from '~/config/db';
import { getKeycloakUser, KeycloakUser } from './keycloakAuth';

// Ensure Keycloak users exist in our database.
// This function checks if the user exists in our database and if not, creates a new user in our database.
export const ensureKeycloakUser = async (token?: string): Promise<string | null> => {
  try {
    const keycloakUser = await getKeycloakUser(token);

    if (!keycloakUser) {
      return null;
    }

    // Check if the user already exists in the database by Keycloak ID
    const existingUser = await safeQuery(() => prisma.user.findUnique({ where: { keycloakId: keycloakUser.id } }));

    if (existingUser) {
      return existingUser.id; // Return the Prisma user ID, not the Keycloak ID
    }

    // Create the user in the database with info from Keycloak
    const newUser = await safeQuery(() =>
      prisma.user.create({
        data: {
          keycloakId: keycloakUser.id, // Store Keycloak ID separately
          email: keycloakUser.email || '',
          userName: keycloakUser.userName || keycloakUser.username || 'User',
        },
      })
    );

    return newUser.id; // Return the Prisma user ID
  } catch (error) {
    console.error('Error ensuring Keycloak user:', error);
    return null;
  }
};

export const requireKeycloakUser = async (): Promise<string> => {
  const userId = await ensureKeycloakUser();
  if (!userId) {
    throw new Error('Authentication required');
  }
  return userId;
};
