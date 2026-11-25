import ts from 'typescript';
import { git } from './common.mjs';

const registryPath = 'scripts/browser-scenario-policy.mjs';

export function candidateBrowserScenarioSelector(checkout, commit) {
  let selectors;
  return (flag) => {
    if (!/^--[a-z][a-z0-9-]*$/.test(flag)) return false;
    selectors ??= registeredSelectors(git(checkout, 'show', `${commit}:${registryPath}`));
    return selectors.has(flag);
  };
}

function registeredSelectors(source) {
  // Read the committed registration as data. The issue's module can contain executable code.
  const file = ts.createSourceFile(registryPath, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const registry = file.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find(({ name }) => ts.isIdentifier(name) && name.text === 'flowBrowserScenarioNames')?.initializer;
  if (!registry || !ts.isObjectLiteralExpression(registry))
    throw Error(`Declare flowBrowserScenarioNames as an object in ${registryPath} in the Work candidate.`);
  return new Set(
    registry.properties
      .filter(ts.isPropertyAssignment)
      .filter(({ name }) => ts.isStringLiteral(name))
      .map(({ name }) => name.text)
  );
}
