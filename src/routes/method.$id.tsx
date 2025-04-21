import { createFileRoute } from '@tanstack/react-router';
import { methodService } from '~/services/methodService';
import { NotFound } from '~/components/NotFound';
import { PostErrorComponent } from '~/components/PostErrorComponent';
import { ModuleList } from '~/components/ModuleList';
import { AddModule } from '~/components/AddModule';

export const loader = async ({ params }: { params: { id: string } }) => {
  const method = await methodService.getMethodById(params.id);
  console.log('loader: Method:', method);
  if (!method) {
    throw new Error('Method not found');
  }
  return method;
};

export const Route = createFileRoute('/method/$id')({
  loader,
  errorComponent: ({ error }: { error: Error }) => <PostErrorComponent error={error.message} />,
  component: MethodPage,
  notFoundComponent: () => {
    return <NotFound>Post not found</NotFound>;
  },
});

function MethodPage() {
  const method = Route.useLoaderData();

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
