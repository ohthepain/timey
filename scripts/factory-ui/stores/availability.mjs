const unavailableCodes = new Set([
  'STORE_UNAVAILABLE',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ECONNABORTED',
  '57P01',
  '57P02',
  '57P03',
]);

export function storeUnavailable(error) {
  return unavailableCodes.has(error.code) || /^08[A-Z0-9]{3}$/.test(error.code || '');
}
