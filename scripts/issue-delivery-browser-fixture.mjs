import { deliveryScenario, ready } from './issue-delivery-scenario.mjs';
import { FactoryUI } from './factory-ui/service.mjs';
import { createFactoryServer } from './factory-ui/http.mjs';

// Opt-in disposable UI smoke fixture, never a live remote/provider.
if (process.argv.includes('--serve')) {
  const cleanup = [];
  const scenario = await deliveryScenario({ after: (fn) => cleanup.push(fn) }, 'human-first');
  await ready(scenario);
  const service = new FactoryUI(scenario.root);
  service.deliveries = scenario.delivery;
  const server = createFactoryServer(service);
  server.listen(0, '127.0.0.1', () =>
    console.log(
      JSON.stringify({
        url: 'http://127.0.0.1:' + server.address().port,
        issueId: scenario.issueId,
        root: scenario.root,
        simulated: true,
      })
    )
  );
  process.on('SIGINT', () => {
    server.close();
    service.close();
    cleanup.reverse().forEach((fn) => fn());
    process.exit();
  });
}
