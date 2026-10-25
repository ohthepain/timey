import { describe, expect, it } from 'vitest';
import { authDestination } from './authDestination';

describe('authentication return destinations', () => {
  it.each([
    'https://other.test',
    '//other.test',
    '/\\other.test',
    '/%2fother.test',
    '/%5cother.test',
    '/%0aevil',
    '/%',
    undefined,
  ])('rejects unsafe destination %s', (value) => expect(authDestination(value)).toBe('/auth/session'));
  it('keeps local paths, queries and fragments', () => {
    expect(authDestination('/methods?sort=name#start')).toBe('/methods?sort=name#start');
  });
});
