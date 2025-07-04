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

        console.log('Initializing Keycloak...');
        const kc = getKeycloak();
        setKeycloak(kc);

        // Set up event listeners first
        (kc as any).onReady = () => {
          console.log('Keycloak is ready');
          setLoading(false);
        };

        (kc as any).onInitError = (error: any) => {
          console.error('Keycloak initialization error:', error);
          setLoading(false);
        };

        (kc as any).onAuthSuccess = async () => {
          console.log('Authentication successful');
          setAuthenticated(true);
          await loadUserInfo(kc);
          setLoading(false);
        };

        (kc as any).onAuthError = (error: any) => {
          console.error('Authentication error:', error);
          setAuthenticated(false);
          setUser(null);
          setLoading(false);
        };

        (kc as any).onAuthLogout = () => {
          console.log('User logged out');
          setAuthenticated(false);
          setUser(null);
          setLoading(false);
        };

        (kc as any).onTokenExpired = async () => {
          console.log('Token expired, attempting refresh');
          const refreshed = await updateToken(70);
          if (!refreshed) {
            login();
          }
        };

        const keycloakInitOptions = getKeycloakInitOptions();
        console.log('Keycloak init options:', keycloakInitOptions);

        const authenticated = await kc.init(keycloakInitOptions);
        console.log('Keycloak init result:', authenticated);
        setAuthenticated(authenticated);

        if (authenticated) {
          await loadUserInfo(kc);
        }
      } catch (error) {
        console.error('Keycloak initialization failed:', error);
        setLoading(false);
      }
    };

    initKeycloak();

    // Cleanup function to remove event listeners on unmount
    return () => {
      if (keycloak) {
        // Remove all event listeners
        (keycloak as any).onReady = null;
        (keycloak as any).onInitError = null;
        (keycloak as any).onAuthSuccess = null;
        (keycloak as any).onAuthError = null;
        (keycloak as any).onAuthLogout = null;
        (keycloak as any).onTokenExpired = null;
      }
    };
  }, []);

  const loadUserInfo = async (kc: any) => {
    try {
      if (kc.authenticated && kc.token) {
        const userInfo = await kc.loadUserInfo();
        setUser({
          id: userInfo.sub || '',
          username: userInfo.preferred_username || '',
          email: userInfo.email,
          userName:
            userInfo.userName || (userInfo.given_name && userInfo.family_name)
              ? `${userInfo.given_name} ${userInfo.family_name}`.trim()
              : userInfo.preferred_username || 'User',
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
      console.log('Initiating login...');
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
