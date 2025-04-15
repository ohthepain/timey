import { Method } from '~/types/Method';
import { Link } from '@tanstack/react-router';

interface ModuleListProps {
  method: Method;
}

export const ModuleList = ({ method }: ModuleListProps) => {
  const modules = method.modules;
  const sortedModules = modules.sort((a, b) => a.index - b.index);

  if (!sortedModules || sortedModules.length === 0) {
    return <p>No modules available for this method.</p>;
  }

  return (
    <div className="modules-list">
      <h2 className="text-xl font-bold mb-4">Modules</h2>
      {
        <ul className="list-disc pl-5">
          {method.modules.map((module) => (
            <li key={module.id} className="mb-2">
              <Link to="/module/$id" params={{ id: module.id }} className="text-blue-500 hover:underline">
                {module.title}
              </Link>
              <p className="text-sm text-gray-500">Index: {module.index}</p>
            </li>
          ))}
        </ul>
      }
    </div>
  );
};
