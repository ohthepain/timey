import Keycloak from 'keycloak-js';

// Keycloak configuration
// Update these values with your actual Keycloak server details
export const keycloakConfig = {
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
    onLoad: 'check-sso',
    silentCheckSsoRedirectUri: window.location.origin + '/silent-check-sso.html',
    checkLoginIframe: false,
    enableLogging: import.meta.env.DEV,
  };
};

// Keycloak event types
export interface KeycloakEvent {
  type:
    | 'onReady'
    | 'onInitError'
    | 'onAuthSuccess'
    | 'onAuthError'
    | 'onAuthRefreshSuccess'
    | 'onAuthRefreshError'
    | 'onAuthLogout'
    | 'onTokenExpired';
  error?: any;
}

// User info interface
export interface KeycloakUser {
  id: string;
  username: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  roles?: string[];
}
