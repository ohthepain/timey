import { Method } from '~/types/Method';

export const methodService = {
  async getAllMethods(): Promise<Method[]> {
    const response = await fetch('/api/methods');
    if (!response.ok) {
      throw new Error('Failed to fetch methods');
    }
    const result = await response.json();
    console.log('Methods:', result);
    return result;
  },

  async createMethod(title: string): Promise<Method> {
    const response = await fetch('/api/methods', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    if (!response.ok) {
      throw new Error('Failed to create method');
    }
    return response.json();
  },

  async getMethodById(id: string): Promise<Method | null> {
    const response = await fetch(`/api/methods/${id}`);
    if (!response.ok) {
      throw new Error('Failed to fetch method');
    }
    return response.json();
  },

  async updateMethod(id: string, data: Partial<Omit<Method, 'id' | 'createdAt' | 'modifiedAt'>>): Promise<Method> {
    const response = await fetch(`/api/methods/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!response.ok) {
      throw new Error('Failed to update method');
    }
    return response.json();
  },

  async deleteMethod(id: string): Promise<Method> {
    const response = await fetch(`/api/methods/${id}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      throw new Error('Failed to delete method');
    }
    return response.json();
  },
};
