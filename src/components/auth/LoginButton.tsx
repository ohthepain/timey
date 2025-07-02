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
      <button
        className="text-orange-700 px-2 py-1 rounded hover:bg-orange-200 border-orange-600 border-2 rounded-e-md text-sm"
        disabled
      >
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
      className="px-2 py-1 bg-orange-200 hover:bg-orange-300 text-orange-800 border-2 border-orange-600 rounded-md transition-colors duration-200 text-sm"
    >
      {children}
    </button>
  );
}
