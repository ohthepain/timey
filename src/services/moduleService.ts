import { Module } from '~/types/Module';

export const moduleService = {
  async getAllModules(): Promise<Module[]> {
    let url = `/api/modules`;
    if (typeof window === 'undefined') {
      // Server-side: use absolute URL - on ChatGPT's recommendation
      const base = process.env.API_BASE_URL;
      console.log('Server-side API base URL:', base);
      url = `${base}/api/modules`;
    }
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error('Failed to fetch modules');
    }
    return response.json();
  },

  async getModuleById(id: string): Promise<Module | null> {
    let url = `/api/modules/${id}`;
    if (typeof window === 'undefined') {
      // Server-side: use absolute URL - on ChatGPT's recommendation
      const base = process.env.API_BASE_URL;
      console.log('Server-side API base URL:', base);
      url = `${base}/api/modules/${id}`;
    }
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error('Failed to fetch module');
    }
    return response.json();
  },

  async createModule(data: Omit<Module, 'id' | 'createdAt' | 'modifiedAt'>): Promise<Module> {
    let url = `/api/modules`;
    if (typeof window === 'undefined') {
      // Server-side: use absolute URL - on ChatGPT's recommendation
      const base = process.env.API_BASE_URL;
      console.log('Server-side API base URL:', base);
      url = `${base}/api/modules`;
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!response.ok) {
      throw new Error('Failed to create module');
    }
    return response.json();
  },

  async updateModule(id: string, data: Partial<Omit<Module, 'id' | 'createdAt' | 'modifiedAt'>>): Promise<Module> {
    let url = `/api/modules/${id}`;
    if (typeof window === 'undefined') {
      // Server-side: use absolute URL - on ChatGPT's recommendation
      const base = process.env.API_BASE_URL;
      console.log('Server-side API base URL:', base);
      url = `${base}/api/modules/${id}`;
    }
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!response.ok) {
      throw new Error('Failed to update module');
    }
    return response.json();
  },

  async deleteModule(id: string): Promise<Module> {
    let url = `/api/modules/${id}`;
    if (typeof window === 'undefined') {
      // Server-side: use absolute URL - on ChatGPT's recommendation
      const base = process.env.API_BASE_URL;
      console.log('Server-side API base URL:', base);
      url = `${base}/api/modules/${id}`;
    }
    const response = await fetch(url, {
      method: 'DELETE',
    });
    if (!response.ok) {
      throw new Error('Failed to delete module');
    }
    return response.json();
  },
};
