import { monitorProviders } from './factory-ui/provider-runtime.mjs';
import { initializeProviderConfig } from './factory-ui/provider-config.mjs';
import { handoffRestart, waitForPrevious } from './factory-ui/restart-process.mjs';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FactoryUI } from './factory-ui/service.mjs';
import { createFactoryServer } from './factory-ui/http.mjs';
import { recordFactoryFatalErrors } from './factory-ui/heap-crash.mjs';
import { writeJson } from './factory-ui/common.mjs';
import { cleanProjectAssetUploads } from './factory-ui/stores/runtime.mjs';

// No chat, worker or integration starts until a reviewed browser action is submitted.
async function main() {
  await waitForPrevious(Number(optionValue('--after-pid') || 0));
  const { project, port } = options();
  if (!process.argv.includes('--preview')) {
    recordFactoryFatalErrors(project);
    initializeProviderConfig(project);
  }
  const service = new FactoryUI(project, {
      preview: process.argv.includes('--preview'),
      authoritativeUrl: optionValue('--authoritative-url'),
    }),
    server = createFactoryServer(service, { restart: () => handoffRestart(service, server) });
  server.listen(port, '127.0.0.1', () => {
    if (service.reviewMode === 'live') publishDiscovery(service.root, server);
    console.log(
      `Factory UI: http://127.0.0.1:${server.address().port}/\nProject: ${service.root}\nOpening or refreshing the page does not launch work.`
    );
  });
  const stopProviderMonitoring = monitorProviders(service.root);
  const assetCleanup = setInterval(() => {
    if (service.reviewMode === 'live') void cleanProjectAssetUploads(service).catch(() => {});
  }, 60_000);
  assetCleanup.unref();
  const close = () => {
    clearInterval(assetCleanup);
    stopProviderMonitoring();
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

function publishDiscovery(project, server) {
  const path = join(project, '.issues/factory-discovery.json');
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeJson(path, { port: server.address().port, instanceId: server.instanceId });
  } catch (error) {
    console.warn(`Could not publish Factory discovery: ${error.message}`);
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
