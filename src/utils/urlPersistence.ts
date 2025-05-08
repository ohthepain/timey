const LAST_URL_KEY = 'lastVisitedUrl';

export function saveLastUrl(url: string) {
  localStorage.setItem(LAST_URL_KEY, url);
}

export function getLastUrl(): string | null {
  return localStorage.getItem(LAST_URL_KEY);
}
