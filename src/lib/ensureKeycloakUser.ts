import { prisma, safeQuery } from '~/config/db';
import { getKeycloakUser, KeycloakUser } from './keycloakAuth';

// Ensure Keycloak users exist in our database.
// This function checks if the user exists in our database and if not, creates a new user in our database.
export const ensureKeycloakUser = async (): Promise<string | null> => {
  try {
    const keycloakUser = await getKeycloakUser();
    if (!keycloakUser) {
      console.log('ensureKeycloakUser: User is not authenticated');
      return null;
    }

    // Check if the user already exists in the database
    const existingUser = await safeQuery(() => prisma.user.findUnique({ where: { id: keycloakUser.id } }));

    if (existingUser) {
      console.log('ensureKeycloakUser: Keycloak User already exists in the database.');
      return keycloakUser.id;
    }

    console.log('ensureKeycloakUser: Keycloak User does not exist in the database, creating new user.');

    // Create the user in the database with info from Keycloak
    const newUser = await safeQuery(() =>
      prisma.user.create({
        data: {
          id: keycloakUser.id,
          email: keycloakUser.email || '',
          userName: keycloakUser.userName || keycloakUser.username || 'User',
        },
      })
    );

    console.log('ensureKeycloakUser: Created new user in database:', newUser.id);
    return newUser.id;
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
