import { Module } from '~/types/Module';

export const moduleService = {
  async getAllModules(): Promise<Module[]> {
    const response = await fetch('/api/modules');
    if (!response.ok) {
      throw new Error('Failed to fetch modules');
    }
    return response.json();
  },

  async getModuleById(id: string): Promise<Module | null> {
    if (!id) {
      throw new Error('Module ID is required');
    }

    const url = `/api/modules/${id}`;
    console.log('Fetching module with URL:', url);

    const response = await fetch(url);
    if (!response.ok) {
      console.error(`Failed to fetch module. Status: ${response.status}`);
      throw new Error('Failed to fetch module');
    }

    return response.json();
  },

  async createModule(data: Omit<Module, 'id' | 'createdAt' | 'modifiedAt'>): Promise<Module> {
    const response = await fetch('/api/modules', {
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
    const response = await fetch(`/api/modules/${id}`, {
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
    const response = await fetch(`/api/modules/${id}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      throw new Error('Failed to delete module');
    }
    return response.json();
  },
};
