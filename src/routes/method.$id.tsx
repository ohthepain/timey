import { createFileRoute } from '@tanstack/react-router';
import { NotFound } from '~/components/NotFound';
import { UserErrorComponent } from '~/components/UserError';
import { ModuleList } from '~/components/ModuleList';
import { AddModule } from '~/components/AddModule';
import { Method } from '~/types/Method';
import { getMethodByIdServerFn } from '~/services/methodService.server';
import { useState, useEffect } from 'react';
import { useNavigationStore } from '~/state/NavigationStore';

export const Route = createFileRoute('/method/$id')({
  errorComponent: UserErrorComponent,
  component: MethodPage,
  notFoundComponent: () => {
    return <NotFound>Method not found</NotFound>;
  },
});

function MethodPage() {
  const params = Route.useParams();
  const userId = useNavigationStore((state) => state.practiceUserId);
  const [revision, setRevision] = useState(0);
  const [method, setMethod] = useState<Method | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const reportFailure = () => {
      if (active) setError('Failed to load method');
    };
    const finishLoading = () => {
      if (active) setLoading(false);
    };
    const loadMethod = async () => {
      try {
        setLoading(true);
        setMethod(null);
        setError(null);

        const methodData = await getMethodByIdServerFn({ data: { id: params.id } });
        if (!active) return;
        if (!methodData) {
          setError('Method not found');
          return;
        }

        setMethod(new Method(methodData));
      } catch (err) {
        console.error('Error loading method:', err);
        reportFailure();
      } finally {
        finishLoading();
      }
    };

    loadMethod();
    return () => {
      active = false;
    };
  }, [params.id, revision, userId]);

  if (loading) return <MethodLoading />;
  if (!method) return <MethodError error={error} />;

  return (
    <div className="method-page p-4">
      <h1 className="text-2xl font-bold mb-4">Method: {method.title}</h1>
      <p className="mb-2">Description: {method.description || 'No description provided.'}</p>
      <p className="mb-2">Index: {method.index}</p>
      <p className="mb-2">Author ID: {method.authorId}</p>
      <div className="mb-4">
        <ModuleList method={method} onDeleted={() => setRevision((value) => value + 1)} />
      </div>
      <div className="mb-4">
        <AddModule method={method} onCreated={() => setRevision((value) => value + 1)} />
      </div>
      <p className="text-sm text-gray-500">Created At: {new Date(method.createdAt).toISOString()}</p>
      <p className="text-sm text-gray-500">Modified At: {new Date(method.modifiedAt).toISOString()}</p>
    </div>
  );
}

function MethodLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto"></div>
        <p className="mt-4 text-gray-600">Loading method...</p>
      </div>
    </div>
  );
}
function MethodError({ error }: { error: string | null }) {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <h2 className="text-xl font-bold text-red-600 mb-4">Error</h2>
        <p className="text-gray-600">{error || 'Method not found'}</p>
      </div>
    </div>
  );
}
