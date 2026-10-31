import { useEffect, useState } from 'react';

async function loadWithState<T>(
  load: () => Promise<T>,
  setData: (value: T) => void,
  setError: (message: string | null) => void,
  setLoading: (value: boolean) => void
) {
  setLoading(true);
  setError(null);
  try {
    setData(await load());
  } catch (err) {
    console.error(err);
    setError('Failed to load resource');
  } finally {
    setLoading(false);
  }
}

export function useLoadedResource<T>(load: () => Promise<T>, dependency: unknown) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    loadWithState(
      load,
      (value) => {
        if (active) setData(value);
      },
      (message) => {
        if (active) setError(message);
      },
      (value) => {
        if (active) setLoading(value);
      }
    );
    return () => {
      active = false;
    };
  }, [dependency]);

  return { data, loading, error };
}
