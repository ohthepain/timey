import { createFileRoute } from '@tanstack/react-router';
import { NotFound } from '~/components/NotFound';
import { UserErrorComponent } from '~/components/UserError';
import { ModuleViewer } from '~/components/ModuleViewer';
import { getBeatProgressForModuleServerFn, BeatProgressView } from '~/services/userProgressServerService.server';
import { getModuleByIdServerFn } from '~/services/moduleService.server';
import { Module } from '~/types/Module';
import { useState, useEffect } from 'react';
import { useNavigationStore } from '~/state/NavigationStore';
import { privatePractice } from '~/state/privatePractice';

export const Route = createFileRoute('/module/$id')({
  errorComponent: UserErrorComponent,
  component: ModulePage,
  notFoundComponent: () => {
    return <NotFound>Module not found</NotFound>;
  },
});

function ModulePage() {
  const params = Route.useParams();
  const [revision, setRevision] = useState(0);
  const { module, loading, error } = usePublicModule(params.id, revision);
  const beatProgress = useModulePractice(params.id);
  if (loading) {
    return <ModuleLoading />;
  }

  if (error || !module) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h2 className="text-xl font-bold text-red-600 mb-4">Error</h2>
          <p className="text-gray-600">{moduleError(error)}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <ModuleViewer module={module} beatProgress={beatProgress} onCreated={() => setRevision((value) => value + 1)} />
    </div>
  );
}

function useModulePractice(moduleId: string) {
  const practiceUserId = useNavigationStore((state) => state.practiceUserId);
  const practiceGeneration = useNavigationStore((state) => state.practiceGeneration);
  const [beatProgress, setBeatProgress] = useState<BeatProgressView[]>([]);
  const [progressOwner, setProgressOwner] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setBeatProgress([]);
    setProgressOwner(null);
    if (practiceUserId) {
      privatePractice(() => getBeatProgressForModuleServerFn({ data: { id: moduleId } }))
        .then((progress) => {
          if (active && progress) {
            setBeatProgress(progress);
            setProgressOwner(practiceUserId);
          }
        })
        .catch(() => {
          if (active) setBeatProgress([]);
        });
    }
    return () => {
      active = false;
    };
  }, [moduleId, practiceUserId, practiceGeneration]);
  return practiceUserId && progressOwner === practiceUserId ? beatProgress : [];
}

function usePublicModule(moduleId: string, revision: number) {
  const [module, setModule] = useState<Module | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadModule = async () => {
      try {
        setLoading(true);
        setError(null);

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
      } catch (err) {
        console.error('Error loading module:', err);
        setError('Failed to load module');
      } finally {
        setLoading(false);
      }
    };

    loadModule();
  }, [moduleId, revision]);

  return { module, loading, error };
}

function ModuleLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto"></div>
        <p className="mt-4 text-gray-600">Loading module...</p>
      </div>
    </div>
  );
}

function moduleError(error: string | null) {
  return error || 'Module not found';
}
