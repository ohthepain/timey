import { useState } from 'react';
import { signOut, useSession } from '~/server/auth-runtime/client';

const menuStyle = {
  app: {
    wrapper: 'relative',
    button: 'text-gray-700 hover:text-gray-900 focus:text-gray-900',
    name: 'hidden md:block',
    panel: 'absolute right-0 z-50 w-48',
    accountLink: {},
    afterSignOut: () => window.location.assign('/'),
  },
  embedded: {
    wrapper: 'w-full min-w-0',
    button: 'ml-auto text-gray-200 hover:text-white focus:text-white',
    name: 'truncate text-sm',
    panel: 'w-full',
    accountLink: { target: '_blank', rel: 'noopener noreferrer' },
    afterSignOut: undefined,
  },
};

type SessionUser = NonNullable<ReturnType<typeof useSession>['data']>['user'];

function userDisplayName(user: SessionUser) {
  const username = 'username' in user ? user.username : undefined;
  return (
    [user.name, username, user.email].find((name): name is string => typeof name === 'string' && name.length > 0) ??
    user.email
  );
}

export function UserMenu({ embedded = false }: { embedded?: boolean }) {
  const { data: session } = useSession();
  const user = session?.user;
  const [isOpen, setIsOpen] = useState(false);

  if (!user) {
    return null;
  }

  const style = menuStyle[embedded ? 'embedded' : 'app'];
  return <SignedInUserMenu user={user} style={style} isOpen={isOpen} setIsOpen={setIsOpen} />;
}

function SignedInUserMenu({
  user,
  style,
  isOpen,
  setIsOpen,
}: {
  user: SessionUser;
  style: (typeof menuStyle)[keyof typeof menuStyle];
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
}) {
  const displayName = userDisplayName(user);
  const handleLogout = async () => {
    await signOut();
    setIsOpen(false);
    style.afterSignOut?.();
  };

  return (
    <div className={style.wrapper}>
      <button
        type="button"
        aria-label={displayName}
        aria-expanded={isOpen}
        onClick={() => setIsOpen(!isOpen)}
        className={`flex max-w-full items-center space-x-2 focus:outline-none ${style.button}`}
      >
        <div className="w-8 h-8 shrink-0 bg-indigo-600 rounded-full flex items-center justify-center text-white text-sm font-medium">
          {displayName.charAt(0).toUpperCase() || '?'}
        </div>
        <span className={style.name}>{displayName}</span>
        <svg
          className={`w-4 h-4 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div className={`mt-2 rounded-md bg-white py-1 shadow-lg ${style.panel}`}>
          <div className="break-all px-4 py-2 text-sm text-gray-700 border-b">
            <div className="font-medium">{displayName}</div>
            <div className="text-gray-500">{user.email}</div>
          </div>
          <a
            href="/auth/session"
            {...style.accountLink}
            className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
          >
            Account
          </a>
          <button
            onClick={() => void handleLogout()}
            className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
