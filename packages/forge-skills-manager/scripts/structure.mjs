import ts from 'typescript';
import { posix } from 'node:path';

const parse = (name, text) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const topName = statement => statement.name?.text;

const sections = Object.fromEntries([
  ['1', 'react h FallbackCheckbox DisplayCheckbox HostTag MUTATION_HEADERS NS DICT ROOT_PATH_LOCALES CSS translateOrFallback skillDeclaredInvocationKind isSkillEnabled countKey rootDisplayName normalizeSkillQuery matchSkillQuery filterSkills visibleSkillRoots skillStatus countSkillStatuses sumEnabledDescriptionTokens canToggleSource scopeSkillRoots MAX_UPLOAD_ARCHIVE_BYTES MAX_UPLOAD_ENTRY_BYTES MAX_UPLOAD_TOTAL_BYTES MAX_UPLOAD_ENTRIES uploadFilePath inspectUploadSelection bytesToBase64 SkillSwitch hostButton strokeIcon moreIcon iconButton filterActionButton enableSwitch DSH_ICON_B64 WB_ICON_B64 CCSWITCH_ICON_B64 QODER_P0 QODER_P1 CODEX_D CURSOR_D WINDSURF_D TRAE_D ROO_D CB_P0 CB_P1 OC_P0 OC_P1 OC_P2 getRootBrandIcon resolveRepoBrand renderRepoBrandIconByUrl currentSessionId'],
  ['2', 'parseApiResponse callApi buildUploadPayload readDroppedEntry droppedFiles modalFocusable trapModalFocus recoverModalFocus'],
  ['3', 'localeService hostLocale resolveT workspacePickDirectory availableDirectoryPicker clientMutations SourceSelect destinationKit DestinationPicker useRepositoryUI translateError formatTrashTime summarizeImportResult'],
  ['4', 'Modal SkillManagerSection SkillManagerView'],
  ['5', 'inject apply'],
].flatMap(([section, names]) => names.split(' ').map(name => [name, section])));

const factories = {
  createInstallOperations: ['install-operations.ts', 'index.ts'],
  createManagerStateStore: ['manager-state.ts', 'core.ts'],
  createInstallationManager: ['installations.ts', 'index.ts'],
  createInstallationRecords: ['installation-records.ts', 'installations.ts'],
  createNacosClient: ['nacos.ts', 'index.ts'],
  createProviderRuntime: ['providers.ts', 'index.ts'],
  installProviders: ['providers.ts', 'index.ts'],
  installHttp: ['http.ts', 'index.ts'],
  createClientOperations: ['client-operations.ts', 'client.ts'],
};
const moduleSections = { 'api-errors.ts': '1', 'api-base.ts': '1', 'client-operations.ts': '3', 'nacos-ui.ts': '4', 'nacos-detail.ts': '4' };

const runtimeImport = statement => !statement.importClause?.isTypeOnly &&
  (!statement.importClause?.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings) ||
    statement.importClause.namedBindings.elements.some(element => !element.isTypeOnly));
const runtimeExport = statement => !statement.isTypeOnly &&
  (!statement.exportClause || !ts.isNamedExports(statement.exportClause) || statement.exportClause.elements.some(element => !element.isTypeOnly));
const localTarget = (file, target) => target.startsWith('.') ? posix.normalize(posix.join(posix.dirname(file), target)).replace(/\.(?:js|mjs|ts)$/, '') + '.ts' : undefined;
const unwrap = node => {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isAwaitExpression(node) || ts.isSatisfiesExpression(node))) node = node.expression;
  return node;
};
const propertyName = node => ts.isPropertyAccessExpression(node) ? node.name.text :
  ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;

