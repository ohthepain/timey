import { getWebRequest } from '@tanstack/react-start/server';

export interface KeycloakUser {
  id: string;
  username: string;
  email?: string;
  userName?: string;
  firstName?: string; // Keep for backward compatibility with Keycloak
  lastName?: string; // Keep for backward compatibility with Keycloak
  roles?: string[];
}

export const getKeycloakUser = async (): Promise<KeycloakUser | null> => {
  try {
    const request = getWebRequest();
    if (!request) {
      return null;
    }

    // Get the Authorization header
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return null;
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    // For now, we'll use a simple approach
    // In production, you should validate the JWT token with Keycloak's public key
    // and verify the signature, expiration, etc.

    // Decode the JWT token (this is just for demo - in production, verify the signature!)
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());

    return {
      id: payload.sub || '',
      username: payload.preferred_username || '',
      email: payload.email,
      userName:
        payload.userName || (payload.given_name && payload.family_name)
          ? `${payload.given_name} ${payload.family_name}`.trim()
          : payload.preferred_username || 'User',
      firstName: payload.given_name, // Keep for backward compatibility
      lastName: payload.family_name, // Keep for backward compatibility
      roles: payload.realm_access?.roles || [],
    };
  } catch (error) {
    console.error('Error getting Keycloak user:', error);
    return null;
  }
};

export const requireAuth = async (): Promise<KeycloakUser> => {
  const user = await getKeycloakUser();
  if (!user) {
    throw new Error('Authentication required');
  }
  return user;
};
