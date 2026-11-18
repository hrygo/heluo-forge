import ts from 'typescript';

export function normalizeDependencyIds(text) {
  const source = ts.createSourceFile('client.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const edits = [];
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === '__commonJS') {
      const factory = node.arguments[0];
      if (factory && ts.isObjectLiteralExpression(factory)) for (const member of factory.properties) {
        if (!member.name || !ts.isStringLiteral(member.name)) continue;
        const path = member.name.text.replaceAll('\\', '/');
        const marker = path.lastIndexOf('/node_modules/');
        if (marker >= 0) edits.push({ start: member.name.getStart(source), end: member.name.end, text: JSON.stringify('node_modules/' + path.slice(marker + '/node_modules/'.length)) });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const edit of edits.sort((left, right) => right.start - left.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return text;
}
