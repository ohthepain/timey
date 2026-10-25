/** Redirects must stay inside this app, including after URL decoding. */
export function authDestination(value: unknown, fallback = '/auth/session'): string {
  if (typeof value !== 'string') return fallback;
  try {
    const decoded = decodeURIComponent(value);
    if (![value, decoded].every((path) => /^\/(?!\/)/.test(path) && !/[\\\u0000-\u0020\u007f]/.test(path))) {
      return fallback;
    }
    return value;
  } catch {
    return fallback;
  }
}
