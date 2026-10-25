import { useState } from 'react';
import { authClient } from '~/server/auth-runtime/client';
import { AuthFeedback } from './AuthFeedback';

export function AuthSession({ loginLink }: { loginLink: string }) {
  const { data: session, isPending, error } = authClient.useSession();
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  async function logout() {
    setBusy(true);
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error('Sign out failed');
      window.location.assign(loginLink);
    } catch {
      setFailure('Unable to sign out. Please try again.');
    } finally {
      setBusy(false);
    }
  }
  if (isPending) return <p>Checking your session…</p>;
  if (error) return <p role="alert">Unable to check your session. Reload to try again.</p>;
  if (!session)
    return (
      <>
        <p>You’re signed out.</p>
        <a className="text-indigo-600 underline" href={loginLink}>
          Sign in
        </a>
      </>
    );
  return (
    <div className="space-y-4">
      <p>
        Signed in as <strong>{session.user.name}</strong>.
      </p>
      <AuthFeedback failure={failure} />
      <button
        className="rounded-md bg-indigo-600 px-4 py-2.5 font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
        disabled={busy}
        onClick={logout}
      >
        Sign out
      </button>
      <a className="block text-indigo-600 underline" href="/">
        Continue to Timey
      </a>
    </div>
  );
}
