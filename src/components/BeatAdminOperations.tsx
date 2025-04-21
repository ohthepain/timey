import { deleteBeatServerFn } from '~/services/beatService.server';
import { useState } from 'react';

export const BeatAdminOperations = () => {
  const [beatName, setBeatName] = useState('basic');

  const handleDelete = async () => {
    console.log('handleDelete');

    try {
      const deletedBeat = await deleteBeatServerFn(beatName);
      console.log('Beat deleted successfully:', deletedBeat);
    } catch (error) {
      console.error('Error deleting beat:', error);
    }
  };

  return (
    <div className="admin-operations">
      <input
        type="text"
        placeholder="Enter beat name"
        value={beatName}
        onChange={(e) => setBeatName(e.target.value)}
        className="input-field px-4 py-2 border rounded"
      />
      <button
        onClick={() => {}}
        className="bg-gray-200 hover:bg-gray-300 text-gray-700 px-2 py-1 text-xs rounded mr-2"
        title="Copy"
      >
        Copy
      </button>
      <button
        className="btn btn-delete bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded"
        onClick={handleDelete}
      >
        Delete
      </button>
    </div>
  );
};
