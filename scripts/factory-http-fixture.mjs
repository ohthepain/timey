import { once } from 'node:events';
import { createFactoryServer } from './factory-ui/http.mjs';

export async function startFactoryHttp(t, service) {
  const server = createFactoryServer(service);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(url);
  const cookie = page.headers.get('set-cookie').split(';')[0];
  return { server, url, page, cookie };
}
