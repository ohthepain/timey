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

export const getKeycloakUser = async (token?: string): Promise<KeycloakUser | null> => {
  try {
    let extractedToken = token;

    if (!extractedToken) {
      const request = getWebRequest();

      if (!request) {
        return null;
      }

      // Get the Authorization header
      const authHeader = request.headers.get('Authorization');

      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return null;
      }

      extractedToken = authHeader.substring(7); // Remove 'Bearer ' prefix
    }

    // For now, we'll use a simple approach
    // In production, you should validate the JWT token with Keycloak's public key
    // and verify the signature, expiration, etc.

    // Decode the JWT token (this is just for demo - in production, verify the signature!)
    try {
      const parts = extractedToken.split('.');

      if (parts.length !== 3) {
        return null;
      }

      // Check if the payload part exists and is not empty
      if (!parts[1] || parts[1].length === 0) {
        return null;
      }

      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());

      // Check if token is expired
      if (payload.exp && payload.exp < Date.now() / 1000) {
        return null;
      }

      const user = {
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

      return user;
    } catch (error) {
      console.error('getKeycloakUser: Error decoding JWT token:', error);
      return null;
    }
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
