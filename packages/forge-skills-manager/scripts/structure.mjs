import ts from 'typescript';

const parse = (name, text) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const topName = statement => statement.name?.text;

// Symbol ownership rather than line counts; fixtures can deliberately violate every boundary.
export function structuralProblems(files) {
  const errors = [];
  const entry = parse('index.ts', files['index.ts']);
  for (const statement of entry.statements) {
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
      if (!['name', 'inject'].includes(declaration.name.text)) errors.push('entry owns state');
    }
  }
  const axes = ['core', 'installations', 'nacos', 'providers', 'http'];
  for (const axis of axes) {
    for (const statement of parse(axis + '.ts', files[axis + '.ts']).statements) {
      if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
      const target = statement.moduleSpecifier.text.replace(/^\.\//, '').replace(/\.js$/, '');
      if (axes.includes(target)) errors.push(`${axis} imports axis ${target}`);
    }
  }
  const clientText = files['client.ts'];
  const client = parse('client.ts', clientText);
  const anchors = [...clientText.matchAll(/\/\*! §(\d) [^*]*\*\//g)];
  if (anchors.map(item => item[1]).join('') !== '12345') errors.push('client anchors missing');
  const bundleAnchors = [...files['bundle.js'].matchAll(/\/\*! §(\d) [^*]*\*\//g)];
  if (bundleAnchors.map(item => item[1]).join('') !== '12345') errors.push('bundle anchors missing');
  const expectedSections = { DICT: '1', parseApiResponse: '2', callApi: '2', localeService: '3', SkillManagerView: '4', apply: '5' };
  const checkSection = (name, position) => {
    const section = anchors.filter(item => item.index < position).at(-1)?.[1];
    if (expectedSections[name] && expectedSections[name] !== section) errors.push(`client symbol ${name} outside its section`);
  };
  for (const statement of client.statements) {
    checkSection(topName(statement), statement.getStart(client));
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) checkSection(declaration.name.text, statement.getStart(client));
  }
  function visit(node, owner) {
    if (ts.isFunctionDeclaration(node)) owner = node.name?.text;
    if (ts.isCallExpression(node)) {
      if (node.expression.getText(client) === 'fetch' && owner !== 'callApi') errors.push('fetch outside IO adapter');
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'json' && owner !== 'parseApiResponse') errors.push('error body reader outside adapter');
    }
    ts.forEachChild(node, child => visit(child, owner));
  }
  visit(client, undefined);
  if (/localStorage|sessionStorage/.test(clientText)) errors.push('client persistence outside host');
  if ((files['bundle.js'].match(/window\.__ModuleLoader__\.load\(/g) ?? []).length !== 1 || /import\s.*src\//.test(files['bundle.js'])) errors.push('client must have one bundle');
  if (/clawhub|skills\.sh|codeload\.github/i.test(files['nacos-ui.ts'])) errors.push('public discovery provider');
  for (const file of ['nacos-detail.ts', 'nacos-styles.ts']) {
    if (/\bfetch\s*\(|localStorage|sessionStorage/.test(files[file] ?? '')) errors.push(`${file} owns network or persistence`);
  }
  for (const match of files['bundle.js'].matchAll(/\brequire\(["']([^"']+)["']\)/g)) {
    if (!['react', '@deepseek-ai/dsh-client-ui-primitives'].includes(match[1])) errors.push(`client external dependency: ${match[1]}`);
  }
  if (/__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED/.test(files['bundle.js'])) errors.push('client depends on private React internals');
  return errors;
}
