import assert from 'node:assert/strict';
import test from 'node:test';
import { readPriorities } from './factory-ui/priorities.mjs';

test('priority tables accept formatted and aligned Markdown dividers', () => {
  const expected = [
    { id: 'critical', name: 'Critical', color: '#ef4444', meaning: 'Core functionality is broken.' },
    { id: 'major', name: 'Major', color: '#eab308', meaning: 'A significant feature is broken.' },
    { id: 'custom', name: 'Custom', color: '#123abc', meaning: 'A project-specific priority.' },
  ];
  for (const divider of [
    '| --- | --- | --- |',
    '| ----------- | ------ | --------------------------------------------------- |',
    '| :---------- | -----: | :------------------------------------------------: |',
    '| :--- | :---: | ---: |',
  ]) {
    const markdown = `## Issue Priorities

| Name        | Color   | Meaning                          |
${divider}
| Critical    | Red     | Core functionality is broken.    |
| Major       | Yellow  | A significant feature is broken. |
| Custom      | #123abc | A project-specific priority.     |
`;
    assert.deepEqual(readPriorities(markdown), expected, divider);
  }
});

test('priority tables still reject malformed priority choices', () => {
  const markdown = `## Issue Priorities

| Name | Color | Meaning |
| --- | --- | --- |
| Major | Yellow | Default priority. |
| Critical | Unsupported | Core functionality is broken. |
`;
  assert.throws(readPriorities.bind(null, markdown), /Each issue priority needs a name/);
});

test('a malformed divider row is not silently discarded', () => {
  const markdown = `## Issue Priorities

| Name | Color | Meaning |
| ----------- | invalid | ----------- |
| Major | Yellow | Default priority. |
`;
  assert.throws(readPriorities.bind(null, markdown), /Each issue priority needs a name/);
});
