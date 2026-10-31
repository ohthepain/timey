import { handoffRestart, waitForPrevious, resumeAfterRestart } from './factory-ui/restart-process.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FactoryUI } from './factory-ui/service.mjs';
import { createFactoryServer } from './factory-ui/http.mjs';

// No chat, worker or integration starts until a reviewed browser action is submitted.
async function main() {
  await waitForPrevious(Number(optionValue('--after-pid') || 0));
  const { project, port } = options();
  const service = new FactoryUI(project, {
      preview: process.argv.includes('--preview'),
      authoritativeUrl: optionValue('--authoritative-url'),
    }),
    server = createFactoryServer(service, { restart: () => handoffRestart(service, server) });
  server.listen(port, '127.0.0.1', () => {
    console.log(
      `Factory UI: http://127.0.0.1:${server.address().port}/\nProject: ${service.root}\nOpening or refreshing the page does not launch work.`
    );
    resumeAfterRestart(service);
  });
  const close = () => {
    service.close();
    server.closeAllConnections();
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

function options() {
  const args = process.argv.slice(2),
    projectIndex = args.indexOf('--project'),
    portIndex = args.indexOf('--port');
  const project = projectIndex < 0 ? process.cwd() : resolve(args[projectIndex + 1]);
  const port = portIndex < 0 ? 0 : Number(args[portIndex + 1]);
  validatePort(port);
  return { project, port };
}

function validatePort(port) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Choose a valid local port.');
}

function optionValue(flag) {
  const index = process.argv.indexOf(flag);
  return index < 0 ? null : process.argv[index + 1];
}
