import React from 'react';
import { useKeycloak } from '~/contexts/KeycloakContext';

interface LoginButtonProps {
  className?: string;
  children?: React.ReactNode;
}

export function LoginButton({ className = '', children = 'Login' }: LoginButtonProps) {
  const { login, authenticated, loading } = useKeycloak();

  if (loading) {
    return (
      <button className={`px-4 py-2 bg-gray-300 text-gray-600 rounded-md cursor-not-allowed ${className}`} disabled>
        Loading...
      </button>
    );
  }

  if (authenticated) {
    return null; // Don't show login button if already authenticated
  }

  return (
    <button
      onClick={login}
      className={`px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors duration-200 ${className}`}
    >
      {children}
    </button>
  );
}
