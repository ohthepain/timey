import { Link, Outlet, createFileRoute } from '@tanstack/react-router';
import axios from 'redaxios';
import { DEPLOY_URL } from '../utils/users';
import type { User } from '../utils/users';
import { useState, useEffect } from 'react';

export const Route = createFileRoute('/users')({
  component: UsersLayoutComponent,
});

function UsersLayoutComponent() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadUsers = async () => {
      try {
        setLoading(true);
        setError(null);

        const response = await axios.get<Array<User>>(DEPLOY_URL + '/api/users');
        setUsers(response.data);
      } catch (err) {
        console.error('Error loading users:', err);
        setError('Failed to fetch users');
      } finally {
        setLoading(false);
      }
    };

    loadUsers();
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading users...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h2 className="text-xl font-bold text-red-600 mb-4">Error</h2>
          <p className="text-gray-600">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-2 flex gap-2">
      <ul className="list-disc pl-4">
        {[...users, { id: 'i-do-not-exist', name: 'Non-existent User', email: '' }].map((user) => {
          return (
            <li key={user.id} className="whitespace-nowrap">
              <Link
                to="/users/$userId"
                params={{
                  userId: String(user.id),
                }}
                className="block py-1 text-blue-800 hover:text-blue-600"
                activeProps={{ className: 'text-black font-bold' }}
              >
                <div>{user.name}</div>
              </Link>
            </li>
          );
        })}
      </ul>
      <hr />
      <Outlet />
    </div>
  );
}
