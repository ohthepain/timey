import { Module } from '~/types/Module';
import { deleteBeat } from '~/services/beatService';
import { ScoreView } from '~/components/ScoreView2';

export interface ModuleProps {
  module: Module;
}

export const ModuleViewer = ({ module }: ModuleProps) => {
  const handleDeleteBeat = async (beatId: string) => {
    try {
      await deleteBeat(beatId);
      alert('Beat deleted successfully');
      // Optionally, refresh the module or remove the beat from the UI
    } catch (error) {
      console.error('Error deleting beat:', error);
      alert('Failed to delete beat');
    }
  };

  return (
    <div className="module-page p-4">
      <h1 className="text-2xl font-bold mb-4">Module: {module.title}</h1>
      <p className="mb-2">Description: {module.description || 'No description provided.'}</p>
      <p className="mb-2">Index: {module.index}</p>
      <p className="mb-2">Author ID: {module.authorId}</p>
      <p className="text-sm text-gray-500">Created At: {new Date(module.createdAt).toLocaleString()}</p>
      <p className="text-sm text-gray-500">Modified At: {new Date(module.modifiedAt).toLocaleString()}</p>
      <div className="mt-4">
        <h2 className="text-xl font-bold">Beats</h2>
        {module.beats && module.beats.length > 0 ? (
          <ul className="list-disc pl-5">
            {module.beats.map((beat) => (
              <li key={beat.id} className="mb-2">
                <div className="flex justify-between items-center">
                  <p className="font-semibold">{beat.name}</p>
                  <ScoreView beat={beat} />
                  <button onClick={() => handleDeleteBeat(beat.id)} className="text-red-500 hover:text-red-700 text-sm">
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-gray-500">No beats available for this module.</p>
        )}
      </div>
    </div>
  );
};
