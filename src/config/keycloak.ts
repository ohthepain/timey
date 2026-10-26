import Keycloak from 'keycloak-js';

// Keycloak configuration
// Update these values with your actual Keycloak server details
const keycloakConfig = {
  url: import.meta.env.VITE_KEYCLOAK_URL || 'http://localhost:8080',
  realm: import.meta.env.VITE_KEYCLOAK_REALM || 'timey',
  clientId: import.meta.env.VITE_KEYCLOAK_CLIENT_ID || 'timey-client',
};

// Initialize Keycloak instance only on the client side
let keycloakInstance: Keycloak | null = null;

export const getKeycloak = (): Keycloak => {
  if (typeof window === 'undefined') {
    // Server-side rendering - return a mock instance
    throw new Error('Keycloak can only be used on the client side');
  }

  if (!keycloakInstance) {
    keycloakInstance = new Keycloak({
      url: keycloakConfig.url,
      realm: keycloakConfig.realm,
      clientId: keycloakConfig.clientId,
    });
  }

  return keycloakInstance;
};

// Keycloak initialization options
export const getKeycloakInitOptions = () => {
  if (typeof window === 'undefined') {
    return {};
  }

  return {
    onLoad: 'check-sso' as const,
    silentCheckSsoRedirectUri: window.location.origin + '/silent-check-sso.html',
    checkLoginIframe: false,
    enableLogging: import.meta.env.DEV,
    pkceMethod: 'S256' as const,
  };
};

// User info interface
export interface KeycloakUser {
  id: string;
  username: string;
  email?: string;
  userName?: string;
  firstName?: string; // Keep for backward compatibility with Keycloak
  lastName?: string; // Keep for backward compatibility with Keycloak
  roles?: string[];
}

type KeycloakProfile = {
  sub?: string;
  preferred_username?: string;
  email?: string;
  userName?: string;
  given_name?: string;
  family_name?: string;
};

export function keycloakUserFromProfile(userInfo: KeycloakProfile, roles: string[] = []): KeycloakUser {
  return {
    id: userInfo.sub || '',
    username: userInfo.preferred_username || '',
    email: userInfo.email,
    userName:
      userInfo.userName || (userInfo.given_name && userInfo.family_name)
        ? `${userInfo.given_name} ${userInfo.family_name}`.trim()
        : userInfo.preferred_username || 'User',
    firstName: userInfo.given_name,
    lastName: userInfo.family_name,
    roles,
  };
}

/** Client-side: record the authenticated user in the app database. */
export async function ensureKeycloakUserRecorded(token: string | undefined): Promise<void> {
  if (!token) return;
  try {
    const response = await fetch('/api/auth/ensure-user', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    if (response.ok) {
      const { userId } = await response.json();
      console.log('User ensured in database:', userId);
    } else {
      console.error('Failed to ensure user in database');
    }
  } catch (error) {
    console.error('Error ensuring user in database:', error);
  }
}
