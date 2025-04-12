import { deleteBeat } from '~/services/beatService';
import { useState } from 'react';

export const BeatAdminOperations = () => {
  const [beatName, setBeatName] = useState('basic');

  const handleDelete = async () => {
    console.log('handleDelete');

    try {
      const deletedBeat = await deleteBeat(beatName);
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
        className="btn btn-delete bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded"
        onClick={handleDelete}
      >
        Delete
      </button>
    </div>
  );
};
