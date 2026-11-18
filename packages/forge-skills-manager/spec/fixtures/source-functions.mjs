import assert from 'node:assert/strict';
import ts from 'typescript';

export function sourceFunctions(source, ...names) {
  const syntax = ts.createSourceFile('client.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const functions = new Map(names.map(name => [name, []]));
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name && functions.has(node.name.text)) functions.get(node.name.text).push(node.getText(syntax));
    ts.forEachChild(node, visit);
  }
  visit(syntax);
  return names.map(name => {
    const matches = functions.get(name);
    assert.equal(matches.length, 1, `Expected exactly one function ${name}`);
    return matches[0];
  }).join('\n');
}
