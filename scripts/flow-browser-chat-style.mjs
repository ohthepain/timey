import assert from 'node:assert/strict';

export async function assertUserMessageBox(messages, text) {
  const entry = messages.locator('article').filter({ has: messages.page().getByText(text, { exact: true }) });
  await entry.waitFor();
  const style = await entry.evaluate((node) => {
    const { backgroundColor, borderRadius, borderStyle, padding } = getComputedStyle(node);
    const parent = node.parentElement;
    const parentRight =
      parent.getBoundingClientRect().left +
      parent.clientLeft +
      parent.clientWidth -
      parseFloat(getComputedStyle(parent).paddingRight);
    return {
      backgroundColor,
      borderRadius,
      borderStyle,
      padding,
      rightAligned: Math.abs(node.getBoundingClientRect().right - parentRight) < 1,
    };
  });
  assert.deepEqual(
    style,
    {
      backgroundColor: 'rgb(35, 37, 37)',
      borderRadius: '9px',
      borderStyle: 'none',
      padding: '18px',
      rightAligned: true,
    },
    text
  );
  return { text, ...style };
}
