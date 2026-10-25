import { useState, useEffect } from 'react';
import {
  getAllMethodsServerFn,
  createMethodServerFn,
  updateMethodServerFn,
  deleteMethodServerFn,
} from '~/services/methodService.server';
import { Link } from '@tanstack/react-router';
import { confirmContentDeletion } from './deleteContent';
import { useRouter } from '@tanstack/react-router';
import { useNavigationStore } from '~/state/NavigationStore';

export const MethodsAdminPage = () => {
  const userId = useNavigationStore((state) => state.practiceUserId);
  return <MethodsEditor key={userId ?? 'anonymous'} userId={userId} />;
};

const MethodsEditor = ({ userId }: { userId: string | null }) => {
  const [methods, setMethods] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [newMethodName, setNewMethodName] = useState('');
  const [selectedMethod, setSelectedMethod] = useState<any | null>(null);
  const router = useRouter();

  useEffect(() => {
    fetchMethods();
  }, []);

  const fetchMethods = async () => {
    console.log('Fetching methods...');
    try {
      const response = await getAllMethodsServerFn();
      setMethods(response);
    } catch (error) {
      console.error('Error fetching methods:', error);
    }
  };

  const handleCreate = async () => {
    if (!newMethodName.trim()) return;
    try {
      setError('');
      const newMethod = await createMethodServerFn({
        data: {
          title: newMethodName,
        },
      });
      setMethods((prev) => [...prev, newMethod]);
      setNewMethodName('');
    } catch (error) {
      setError('Unable to create method. Check your sign-in and retry.');
    }
  };

  const handleUpdate = async () => {
    if (!selectedMethod) return;

    try {
      setError('');
      const updatedMethod = await updateMethodServerFn({
        data: {
          id: selectedMethod.id,
          title: selectedMethod.title,
        },
      });
      setMethods((prev) => prev.map((m) => (m.id === updatedMethod.id ? updatedMethod : m)));
      setSelectedMethod(null);
    } catch (error) {
      setError('Unable to save. Only the original author can edit this method; check your sign-in and retry.');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      setError('');
      if (!(await confirmContentDeletion('method', () => deleteMethodServerFn({ data: { id } })))) return;
      setSelectedMethod(null);
      await fetchMethods();
      await router.invalidate();
    } catch (error) {
      setError('Unable to delete method. Sign in as its author and retry.');
    }
  };

  return (
    <div className="methods-admin-page m-16">
      <div className="p-2 rounded-lg shadow-lg">
        <h1 className="text-2xl font-bold mb-4">Methods Admin</h1>
        {error && (
          <p role="alert" className="text-red-600 mb-2">
            {error}
          </p>
        )}
        {!userId && (
          <a className="text-indigo-600 underline" href="/auth/login?returnTo=%2Fmethods">
            Sign in to create or edit methods
          </a>
        )}
        <div className="create-method mb-4">
          <input
            type="text"
            placeholder="New method name"
            value={newMethodName}
            onChange={(e) => setNewMethodName(e.target.value)}
            className="input-field px-4 py-2 border rounded mr-2"
          />
          <button
            disabled={!userId}
            onClick={handleCreate}
            className="btn btn-create bg-green-500 hover:bg-green-600 text-white px-4 py-2 rounded"
          >
            Create
          </button>
        </div>
      </div>
      <div className="p-2 rounded-lg mt-16">
        <ul className="methods-list mb-4">
          {methods.map((method) => {
            const editing = selectedMethod?.id === method.id;
            const canEdit = method.authorId === userId;
            return (
              <li key={method.id} className="method-item flex items-center mb-2">
                {editing ? (
                  <input
                    type="text"
                    value={selectedMethod.title}
                    onChange={(e) => setSelectedMethod({ ...selectedMethod, title: e.target.value })}
                    className="input-field px-4 py-2 border rounded mr-2"
                  />
                ) : (
                  <div>
                    <Link to="/method/$id" params={{ id: method.id }} className="text-blue-500 hover:underline m-2">
                      {method.title}
                    </Link>
                  </div>
                )}

                {editing ? (
                  <button
                    onClick={handleUpdate}
                    className="btn btn-update bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded mr-2"
                  >
                    Save
                  </button>
                ) : (
                  <button
                    disabled={!canEdit}
                    onClick={() => setSelectedMethod(method)}
                    className="btn btn-edit bg-yellow-500 hover:bg-yellow-600 text-white px-4 py-2 rounded mr-2"
                  >
                    Edit
                  </button>
                )}

                <button
                  disabled={!canEdit}
                  onClick={() => handleDelete(method.id)}
                  className="btn btn-delete bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded"
                >
                  Delete
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
};
