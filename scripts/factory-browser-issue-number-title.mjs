export default async function issueNumberTitleBrowserChecks(page) {
  await page.goto(new URL('/#/issue/b', page.url()).href);
  const number = page.locator('.issue-title .issue-number');
  const title = page.locator('.issue-title h1');
  if ((await number.textContent()) !== '#1') throw Error('Issue number is missing from the title row.');
  if (((await number.evaluate((element) => element.compareDocumentPosition(element.nextElementSibling))) & 4) === 0)
    throw Error('Issue number does not appear before the title.');
  const sizes = await Promise.all([
    number.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
    title.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
  ]);
  if (sizes[0] >= sizes[1]) throw Error('Issue number must remain smaller than the title.');
  return { passed: true, assertions: ['number before title', 'number smaller than title'] };
}
