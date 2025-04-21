import { Method } from '~/types/Method';
import { Link } from '@tanstack/react-router';
import { useRouter } from '@tanstack/react-router';
import { deleteModuleServerFn } from '~/services/moduleService.server';

interface ModuleListProps {
  method: Method;
}

export const ModuleList = ({ method }: ModuleListProps) => {
  const modules = method.modules || [];
  const sortedModules = modules.sort((a, b) => a.index - b.index);
  const router = useRouter();

  const handleDeleteModule = async (moduleId: string) => {
    if (confirm('Are you sure you want to delete this module?')) {
      try {
        await deleteModuleServerFn({ data: { id: moduleId } });
        router.invalidate();
      } catch (error) {
        alert('Failed to delete module');
      }
    }
  };

  if (!sortedModules || sortedModules.length === 0) {
    return <p>No modules available for this method.</p>;
  }

  return (
    <div className="modules-list">
      <h2 className="text-xl font-bold mb-4">Modules</h2>
      <ul className="list-disc pl-5">
        {sortedModules.map((module) => (
          <li key={module.id} className="mb-2 flex items-center gap-2">
            <Link to="/module/$id" params={{ id: module.id }} className="text-blue-500 hover:underline">
              {module.title}
            </Link>
            <p className="text-sm text-gray-500">Index: {module.index}</p>
            <button
              onClick={() => handleDeleteModule(module.id)}
              className="text-red-500 hover:text-red-700 text-xs border border-red-300 rounded px-2 py-1 ml-2"
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
};
