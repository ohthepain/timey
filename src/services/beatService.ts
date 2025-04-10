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
