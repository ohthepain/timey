import { createFileRoute } from '@tanstack/react-router';
import { AuthScreen } from '~/components/auth/AuthScreen';
import { authDestination } from '~/utils/authDestination';

export const Route = createFileRoute('/auth/$screen')({
  validateSearch: (search: Record<string, unknown>) => ({
    returnTo: authDestination(search.returnTo),
    token: typeof search.token === 'string' ? search.token : '',
    error: typeof search.error === 'string' ? search.error : '',
  }),
  component: AuthenticationRoute,
});

function AuthenticationRoute() {
  const { screen } = Route.useParams();
  const search = Route.useSearch();
  return <AuthScreen key={screen} screen={screen} {...search} />;
}
