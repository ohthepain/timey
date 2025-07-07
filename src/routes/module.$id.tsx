import { createFileRoute } from '@tanstack/react-router';
import { NotFound } from '~/components/NotFound';
import { UserErrorComponent } from '~/components/UserError';
import { ModuleViewer } from '~/components/ModuleViewer';
import { getBeatProgressForModuleServerFn, BeatProgressView } from '~/services/userProgressServerService.server';
import { getModuleByIdServerFn } from '~/services/moduleService.server';
import { Module } from '~/types/Module';
import { useState, useEffect } from 'react';
import { useKeycloak } from '~/contexts/KeycloakContext';

export const Route = createFileRoute('/module/$id')({
  errorComponent: UserErrorComponent,
  component: ModulePage,
  notFoundComponent: () => {
    return <NotFound>Module not found</NotFound>;
  },
});

function ModulePage() {
  const params = Route.useParams();
  const [module, setModule] = useState<Module | null>(null);
  const [beatProgress, setBeatProgress] = useState<BeatProgressView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { keycloak } = useKeycloak();

  useEffect(() => {
    const loadModule = async () => {
      try {
        setLoading(true);
        setError(null);

        const moduleId = params.id;
        if (!moduleId) {
          setError('Module ID is required');
          return;
        }

        // Does not require authentication
        console.log(`Loading module ID: ${moduleId}`);
        const moduleJson = await getModuleByIdServerFn({ data: { id: moduleId } });
        if (!moduleJson) {
          setError('Module not found');
          return;
        }
        setModule(new Module(moduleJson));

        // Requires authentication
        const token = keycloak?.token;
        if (token) {
          const progress = await getBeatProgressForModuleServerFn({ data: { id: moduleId, token } });
          console.log('Beat progress:', progress);
          setBeatProgress(progress);
        }
      } catch (err) {
        console.error('Error loading module:', err);
        setError('Failed to load module');
      } finally {
        setLoading(false);
      }
    };

    loadModule();
  }, [params.id]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading module...</p>
        </div>
      </div>
    );
  }

  if (error || !module) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h2 className="text-xl font-bold text-red-600 mb-4">Error</h2>
          <p className="text-gray-600">{error || 'Module not found'}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <ModuleViewer module={module} beatProgress={beatProgress} />
    </div>
  );
}
