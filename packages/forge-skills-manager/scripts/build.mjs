import { build } from 'esbuild';
import { readdir, mkdir, rename, rm, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { normalizeDependencyIds } from './build-identities.mjs';

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function buildPlugin(output = join(packageRoot, 'lib'), root = packageRoot) {
  const source = join(root, 'src');
  const hostFiles = (await readdir(source)).filter(name => name.endsWith('.ts') && !name.endsWith('.d.ts') && ![
    'client.ts', 'client-types.ts', 'client-jsx-runtime.ts', 'client-operations.ts', 'api-errors.ts', 'nacos-ui.ts', 'nacos-detail.ts', 'nacos-styles.ts', 'destination-picker.ts', 'destination-types.ts',
    'plugin-ui.ts', 'settings-nav-icon.ts', 'sidebar-entry.ts', 'source-select.ts',
    'source-select-model.ts', 'management-locales.ts', 'types.ts', 'host-types.ts', 'local-ports.ts', 'zip.ts',
  ].includes(name));
  await mkdir(output, { recursive: true });
  await build({ absWorkingDir: root, entryPoints: hostFiles.map(name => join(source, name)), outdir: output, outbase: source,
    bundle: false, format: 'esm', platform: 'node', target: 'node24', legalComments: 'none', logLevel: 'silent' });
  await build({ absWorkingDir: root, entryPoints: [join(source, 'zip.ts')], outfile: join(output, 'zip.js'),
    bundle: true, format: 'esm', platform: 'node', target: 'node24', legalComments: 'none', logLevel: 'silent' });
  const zipPath = join(output, 'zip.js');
  await writeFile(zipPath, (await readFile(zipPath, 'utf8')).replace(/^\/\/ [^\r\n]*\/node_modules\/[^\r\n]*\r?\n/gm, ''));
  await build({ absWorkingDir: root, entryPoints: [join(source, 'client.ts')], outfile: join(output, 'client.js'),
    bundle: true, format: 'cjs', platform: 'browser', target: 'es2022', minify: false,
    external: ['@deepseek-ai/dsh-client-ui-primitives'], legalComments: 'none',
    plugins: [{ name: 'host-react', setup(builder) {
      builder.onResolve({ filter: /^react$/ }, () => ({ path: 'react', external: true }));
      builder.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: join(source, 'client-jsx-runtime.ts') }));
      // Use the package's universal implementation; loading the plugin must not
      // allocate DOM nodes before the Host mounts it (including headless probes).
      builder.onResolve({ filter: /^decode-named-character-reference$/ }, args => ({ path: createRequire(args.importer).resolve(args.path) }));
    } }],
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
    banner: { js: 'window.__ModuleLoader__.load({ id: "@heluo/forge-skills-manager", factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;' },
    footer: { js: 'return module.exports;\n} });' } });
  // esbuild's dependency-location comments are package-manager internals, not
  // source anchors; removing them keeps generated paths deterministic.
  const clientPath = join(output, 'client.js');
  let client = (await readFile(clientPath, 'utf8')).replace(/^\/\/ [^\r\n]*\/node_modules\/[^\r\n]*\r?\n/gm, '');
  client = normalizeDependencyIds(client);
  // Restore only the source section boundaries beside their emitted symbols.
  const clientSource = await readFile(join(source, 'client.ts'), 'utf8');
  const anchors = [...clientSource.matchAll(/(\/\*! §\d [^*]*\*\/)\s*(var|function) (\w+)/g)];
  if (anchors.length !== 5) throw new Error('client source section boundaries missing');
  for (const [, anchor, kind, symbol] of anchors) {
    const declaration = new RegExp(`^${kind} ${symbol}\\b`, 'gm');
    if ([...client.matchAll(declaration)].length !== 1) throw new Error(`client section boundary target changed: ${symbol}`);
    client = client.replace(declaration, match => `${anchor}\n${match}`);
  }
  await writeFile(clientPath, client);
}

export async function publishBuild() {
  const stage = join(packageRoot, `.build-${randomUUID()}`);
  const previous = join(packageRoot, `.build-backup-${randomUUID()}`);
  const output = join(packageRoot, 'lib');
  let moved = false;
  try {
    await buildPlugin(stage);
    try { await rename(output, previous); moved = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await rename(stage, output); }
    catch (error) { if (moved) await rename(previous, output); throw error; }
    if (moved) await rm(previous, { recursive: true, force: true });
  } finally { await rm(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await publishBuild();
  console.log('forge-skills-manager: built Host modules, bundled ZIP adapter and one client bundle');
}
