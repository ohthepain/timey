import { Module } from '~/types/Module';
import { deleteBeat } from '~/services/beatService';
import { ScoreView } from '~/components/ScoreView2';
import { passBeatTempoServerFn, startBeatServerFn } from '~/services/userProgressServerService.server';

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
                  <button
                    onClick={async () => {
                      // You may need to provide userId, moduleId, methodId, and beatId here
                      // For demonstration, assuming you have access to userId, moduleId, and methodId
                      // Replace 'userId', 'moduleId', and 'methodId' with actual values from your context or props

                      // console.log('Fetching yourServerFn for beat:', beat.id);
                      // const result = await yourServerFn({ data: { beatId: beat.id } });
                      // console.log('Result from yourServerFn:', result);
                      console.log('Fetching startBeatServerFn for beat:', beat.id);
                      await startBeatServerFn({ data: { beatId: beat.id } });
                      /* TODO: implement play functionality */
                    }}
                    className="text-green-500 hover:text-green-700 text-3xl p-2 mr-2"
                    title="Play"
                  >
                    ▶️
                  </button>
                  <ScoreView beat={beat} />
                  {[90, 100, 120, 140].map((tempo) => (
                    <button
                      key={tempo}
                      onClick={async () => {
                        // Replace 'userId' with the actual user ID from your context or props
                        await passBeatTempoServerFn({ data: { beatId: beat.id, tempo: tempo } });
                      }}
                      className="bg-blue-100 hover:bg-blue-300 text-blue-800 font-bold py-1 px-2 mx-1 rounded text-xs"
                      title={`Pass at tempo ${tempo}`}
                    >
                      {tempo}
                    </button>
                  ))}
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
