import { createFileRoute } from '@tanstack/react-router';
import { NotFound } from '~/components/NotFound';
import { PostErrorComponent } from '~/components/PostErrorComponent';
import { ModuleViewer } from '~/components/ModuleViewer';
import { getBeatProgressForModuleServerFn, BeatProgressView } from '~/services/userProgressServerService.server';
import { getModuleByIdServerFn } from '~/services/moduleService.server';
import { Module } from '~/types/Module';

export const loader = async ({ params }: { params: { id: string } }) => {
  const moduleId = params.id;
  if (!moduleId) {
    throw new Error('Module ID is required');
  }

  console.log(`module.id.loader for module ID: ${moduleId}`);
  const moduleJson = await getModuleByIdServerFn({ data: { id: moduleId } });
  console.log('module.id.loader: moduleJson:', moduleJson);
  if (!moduleJson) {
    throw new Error('module.id.loader: Module not found');
  }
  // console.log(`module.id.loader: dunng module data for ${moduleId}`);
  // console.log('module.id.loader: Module data:', data);
  // const module = new Module(data);
  // console.log('module.id.loader : Module.toJSON:', module.toJSON());
  // for (const beat of module.beats!) {
  //   console.log('module.id.loader: Beat:', beat.toJSON());
  // }
  const beatProgress: BeatProgressView[] = await getBeatProgressForModuleServerFn({ data: { id: moduleId } });
  console.log('module.id.loader: Beat progress:', beatProgress);

  return { moduleJson, beatProgress };
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
  const { moduleJson, beatProgress } = Route.useLoaderData();
  const module = new Module(moduleJson);
  console.log('ModulePage:', moduleJson);

  return (
    <div className="p-8">
      <ModuleViewer module={module} beatProgress={beatProgress} />
    </div>
  );
}