function sourceGraph(files) {
  const sources = new Map(Object.entries(files).filter(([file]) => file.endsWith('.ts')).map(([file, text]) => ['/' + file, parse('/' + file, text)]));
  const program = ts.createProgram([...sources.keys()], { noLib: true, module: ts.ModuleKind.ESNext }, {
    getSourceFile: file => sources.get(file), getDefaultLibFileName: () => '', writeFile: () => {},
    getCurrentDirectory: () => '/', getDirectories: () => [], getCanonicalFileName: file => file,
    useCaseSensitiveFileNames: () => true, getNewLine: () => '\n', fileExists: file => sources.has(file),
    readFile: file => sources.get(file)?.text,
    resolveModuleNames: (names, containing) => names.map(name => {
      const target = localTarget(containing, name);
      return target && sources.has(target) ? { resolvedFileName: target, extension: ts.Extension.Ts } : undefined;
    }),
  });
  const checker = program.getTypeChecker();
  function origin(node, seen = new Set()) {
    node = unwrap(node);
    if (!node) return undefined;
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteralLike(node.arguments[0])) {
      return { file: localTarget(node.getSourceFile().fileName, node.arguments[0].text), name: '*' };
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const base = origin(node.expression, seen);
      return base?.name === '*' ? { file: base.file, name: propertyName(node) } : undefined;
    }
    if (!ts.isIdentifier(node)) return undefined;
    const symbol = checker.getSymbolAtLocation(node);
    if (!symbol || seen.has(symbol)) return undefined;
    seen.add(symbol);
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (!declaration) return undefined;
    const file = declaration.getSourceFile().fileName.replace(/^\//, '');
    if (ts.isImportSpecifier(declaration) || ts.isNamespaceImport(declaration) || ts.isImportClause(declaration)) {
      let statement = declaration;
      while (!ts.isImportDeclaration(statement)) statement = statement.parent;
      return { file: localTarget(file, statement.moduleSpecifier.text), name: ts.isImportSpecifier(declaration) ? (declaration.propertyName ?? declaration.name).text : '*' };
    }
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const original = origin(declaration.initializer, seen);
      if (original) return original;
    }
    if (ts.isBindingElement(declaration) && ts.isVariableDeclaration(declaration.parent.parent)) {
      const base = origin(declaration.parent.parent.initializer, seen);
      if (base?.name === '*') return { file: base.file, name: (declaration.propertyName ?? declaration.name).text };
    }
    const topLevel = declaration.parent === declaration.getSourceFile() || (ts.isVariableDeclaration(declaration) && declaration.parent.parent.parent === declaration.getSourceFile());
    return { file: topLevel ? file : undefined, name: declaration.name?.text };
  }
  return { sources, checker, origin };
}

