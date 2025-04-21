import { createFileRoute } from '@tanstack/react-router';
import { moduleService } from '~/services/moduleService';
import { NotFound } from '~/components/NotFound';
import { PostErrorComponent } from '~/components/PostErrorComponent';
import { ModuleViewer } from '~/components/ModuleViewer';
import { BeatEditor } from '~/components/BeatEditor';
import { getBeatProgressForModuleServerFn, BeatProgressView } from '~/services/userProgressServerService.server';

export const loader = async ({ params }: { params: { id: string } }) => {
  console.log('loader: id:', params.id);
  const moduleId = params.id;
  if (!moduleId) {
    throw new Error('Module ID is required');
  }

  const module = await moduleService.getModuleById(moduleId);
  const beatProgress: BeatProgressView[] = await getBeatProgressForModuleServerFn({ data: { moduleId } });
  console.log('loader: beatProgress:', beatProgress);

  console.log('loader: Module:', module);
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
  console.log('ModulePage: module:', module);

  return (
    <div>
      <ModuleViewer module={module} beatProgress={beatProgress} />
      <div className="m-4">
        <BeatEditor beat={null} module={module} />
      </div>
    </div>
  );
}
