import { readQueue } from './data.mjs';
import { persistImplementationOrder } from './implementation-order.mjs';

export function changeImplementationOrder(service, input) {
  service.ownServer();
  const queue = readQueue(service.root);
  return persistImplementationOrder(service.root, queue, input);
}
