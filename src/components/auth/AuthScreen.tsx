import { AuthForm } from './AuthForm';
import { AuthSession } from './AuthSession';
import { authDestination } from '~/utils/authDestination';

const titles: Record<string, string> = {
  login: 'Sign in',
  signup: 'Create your account',
  'forgot-password': 'Forgot your password?',
  'reset-password': 'Choose a new password',
  session: 'Your account',
};

export function AuthScreen({
  screen,
  returnTo,
  token,
  error,
}: {
  screen: string;
  returnTo: string;
  token: string;
  error: string;
}) {
  const link = (next: string) => `/auth/${next}?returnTo=${encodeURIComponent(authDestination(returnTo))}`;
  if (!titles[screen])
    return (
      <main className="p-8">
        <h1>Page not found</h1>
        <a href={link('login')}>Sign in</a>
      </main>
    );
  const content =
    screen === 'session' ? (
      <AuthSession loginLink={link('login')} />
    ) : (
      <AuthForm screen={screen} returnTo={returnTo} token={token} error={error} resetLink={link('reset-password')} />
    );
  return (
    <main className="mx-auto max-w-md px-4 py-12">
      <section className="rounded-xl border bg-white p-6 shadow-sm dark:bg-gray-900" aria-labelledby="auth-title">
        <h1 id="auth-title" className="text-2xl font-bold mb-6">
          {titles[screen]}
        </h1>
        {content}
        <nav
          className="mt-6 flex flex-wrap gap-4 text-sm text-indigo-600 dark:text-indigo-400 underline"
          aria-label="Account navigation"
        >
          <a href={link('login')}>Sign in</a>
          <a href={link('signup')}>Create an account</a>
          <a href={link('forgot-password')}>Forgot password?</a>
        </nav>
      </section>
      <p className="mt-4 text-sm text-gray-600 dark:text-gray-400">
        Practice uses this account. Content editing still uses the existing sign-in during the transition.
      </p>
    </main>
  );
}
