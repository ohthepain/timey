// Loaded by the disposable browser proof through Vite; these are real server-function requests.
import {
  createMethodServerFn,
  updateMethodServerFn,
  getAllMethodsServerFn,
  getMethodByIdServerFn,
} from '../src/services/methodService.ts';
import {
  createModuleServerFn,
  updateModuleServerFn,
  getAllModulesServerFn,
  getModuleByIdServerFn,
} from '../src/services/moduleService.ts';

window.content = {
  createMethodServerFn,
  updateMethodServerFn,
  getAllMethodsServerFn,
  getMethodByIdServerFn,
  createModuleServerFn,
  updateModuleServerFn,
  getAllModulesServerFn,
  getModuleByIdServerFn,
};
