import { moduleRepository } from '~/repositories/moduleRepository';
import { Module } from '@prisma/client';

export const moduleService = {
  async getAllModules(): Promise<Module[]> {
    return await moduleRepository.getAllModules();
  },

  async getModuleById(id: string): Promise<Module | null> {
    return await moduleRepository.getModuleById(id);
  },

  async createModule(data: Omit<Module, 'id' | 'createdAt' | 'modifiedAt'>): Promise<Module> {
    return await moduleRepository.createModule(data);
  },

  async updateModule(id: string, data: Partial<Omit<Module, 'id' | 'createdAt' | 'modifiedAt'>>): Promise<Module> {
    return await moduleRepository.updateModule(id, data);
  },

  async deleteModule(id: string): Promise<Module> {
    return await moduleRepository.deleteModule(id);
  },
};
