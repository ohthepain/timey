import './content-browser-client.mjs';
import { createBeatServerFn, copyBeatServerFn, saveBeatServerFn } from '../src/services/beatService.server.ts';
window.content = { ...window.content, createBeatServerFn, copyBeatServerFn, saveBeatServerFn };

import { deleteBeatServerFn } from '../src/services/beatService.server.ts';
import { deleteModuleServerFn } from '../src/services/moduleService.server.ts';
import { deleteMethodServerFn } from '../src/services/methodService.server.ts';
window.content = { ...window.content, deleteBeatServerFn, deleteModuleServerFn, deleteMethodServerFn };
