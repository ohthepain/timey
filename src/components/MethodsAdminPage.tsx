import { useState, useEffect } from 'react';
import { methodService } from '~/services/methodService';
import { Method } from '@prisma/client';
import { Link } from '@tanstack/react-router';

export const MethodsAdminPage = () => {
  const [methods, setMethods] = useState<Method[]>([]);
  const [newMethodName, setNewMethodName] = useState('');
  const [selectedMethod, setSelectedMethod] = useState<Method | null>(null);

  useEffect(() => {
    fetchMethods();
  }, []);

  const fetchMethods = async () => {
    console.log('Fetching methods...');
    try {
      const response = await methodService.getAllMethods();
      setMethods(response.methods);
    } catch (error) {
      console.error('Error fetching methods:', error);
    }
  };

  const handleCreate = async () => {
    if (!newMethodName.trim()) return;
    try {
      const newMethod = await methodService.createMethod(newMethodName);
      setMethods((prev) => [...prev, newMethod]);
      setNewMethodName('');
    } catch (error) {
      console.error('Error creating method:', error);
    }
  };

  const handleUpdate = async () => {
    if (!selectedMethod) return;

    try {
      const updatedMethod = await methodService.updateMethod(selectedMethod.id, {
        title: selectedMethod.title,
      });
      setMethods((prev) => prev.map((m) => (m.id === updatedMethod.id ? updatedMethod : m)));
      setSelectedMethod(null);
    } catch (error) {
      console.error('Error updating method:', error);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await methodService.deleteMethod(id);
      setMethods((prev) => prev.filter((m) => m.id !== id));
    } catch (error) {
      console.error('Error deleting method:', error);
    }
  };

  return (
    <div className="methods-admin-page m-16">
      <div className="p-2 rounded-lg shadow-lg">
        <h1 className="text-2xl font-bold mb-4">Methods Admin</h1>
        <div className="create-method mb-4">
          <input
            type="text"
            placeholder="New method name"
            value={newMethodName}
            onChange={(e) => setNewMethodName(e.target.value)}
            className="input-field px-4 py-2 border rounded mr-2"
          />
          <button
            onClick={handleCreate}
            className="btn btn-create bg-green-500 hover:bg-green-600 text-white px-4 py-2 rounded"
          >
            Create
          </button>
        </div>
      </div>
      <div className="p-2 rounded-lg mt-16">
        <ul className="methods-list mb-4">
          {methods.map((method) => (
            <li key={method.id} className="method-item flex items-center mb-2">
              {selectedMethod?.id === method.id ? (
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

              {selectedMethod?.id === method.id ? (
                <button
                  onClick={handleUpdate}
                  className="btn btn-update bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded mr-2"
                >
                  Save
                </button>
              ) : (
                <button
                  onClick={() => setSelectedMethod(method)}
                  className="btn btn-edit bg-yellow-500 hover:bg-yellow-600 text-white px-4 py-2 rounded mr-2"
                >
                  Edit
                </button>
              )}

              <button
                onClick={() => handleDelete(method.id)}
                className="btn btn-delete bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};
