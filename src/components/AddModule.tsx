import { useState } from 'react';
import { moduleService } from '~/services/moduleService';
import { Method } from '~/types/Method';

interface AddModuleProps {
  method: Method;
}

export const AddModule = ({ method }: AddModuleProps) => {
  const [title, setTitle] = useState('');
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const handleAddModule = async () => {
    if (!title.trim()) {
      setError('Title is required');
      return;
    }

    try {
      await moduleService.createModule({
        title,
        index,
        authorId: method.authorId,
        methodId: method.id,
      });
      setTitle('');
      setIndex(0);
      setError(null);
      alert('Module added successfully');
    } catch (err) {
      console.error('Error adding module:', err);
      setError('Failed to add module');
    }
  };

  return (
    <div className="add-module">
      <h2 className="text-xl font-bold mb-4">Add Module</h2>
      {error && <p className="text-red-500 mb-2">{error}</p>}
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
