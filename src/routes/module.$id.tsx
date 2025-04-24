import { createFileRoute } from '@tanstack/react-router';
import { NotFound } from '~/components/NotFound';
import { PostErrorComponent } from '~/components/PostErrorComponent';
import { ModuleViewer } from '~/components/ModuleViewer';
import { getBeatProgressForModuleServerFn, BeatProgressView } from '~/services/userProgressServerService.server';
import { getModuleByIdServerFn } from '~/services/moduleService.server';

export const loader = async ({ params }: { params: { id: string } }) => {
  const moduleId = params.id;
  if (!moduleId) {
    throw new Error('Module ID is required');
  }

  const module = await getModuleByIdServerFn({ data: { id: moduleId } });
  const beatProgress: BeatProgressView[] = await getBeatProgressForModuleServerFn({ data: { id: moduleId } });

  if (!module) {
    throw new Error('Module not found');
  }
  return { module, beatProgress };
};

export const Route = createFileRoute('/module/$id')({
  loader,
  errorComponent: ({ error }: { error: Error }) => <PostErrorComponent error={error.message} />,
  component: ModulePage,
  notFoundComponent: () => {
    return <NotFound>Module not found</NotFound>;
  },
});

function ModulePage() {
  const { module, beatProgress } = Route.useLoaderData();

  return (
    <div className="">
      <ModuleViewer module={module} beatProgress={beatProgress} />
    </div>
  );
}
