export async function fixtureRoute(page, pattern, handler, options) {
  const active = new Set();
  const wrapped = async (route) => {
    const operation = Promise.resolve().then(() => handler(route));
    active.add(operation);
    try {
      await operation;
    } finally {
      active.delete(operation);
    }
  };
  await page.route(pattern, wrapped, options);
  return async (onRemoved) => {
    await page.unroute(pattern, wrapped);
    onRemoved?.();
    await Promise.all(active);
  };
}
