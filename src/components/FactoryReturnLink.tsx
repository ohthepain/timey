import { useEffect, useState } from 'react';
import { z } from 'zod';

const factoryStatus = z.object({
  url: z
    .string()
    .regex(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    .nullable(),
});

async function readFactoryUrl(signal: AbortSignal): Promise<string | null> {
  try {
    const response = await fetch('/api/factory-status', { signal });
    return response.ok ? factoryStatus.parse(await response.json()).url : null;
  } catch {
    return null;
  }
}

export function FactoryReturnLink() {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname)) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;

    async function refresh() {
      const url = await readFactoryUrl(AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]));
      if (controller.signal.aborted) return;
      setUrl(url);
      timer = setTimeout(refresh, 2000);
    }

    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);

  return (
    url && (
      <a className="text-gray-700 px-2 py-1 rounded hover:bg-gray-200 border-gray-600 border-2 text-sm" href={url}>
        Factory
      </a>
    )
  );
}
