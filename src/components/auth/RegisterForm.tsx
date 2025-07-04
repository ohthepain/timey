import { useKeycloak } from '~/contexts/KeycloakContext';
import { useEffect } from 'react';

export function RegisterForm() {
  const { register } = useKeycloak();

  useEffect(() => {
    // Directly redirect to Keycloak registration
    register();
  }, [register]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Redirecting to registration...</p>
        </div>
      </div>
    </div>
  );
}
