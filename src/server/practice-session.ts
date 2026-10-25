import { serverOnly } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { requireDomainUser } from './domain-session';

// Private server-function responses must not survive a cookie/account change.
export const requirePracticeUser = serverOnly(async () => {
  setResponseHeader('Cache-Control', 'no-store');
  return requireDomainUser();
});
