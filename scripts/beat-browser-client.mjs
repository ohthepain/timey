import './content-browser-client.mjs';
import { createBeatServerFn, copyBeatServerFn } from '../src/services/beatService.server.ts';
window.content = { ...window.content, createBeatServerFn, copyBeatServerFn };
