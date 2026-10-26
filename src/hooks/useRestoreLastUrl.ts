import { useEffect, useRef } from 'react';
import { useRouter } from '@tanstack/react-router';
import { getLastUrl, saveLastUrl } from '~/utils/urlPersistence';

export function useRestoreLastUrl() {
  const router = useRouter();
  const isInitialLoad = useRef(true);

  useEffect(() => {
    const unsubscribe = router.subscribe('onResolved', () => {
      if (isInitialLoad.current) {
        isInitialLoad.current = false;
        const lastUrl = getLastUrl();
        if (lastUrl && lastUrl !== window.location.pathname) {
          router.navigate({ to: lastUrl });
        }
      } else {
        saveLastUrl(router.state.location.pathname);
      }
    });

    const lastUrl = getLastUrl();
    if (lastUrl && lastUrl !== window.location.pathname) {
      router.navigate({ to: lastUrl });
    }

    return unsubscribe;
  }, [router]);
}
