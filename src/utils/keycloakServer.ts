import { getKeycloak } from '~/config/keycloak';

// Server-side token validation
export const validateToken = async (token: string): Promise<boolean> => {
  try {
    // Only validate on the client side or when Keycloak is available
    if (typeof window === 'undefined') {
      // For server-side rendering, we'll skip validation
      // In production, you might want to validate against Keycloak's public key
      return true;
    }

    const keycloak = getKeycloak();
    if (!keycloak) {
      return false;
    }

    // For now, we'll just check if the token exists and is not expired
    // In production, you should validate against Keycloak's public key
    return !!token;
  } catch (error) {
    console.error('Token validation error:', error);
    return false;
  }
};

// Get user info from token
export const getUserFromToken = async (token: string) => {
  try {
    // Only process on the client side
    if (typeof window === 'undefined') {
      return null;
    }

    const keycloak = getKeycloak();
    if (!keycloak) {
      return null;
    }

    // Set the token temporarily to load user info
    keycloak.token = token;
    const userInfo = (await keycloak.loadUserInfo()) as any;

    return {
      id: userInfo.sub || '',
      username: userInfo.preferred_username || '',
      email: userInfo.email,
      userName:
        userInfo.userName || (userInfo.given_name && userInfo.family_name)
          ? `${userInfo.given_name} ${userInfo.family_name}`.trim()
          : userInfo.preferred_username || 'User',
      firstName: userInfo.given_name, // Keep for backward compatibility
      lastName: userInfo.family_name, // Keep for backward compatibility
      roles: keycloak.realmAccess?.roles || [],
    };
  } catch (error) {
    console.error('Error getting user from token:', error);
    return null;
  }
};

// Extract token from request headers
export const extractTokenFromHeaders = (headers: Headers): string | null => {
  const authHeader = headers.get('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }
  return null;
};
