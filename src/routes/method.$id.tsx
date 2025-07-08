import { createFileRoute } from '@tanstack/react-router';
import { NotFound } from '~/components/NotFound';
import { UserErrorComponent } from '~/components/UserError';
import { ModuleList } from '~/components/ModuleList';
import { AddModule } from '~/components/AddModule';
import { Method } from '~/types/Method';
import { getMethodByIdServerFn } from '~/services/methodService.server';
import { useState, useEffect } from 'react';
import { useKeycloak } from '~/contexts/KeycloakContext';

export const Route = createFileRoute('/method/$id')({
  errorComponent: UserErrorComponent,
  component: MethodPage,
  notFoundComponent: () => {
    return <NotFound>Method not found</NotFound>;
  },
});

function MethodPage() {
  const params = Route.useParams();
  const { keycloak } = useKeycloak();
  const [method, setMethod] = useState<Method | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadMethod = async () => {
      try {
        setLoading(true);
        setError(null);

        const methodData = await getMethodByIdServerFn({ data: { id: params.id } });
        if (!methodData) {
          setError('Method not found');
          return;
        }

        setMethod(new Method(methodData));
      } catch (err) {
        console.error('Error loading method:', err);
        setError('Failed to load method');
      } finally {
        setLoading(false);
      }
    };

    loadMethod();
  }, [params.id]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading method...</p>
        </div>
      </div>
    );
  }

  if (error || !method) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h2 className="text-xl font-bold text-red-600 mb-4">Error</h2>
          <p className="text-gray-600">{error || 'Method not found'}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="method-page p-4">
      <h1 className="text-2xl font-bold mb-4">Method: {method.title}</h1>
      <p className="mb-2">Description: {method.description || 'No description provided.'}</p>
      <p className="mb-2">Index: {method.index}</p>
      <p className="mb-2">Author ID: {method.authorId}</p>
      <div className="mb-4">
        <ModuleList method={method} />
      </div>
      <div className="mb-4">
        <AddModule method={method} />
      </div>
      <p className="text-sm text-gray-500">Created At: {new Date(method.createdAt).toISOString()}</p>
      <p className="text-sm text-gray-500">Modified At: {new Date(method.modifiedAt).toISOString()}</p>
    </div>
  );
}
