import { Method } from '~/types/Method';

export const methodService = {
  async getAllMethods(): Promise<Method[]> {
    let url = `/api/methods`;
    if (typeof window === 'undefined') {
      // Server-side: use absolute URL - on ChatGPT's recommendation
      const base = process.env.API_BASE_URL;
      url = `${base}/api/methods`;
    }
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error('Failed to fetch methods');
    }
    const result = await response.json();
    console.log('Methods:', result);
    return result;
  },

  async createMethod(title: string): Promise<Method> {
    let url = `/api/methods`;
    if (typeof window === 'undefined') {
      // Server-side: use absolute URL - on ChatGPT's recommendation
      const base = process.env.API_BASE_URL;
      url = `${base}/api/methods`;
    }
    const response = await fetch(url, {
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
    let url = `/api/methods/${id}`;
    if (typeof window === 'undefined') {
      // Server-side: use absolute URL - on ChatGPT's recommendation
      const base = process.env.API_BASE_URL;
      url = `${base}/api/methods/${id}`;
    }
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error('Failed to fetch method');
    }
    return response.json();
  },

  async updateMethod(id: string, data: Partial<Omit<Method, 'id' | 'createdAt' | 'modifiedAt'>>): Promise<Method> {
    let url = `/api/methods/${id}`;
    if (typeof window === 'undefined') {
      // Server-side: use absolute URL - on ChatGPT's recommendation
      const base = process.env.API_BASE_URL;
      url = `${base}/api/methods/${id}`;
    }
    const response = await fetch(url, {
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
    let url = `/api/methods/${id}`;
    if (typeof window === 'undefined') {
      // Server-side: use absolute URL - on ChatGPT's recommendation
      const base = process.env.API_BASE_URL;
      url = `${base}/api/methods/${id}`;
    }
    const response = await fetch(url, {
      method: 'DELETE',
    });
    if (!response.ok) {
      throw new Error('Failed to delete method');
    }
    return response.json();
  },
};
