const LAST_URL_KEY = 'lastVisitedUrl';

export function saveLastUrl(url: string) {
  // Never retain reset tokens or replace an explicit authentication destination.
  if (url.startsWith('/auth/')) return;
  localStorage.setItem(LAST_URL_KEY, url);
}

export function getLastUrl(): string | null {
  if (window.location.pathname.startsWith('/auth/')) return null;
  return localStorage.getItem(LAST_URL_KEY);
}
