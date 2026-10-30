import './content-browser-client.mjs';
import { createBeatServerFn, copyBeatServerFn, saveBeatServerFn } from '../src/services/beatService.ts';
window.content = { ...window.content, createBeatServerFn, copyBeatServerFn, saveBeatServerFn };

import { deleteBeatServerFn } from '../src/services/beatService.ts';
import { deleteModuleServerFn } from '../src/services/moduleService.ts';
import { deleteMethodServerFn } from '../src/services/methodService.ts';
window.content = { ...window.content, deleteBeatServerFn, deleteModuleServerFn, deleteMethodServerFn };
