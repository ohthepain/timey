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

export async function saveBeat(
  name: string,
  beatString: string,
  index: number,
  description: string,
  moduleId: string
): Promise<any> {
  try {
    console.log('saveBeat: sending request');
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
    console.log('saveBeat: sending request with index ', index);

    const response = await fetch('/api/saveBeat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name, beatString, index, description, moduleId }),
    });

    console.log(`saveBeat: got response status ${response.status}`);

    if (!response.ok) {
      throw new Error('Failed to save beat');
    }

    const savedBeat = await response.json();
    console.log('Beat saved successfully:', savedBeat);
    return savedBeat;
  } catch (error) {
    console.error('Error saving beat:', error);
    throw error;
  }
}
