import { Beat } from '~/types/Beat';
import { createBeat } from '~/repositories/beatRepository';
import { ParseBeatString } from '~/lib/ParseBeat';

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
    const response = await fetch(`/api/beats/${beatId}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
      },
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

export const saveBeat = async (
  name: string,
  beatString: string,
  index: number,
  description: string,
  moduleId: string,
  beatId?: string
): Promise<any> => {
  try {
    if (!beatString) {
      throw new Error(`saveBeat: beatString required`);
    }
    if (!name) {
      throw new Error(`saveBeat: name required`);
    }
    if (index === undefined || index === null) {
      throw new Error(`saveBeat: index required`);
    }
    if (!description) {
      throw new Error(`saveBeat: description required`);
    }
    if (!moduleId) {
      throw new Error(`saveBeat: moduleId required`);
    }

    const response = await fetch('/api/beats', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        id: beatId,
        name,
        beatString,
        index,
        description,
        moduleId,
      }),
    });

    if (!response.ok) {
      throw new Error('Failed to save beat');
    }

    const savedBeat = await response.json();
    return savedBeat;
  } catch (error) {
    console.error('Error saving beat:', error);
    throw error;
  }
};
