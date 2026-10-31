import { FormEvent, useEffect, useState } from 'react';
import { authClient } from '~/server/auth-runtime/client';
import { authDestination } from '~/utils/authDestination';
import { AuthFeedback } from './AuthFeedback';

const fieldDefinitions: Record<
  string,
  { label: string; type?: string; autoComplete: string; minLength?: number; maxLength?: number }
> = {
  identifier: { label: 'Username or email', autoComplete: 'username' },
  username: { label: 'Username', autoComplete: 'username', minLength: 3, maxLength: 30 },
  email: { label: 'Email', type: 'email', autoComplete: 'email' },
  password: { label: 'Password', type: 'password', autoComplete: 'new-password', minLength: 8, maxLength: 128 },
  confirmation: {
    label: 'Confirm password',
    type: 'password',
    autoComplete: 'new-password',
    minLength: 8,
    maxLength: 128,
  },
};
const forms: Record<string, { fields: string[]; button: string; message: string }> = {
  login: { fields: ['identifier', 'password'], button: 'Sign in', message: '' },
  signup: { fields: ['username', 'email', 'password', 'confirmation'], button: 'Create your account', message: '' },
  'forgot-password': {
    fields: ['email'],
    button: 'Send reset link',
    message: 'If an account exists for that email, a password reset link is on its way.',
  },
  'reset-password': {
    fields: ['password', 'confirmation'],
    button: 'Reset password',
    message: 'Your password has been reset. Sign in with your new password.',
  },
};

export function AuthForm({
  screen,
  returnTo,
  token,
  error,
  resetLink,
}: {
  screen: string;
  returnTo: string;
  token: string;
  error: string;
  resetLink: string;
}) {
  const [message, setMessage] = useState('');
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(true);
  useEffect(() => setBusy(false), []);
  const form = forms[screen];
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const value = (name: string) => String(fields.get(name) ?? '');
    setFailure('');
    setBusy(true);
    try {
      validateConfirmation(screen, value);
      const result = await performAuth(screen, value, token, resetLink);
      assertSuccess(result);
      setMessage(form.message);
      if (!form.message) window.location.assign(authDestination(returnTo));
    } catch (cause) {
      setFailure(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  if (invalidReset(screen, token, error))
    return <p role="alert">This reset link is invalid or expired. Request a new link below.</p>;
  if (message) return <p role="status">{message}</p>;
  return (
    <form method="post" onSubmit={submit} className="space-y-4">
      <AuthFeedback failure={failure} />
      <fieldset disabled={busy} className="space-y-4">
        <AuthFields screen={screen} fields={form.fields} />
        <button
          disabled={busy}
          className="rounded-md bg-indigo-600 px-4 py-2.5 font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 w-full"
          type="submit"
        >
          {busy ? 'Please wait…' : form.button}
        </button>
      </fieldset>
    </form>
  );
}

function assertSuccess(result: { error: { message?: string } | null }) {
  if (result.error) throw new Error(result.error.message || 'Unable to complete this request. Please try again.');
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : 'Unable to connect. Please try again.';
}

function invalidReset(screen: string, token: string, error: string) {
  return screen === 'reset-password' && (!token || Boolean(error));
}

function validateConfirmation(screen: string, value: (name: string) => string) {
  if (['signup', 'reset-password'].includes(screen) && value('password') !== value('confirmation'))
    throw new Error('Passwords do not match.');
}

function AuthFields({ screen, fields }: { screen: string; fields: string[] }) {
  return (
    <>
      {fields.map((name) => {
        const { label, ...props } = fieldDefinitions[name];
        const autoComplete = screen === 'login' && name === 'password' ? 'current-password' : props.autoComplete;
        return (
          <label key={name} className="block">
            <span className="block mb-1 font-medium">{label}</span>
            <input
              {...props}
              autoComplete={autoComplete}
              name={name}
              required
              className="w-full rounded-md border p-2.5 bg-transparent"
            />
          </label>
        );
      })}
      {screen === 'signup' && (
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Your username is your display name. Your email stays private.
        </p>
      )}
      {screen === 'login' && (
        <label className="flex items-center gap-2">
          <input type="checkbox" name="rememberMe" defaultChecked />
          Remember me
        </label>
      )}
    </>
  );
}

function performAuth(screen: string, value: (name: string) => string, token: string, redirectTo: string) {
  const password = value('password');
  const actions: Record<string, () => ReturnType<typeof authClient.resetPassword>> = {
    signup: () =>
      authClient.signUp.email({
        username: value('username'),
        name: value('username'),
        email: value('email'),
        password,
      }),
    'forgot-password': () => authClient.requestPasswordReset({ email: value('email'), redirectTo }),
    'reset-password': () => authClient.resetPassword({ newPassword: password, token }),
    login: () => signIn(value),
  };
  return actions[screen]();
}

function signIn(value: (name: string) => string) {
  const identifier = value('identifier').trim();
  const input = { password: value('password'), rememberMe: value('rememberMe') === 'on' };
  return identifier.includes('@')
    ? authClient.signIn.email({ email: identifier, ...input })
    : authClient.signIn.username({ username: identifier, ...input });
}
