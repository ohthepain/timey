import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { getKeycloak, getKeycloakInitOptions } from '~/config/keycloak';
import { KeycloakEvent, KeycloakUser } from '~/config/keycloak';

interface KeycloakContextType {
  keycloak: any;
  authenticated: boolean;
  loading: boolean;
  user: KeycloakUser | null;
  login: () => void;
  logout: () => void;
  register: () => void;
  updateToken: (minValidity: number) => Promise<boolean>;
}

const KeycloakContext = createContext<KeycloakContextType | undefined>(undefined);

interface KeycloakProviderProps {
  children: ReactNode;
}

export const KeycloakProvider: React.FC<KeycloakProviderProps> = ({ children }) => {
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<KeycloakUser | null>(null);
  const [keycloak, setKeycloak] = useState<any>(null);

  useEffect(() => {
    const initKeycloak = async () => {
      try {
        // Only initialize on the client side
        if (typeof window === 'undefined') {
          setLoading(false);
          return;
        }

        const kc = getKeycloak();
        setKeycloak(kc);

        const keycloakInitOptions = getKeycloakInitOptions();
        const authenticated = await kc.init(keycloakInitOptions);
        setAuthenticated(authenticated);

        if (authenticated) {
          await loadUserInfo(kc);
        }
      } catch (error) {
        console.error('Keycloak initialization failed:', error);
      } finally {
        setLoading(false);
      }
    };

    initKeycloak();
  }, []);

  const loadUserInfo = async (kc: any) => {
    try {
      if (kc.authenticated && kc.token) {
        const userInfo = await kc.loadUserInfo();
        setUser({
          id: userInfo.sub || '',
          username: userInfo.preferred_username || '',
          email: userInfo.email,
          firstName: userInfo.given_name,
          lastName: userInfo.family_name,
          roles: kc.realmAccess?.roles || [],
        });
      }
    } catch (error) {
      console.error('Failed to load user info:', error);
    }
  };

  const login = () => {
    if (keycloak) {
      keycloak.login({
        redirectUri: window.location.origin,
      });
    }
  };

  const logout = () => {
    if (keycloak) {
      keycloak.logout({
        redirectUri: window.location.origin,
      });
    }
  };

  const register = () => {
    if (keycloak) {
      keycloak.register({
        redirectUri: window.location.origin,
      });
    }
  };

  const updateToken = async (minValidity: number): Promise<boolean> => {
    if (!keycloak) return false;

    try {
      const refreshed = await keycloak.updateToken(minValidity);
      if (refreshed) {
        // Token was refreshed, update user info if needed
        await loadUserInfo(keycloak);
      }
      return refreshed;
    } catch (error) {
      console.error('Token refresh failed:', error);
      // Token refresh failed, user needs to login again
      setAuthenticated(false);
      setUser(null);
      return false;
    }
  };

  // Set up event listeners
  useEffect(() => {
    if (!keycloak || typeof window === 'undefined') return;

    const onReady = () => {
      console.log('Keycloak is ready');
    };

    const onInitError = (error: any) => {
      console.error('Keycloak initialization error:', error);
      setLoading(false);
    };

    const onAuthSuccess = async () => {
      console.log('Authentication successful');
      setAuthenticated(true);
      await loadUserInfo(keycloak);
    };

    const onAuthError = (error: any) => {
      console.error('Authentication error:', error);
      setAuthenticated(false);
      setUser(null);
    };

    const onAuthLogout = () => {
      console.log('User logged out');
      setAuthenticated(false);
      setUser(null);
    };

    const onTokenExpired = async () => {
      console.log('Token expired, attempting refresh');
      const refreshed = await updateToken(70);
      if (!refreshed) {
        login();
      }
    };

    // Add event listeners
    keycloak.onReady = onReady;
    keycloak.onInitError = onInitError;
    keycloak.onAuthSuccess = onAuthSuccess;
    keycloak.onAuthError = onAuthError;
    keycloak.onAuthLogout = onAuthLogout;
    keycloak.onTokenExpired = onTokenExpired;

    // Cleanup function
    return () => {
      if (keycloak) {
        keycloak.onReady = undefined;
        keycloak.onInitError = undefined;
        keycloak.onAuthSuccess = undefined;
        keycloak.onAuthError = undefined;
        keycloak.onAuthLogout = undefined;
        keycloak.onTokenExpired = undefined;
      }
    };
  }, [keycloak]);

  const value: KeycloakContextType = {
    keycloak,
    authenticated,
    loading,
    user,
    login,
    logout,
    register,
    updateToken,
  };

  return <KeycloakContext.Provider value={value}>{children}</KeycloakContext.Provider>;
};

export const useKeycloak = (): KeycloakContextType => {
  const context = useContext(KeycloakContext);
  if (context === undefined) {
    throw new Error('useKeycloak must be used within a KeycloakProvider');
  }
  return context;
};
