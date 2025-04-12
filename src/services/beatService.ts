import { Beat } from '~/types/Beat';

export const getBeatByName = async (name: string) => {
  const response = await fetch(`/api/getBeatByName?name=${encodeURIComponent(name)}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch beat: ${response.statusText}`);
  }
  const data = await response.json();
  console.log('Beat fetched successfully:', data);
  return data.beat as Beat;
};

export async function deleteBeat(beatId: string): Promise<any> {
  try {
    console.log('deleteBeat: sending request');
    const response = await fetch('/api/deleteBeat', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ beatId }),
    });

    console.log(`deleteBeat: got response status ${response.status}`);

    if (!response.ok) {
      throw new Error('Failed to delete beat');
    }

    const deletedBeat = await response.json();
    console.log('Beat deleted successfully:', deletedBeat);
    return deletedBeat;
  } catch (error) {
    console.error('Error deleting beat:', error);
    throw error;
  }
}
