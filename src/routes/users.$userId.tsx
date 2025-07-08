import { createFileRoute } from '@tanstack/react-router';
import axios from 'redaxios';
import type { User } from '~/utils/users';
import { DEPLOY_URL } from '~/utils/users';
import { NotFound } from '~/components/NotFound';
import { UserErrorComponent } from '~/components/UserError';
import { useState, useEffect } from 'react';

export const Route = createFileRoute('/users/$userId')({
  errorComponent: UserErrorComponent,
  component: UserComponent,
  notFoundComponent: () => {
    return <NotFound>User not found</NotFound>;
  },
});

function UserComponent() {
  const params = Route.useParams();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadUser = async () => {
      try {
        setLoading(true);
        setError(null);

        const response = await axios.get<User>(DEPLOY_URL + '/api/users/' + params.userId);
        setUser(response.data);
      } catch (err) {
        console.error('Error loading user:', err);
        setError('Failed to fetch user');
      } finally {
        setLoading(false);
      }
    };

    loadUser();
  }, [params.userId]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading user...</p>
        </div>
      </div>
    );
  }

  if (error || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h2 className="text-xl font-bold text-red-600 mb-4">Error</h2>
          <p className="text-gray-600">{error || 'User not found'}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <h4 className="text-xl font-bold underline">{user.name}</h4>
      <div className="text-sm">{user.email}</div>
    </div>
  );
}
