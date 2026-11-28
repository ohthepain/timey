import { resolve } from 'node:path';

export default async function* passedCases(events) {
  for await (const { type, data } of events) {
    if (type === 'test:pass' && passedCase(data)) {
      yield JSON.stringify(data.name) + '\n';
    }
  }
}

function passedCase(data) {
  return data.details.type === 'test' && hasNoDirective(data) && isNamedTest(data);
}

function hasNoDirective({ skip, todo }) {
  return skip === undefined && todo === undefined;
}

function isNamedTest({ entryFile, name, file }) {
  return Boolean(entryFile) || resolve(name) !== file;
}
