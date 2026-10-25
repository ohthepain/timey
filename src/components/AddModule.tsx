import { useState } from 'react';
import { Method } from '~/types/Method';
import { useNavigationStore } from '~/state/NavigationStore';
import { createModuleServerFn } from '~/services/moduleService.server';

interface AddModuleProps {
  method: Method;
  onCreated: () => void;
}

export const AddModule = (props: AddModuleProps) => {
  const userId = useNavigationStore((state) => state.practiceUserId);
  if (!userId)
    return (
      <a
        className="text-indigo-600 underline"
        href={`/auth/login?returnTo=${encodeURIComponent('/method/' + props.method.id)}`}
      >
        Sign in to add modules
      </a>
    );
  if (props.method.authorId !== userId) return <p>Only the method author can add modules.</p>;
  return <ModuleCreator key={`${props.method.id}:${userId}`} {...props} />;
};

const ModuleCreator = ({ method, onCreated }: AddModuleProps) => {
  const [title, setTitle] = useState('');
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const handleAddModule = async () => {
    if (!title.trim()) {
      setError('Title is required');
      return;
    }

    try {
      await createModuleServerFn({
        data: {
          title,
          index,
          methodId: method.id,
        },
      });
      setTitle('');
      setIndex(0);
      setError(null);
      onCreated();
    } catch (err) {
      console.error('Error adding module:', err);
      setError('Unable to add module. You must be signed in and own this method. Please retry.');
    }
  };

  return (
    <div className="add-module">
      <h2 className="text-xl font-bold mb-4">Add Module</h2>
      {error && (
        <p role="alert" className="text-red-500 mb-2">
          {error}
        </p>
      )}
      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="input-field px-4 py-2 border rounded w-full"
        />
      </div>
      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700 mb-1">Index</label>
        <input
          type="number"
          value={index}
          onChange={(e) => setIndex(Number(e.target.value))}
          className="input-field px-4 py-2 border rounded w-full"
        />
      </div>
      <button
        onClick={handleAddModule}
        className="btn btn-create bg-green-500 hover:bg-green-600 text-white px-4 py-2 rounded"
      >
        Add Module
      </button>
    </div>
  );
};