// Symbol ownership rather than line counts; fixtures can deliberately violate every boundary.
export function structuralProblems(files) {
  const errors = [];
  const graph = sourceGraph(files);
  const report = (file, source, node, message) => errors.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${message}`);
  const entry = graph.sources.get('/index.ts');
  for (const statement of entry.statements) {
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
      if (!['name', 'inject'].includes(declaration.name.text)) errors.push('entry owns state');
    }
  }
  function checkAssembly(node) {
    if (ts.isVariableDeclarationList(node) && !(node.flags & ts.NodeFlags.Const)) errors.push('entry owns mutable state');
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = node.initializer;
      const factory = ts.isCallExpression(initializer) && graph.origin(initializer.expression);
      const ownership = factory && factories[factory.name];
      if (!factory || !((factory.name === 'makeLog' && factory.file === 'logger.ts') || (ownership?.[1] === 'index.ts' && ownership[0] === factory.file))) errors.push('entry owns state');
    }
    if (ts.isExpressionStatement(node) && (!ts.isCallExpression(node.expression) || !ts.isIdentifier(node.expression.expression) || node.expression.expression.text !== 'installHttp')) errors.push('entry advances state machine');
    ts.forEachChild(node, checkAssembly);
  }
  for (const statement of entry.statements) if (ts.isFunctionDeclaration(statement) && statement.name?.text === 'apply') checkAssembly(statement.body);
  const axes = ['core.ts', 'installations.ts', 'nacos.ts', 'providers.ts', 'http.ts'];
  const factoryCalls = new Map();
  for (const [path, source] of graph.sources) {
    const file = path.slice(1);
    const checkFactory = (node, imported) => {
      const ownership = imported && factories[imported.name];
      if (ownership && imported.file?.replace(/^\//, '') === ownership[0] && file !== ownership[1]) report(file, source, node, `factory ${imported.name} belongs to ${ownership[1]}`);
    };
    function hostVisit(node) {
      if (ts.isTypeNode(node)) return;
      let target;
      if (ts.isImportDeclaration(node) && runtimeImport(node)) {
        target = localTarget(file, node.moduleSpecifier.text);
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) if (!element.isTypeOnly) checkFactory(element, graph.origin(element.name));
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && runtimeExport(node)) {
        target = localTarget(file, node.moduleSpecifier.text);
        const names = node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements.filter(element => !element.isTypeOnly).map(element => (element.propertyName ?? element.name).text) : Object.keys(factories);
        for (const name of names) checkFactory(node, { file: target, name });
      }
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) target = localTarget(file, node.arguments[0].text);
        const imported = graph.origin(node.expression);
        checkFactory(node, imported);
        if (imported && factories[imported.name] && factories[imported.name][0] === imported.file?.replace(/^\//, '')) {
          const key = `${file}:${imported.name}`;
          factoryCalls.set(key, (factoryCalls.get(key) ?? 0) + 1);
          if (factoryCalls.get(key) > 1) report(file, source, node, `duplicate writable owner: ${imported.name}`);
        }
      }
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) checkFactory(node, graph.origin(node));
      if (axes.includes(file) && axes.includes(target)) report(file, source, node, `${file} imports axis ${target}`);
      if (moduleSections[file] && moduleSections[target] && Number(moduleSections[file]) < Number(moduleSections[target])) report(file, source, node, `client module layer §${moduleSections[file]} depends on §${moduleSections[target]} ${target}`);
      ts.forEachChild(node, hostVisit);
    }
    hostVisit(source);
  }
  const clientText = files['client.ts'];
  const client = graph.sources.get('/client.ts');
  const anchors = [...clientText.matchAll(/\/\*! §(\d) [^*]*\*\//g)];
  if (anchors.map(item => item[1]).join('') !== '12345') errors.push('client anchors missing');
  const bundleAnchors = [...files['bundle.js'].matchAll(/\/\*! §(\d) [^*]*\*\//g)];
  if (bundleAnchors.map(item => item[1]).join('') !== '12345') errors.push('bundle anchors missing');
  const symbolSections = new Map();
  const checkSection = (name, position) => {
    const section = anchors.filter(item => item.index < position).at(-1)?.[1];
    symbolSections.set(name, section);
    if (sections[name] && sections[name] !== section) errors.push(`client symbol ${name} outside its section: expected §${sections[name]}, found §${section}`);
  };
  for (const statement of client.statements) {
    checkSection(topName(statement), statement.getStart(client));
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) checkSection(declaration.name.text, statement.getStart(client));
  }
  const importedSections = {
    readApiFailure: ['api-errors.ts', '1'], normalizeApiFailure: ['api-errors.ts', '1'], failureDetails: ['api-errors.ts', '1'],
    isConfirmedRejection: ['api-errors.ts', '1'], decodeOperationOutcome: ['api-errors.ts', '1'],
    createClientOperations: ['client-operations.ts', '3'], createNacosUI: ['nacos-ui.ts', '3'],
    createDestinationKit: ['destination-picker.ts', '3'], createSourceSelect: ['source-select.ts', '3'],
    setupSidebarEntry: ['sidebar-entry.ts', '5'], installSettingsNavIcon: ['settings-nav-icon.ts', '5'],
  };
  function layerVisit(node, section, owner) {
    if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node)) {
      const target = graph.origin(node);
      const imported = importedSections[target?.name];
      const dependency = target?.file === 'client.ts' ? symbolSections.get(target.name) : imported && imported[0] === target?.file ? imported[1] : undefined;
      const property = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node;
      const declaration = node.parent.name === node && (ts.isVariableDeclaration(node.parent) || ts.isFunctionDeclaration(node.parent) || ts.isParameter(node.parent) || ts.isPropertyAssignment(node.parent));
      const injectedView = section === '3' && dependency === '4' && ts.isPropertyAssignment(node.parent) && node.parent.initializer === node &&
        ts.isObjectLiteralExpression(node.parent.parent) && ts.isCallExpression(node.parent.parent.parent) &&
        ['createNacosUI', 'createDestinationKit'].includes(graph.origin(node.parent.parent.parent.expression)?.name);
      if (!property && !declaration && !injectedView && dependency && Number(dependency) > Number(section)) report('client.ts', client, node, `client layer §${section} ${owner} depends on §${dependency} ${target.name}`);
    }
    ts.forEachChild(node, child => layerVisit(child, section, owner));
  }
  for (const statement of client.statements) {
    const section = anchors.filter(item => item.index < statement.getStart(client)).at(-1)?.[1];
    layerVisit(statement, section, topName(statement) ?? (ts.isVariableStatement(statement) ? statement.declarationList.declarations.map(declaration => declaration.name.getText(client)).join(', ') : 'statement'));
  }
  function rawFailure(node, seen = new Set()) {
    node = unwrap(node);
    if (!node) return false;
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return propertyName(node) !== 'details' && rawFailure(node.expression, seen);
    if (!ts.isIdentifier(node)) return false;
    const symbol = graph.checker.getSymbolAtLocation(node);
    if (!symbol || seen.has(symbol)) return false;
    seen.add(symbol);
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (!declaration) return false;
    if (ts.isVariableDeclaration(declaration)) {
      if (ts.isCatchClause(declaration.parent)) return true;
      const initializer = unwrap(declaration.initializer);
      return rawFailure(initializer, seen) || !!(initializer && ts.isCallExpression(initializer) && /^(payload|outcome|failure|error)$/i.test(node.text) && /^(api|callApi)$/.test(initializer.expression.getText()));
    }
    if (ts.isBindingElement(declaration)) return rawFailure(declaration.parent.parent.initializer ?? declaration.parent.parent.name, seen);
    if (!ts.isParameter(declaration)) return ts.isCatchClause(declaration.parent);
    if (/^(error|err|caught|payload|failure|outcome|reason|exception)$/i.test(node.text)) return true;
    const owner = declaration.parent;
    if (/^(decode|readApiFailure|normalizeApiFailure|isConfirmedRejection|translateError)/.test(owner.name?.text ?? '')) return true;
    return ts.isCallExpression(owner.parent) && propertyName(owner.parent.expression) === 'catch';
  }
  function visit(node, owner, source, file) {
    if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) owner = node;
    const ownerName = owner?.name?.text ?? (owner?.parent && ts.isVariableDeclaration(owner.parent) ? owner.parent.name.text : undefined);
    const soleDecoder = file === 'api-errors.ts' && ownerName === 'readApiFailure' && owner?.parent === source;
    const field = propertyName(node);
    const writing = node.parent && ts.isBinaryExpression(node.parent) && node.parent.left === node && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
    if (['code', 'error', 'outcome'].includes(field) && !writing && rawFailure(node.expression) && !soleDecoder) report(file, source, node, 'raw API failure read outside api-errors.ts readApiFailure');
    if (ts.isBindingElement(node) && ['code', 'error', 'outcome'].includes((node.propertyName ?? node.name).text) && rawFailure(node.parent.parent.initializer ?? node.parent.parent.name) && !soleDecoder) report(file, source, node, 'raw API failure destructure outside api-errors.ts readApiFailure');
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InKeyword && ts.isStringLiteralLike(node.left) && ['code', 'error', 'outcome'].includes(node.left.text) && rawFailure(node.right) && !soleDecoder) report(file, source, node, 'raw API failure probe outside api-errors.ts readApiFailure');
    if (ts.isIdentifier(node) && ['fetch', 'localStorage', 'sessionStorage'].includes(node.text)) {
      if (node.text !== 'fetch') errors.push(`${file} owns client persistence`);
      else if (file !== 'client.ts' || ownerName !== 'callApi') errors.push('fetch outside IO adapter');
    }
    if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteral(node.argumentExpression) && ['fetch', 'localStorage', 'sessionStorage'].includes(node.argumentExpression.text)) errors.push(`${file} bypasses IO adapter`);
    if (ts.isCallExpression(node)) {
      if (propertyName(node.expression) === 'json' && (file !== 'client.ts' || ownerName !== 'parseApiResponse')) errors.push('error body reader outside adapter');
    }
    ts.forEachChild(node, child => visit(child, owner, source, file));
  }
  const clientFiles = new Set();
  function collectClient(file) {
    if (clientFiles.has(file)) return;
    clientFiles.add(file);
    if (files[file] === undefined) { errors.push(`client source missing: ${file}`); return; }
    const source = graph.sources.get('/' + file);
    visit(source, undefined, source, file);
    for (const statement of source.statements) {
      if ((!ts.isImportDeclaration(statement) || !runtimeImport(statement)) && (!ts.isExportDeclaration(statement) || !runtimeExport(statement))) continue;
      if (!statement.moduleSpecifier) continue;
      const target = localTarget(file, statement.moduleSpecifier.text);
      if (target) collectClient(target);
    }
    function dynamicVisit(node) {
      if (ts.isTypeNode(node)) return;
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
        const target = localTarget(file, node.arguments[0].text);
        if (target) collectClient(target);
      }
      ts.forEachChild(node, dynamicVisit);
    }
    dynamicVisit(source);
  }
  collectClient('client.ts');
  for (const [file, text] of Object.entries(files)) {
    if (file === 'manager-state.ts' || !file.endsWith('.ts')) continue;
    const source = parse(file, text);
    const policyPaths = new Set();
    const mentionsPolicyPath = node => {
      if (ts.isIdentifier(node) && (node.text === 'managerStatePath' || policyPaths.has(node.text))) return true;
      if (ts.isStringLiteral(node) && node.text === 'state.json') return true;
      return ts.forEachChild(node, mentionsPolicyPath) === true;
    };
    function policyVisit(node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && mentionsPolicyPath(node.initializer)) policyPaths.add(node.name.text);
      if (ts.isCallExpression(node) && /(?:writeFile|writeFileSync|writeFileAtomically|appendFile|rename)$/.test(node.expression.getText(source)) && node.arguments.some(mentionsPolicyPath)) errors.push('manager state write outside owner');
      ts.forEachChild(node, policyVisit);
    }
    policyVisit(source);
  }
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
