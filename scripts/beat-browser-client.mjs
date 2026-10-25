import './content-browser-client.mjs';
import { createBeatServerFn, copyBeatServerFn, saveBeatServerFn } from '../src/services/beatService.server.ts';
window.content = { ...window.content, createBeatServerFn, copyBeatServerFn, saveBeatServerFn };
