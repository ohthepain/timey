import ts from 'typescript';
import { git } from './common.mjs';
import { flowBrowserCiParts } from '../browser-scenario-policy.mjs';

const registryPath = 'scripts/browser-scenario-policy.mjs';

export function candidateBrowserTestPolicy(checkout, commit) {
  let declarations;
  let selectors;
  let parts;
  const registry = () => (declarations ??= readDeclarations(git(checkout, 'show', `${commit}:${registryPath}`)));
  return {
    isSelector(flag) {
      if (!/^--[a-z][a-z0-9-]*$/.test(flag)) return false;
      selectors ??= registeredSelectors(registry().get('flowBrowserScenarioNames'));
      return selectors.has(flag);
    },
    isCiPart(flag) {
      if (!/^--ci-part=[a-z0-9][a-z0-9-]*$/.test(flag)) return false;
      parts ??= registeredCiParts(registry().get('flowBrowserCiParts'));
      return parts.has(flag);
    },
  };
}

function readDeclarations(source) {
  // Read the committed registration as data. The issue's module can contain executable code.
  const file = ts.createSourceFile(registryPath, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  return new Map(
    file.statements
      .filter(ts.isVariableStatement)
      .flatMap((statement) => [...statement.declarationList.declarations])
      .filter(({ name }) => ts.isIdentifier(name))
      .map(({ name, initializer }) => [name.text, initializer])
  );
}

function registeredSelectors(registry) {
  if (!registry || !ts.isObjectLiteralExpression(registry))
    throw Error(`Declare flowBrowserScenarioNames as an object in ${registryPath} in the Work candidate.`);
  return new Set(
    registry.properties
      .filter(ts.isPropertyAssignment)
      .filter(({ name }) => ts.isStringLiteral(name))
      .map(({ name }) => name.text)
  );
}

function registeredCiParts(declaration) {
  if (!declaration) return flowBrowserCiParts;
  const items = literalSetItems(declaration);
  if (!items || !items.every(ts.isStringLiteral))
    throw Error(
      `Declare flowBrowserCiParts as new Set([...]) with quoted flags in ${registryPath} in the Work candidate.`
    );
  return new Set(items.map(({ text }) => text));
}

function literalSetItems(node) {
  if (!ts.isNewExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== 'Set') return;
  if (node.arguments?.length !== 1) return;
  const [values] = node.arguments;
  if (ts.isArrayLiteralExpression(values)) return values.elements;
}
