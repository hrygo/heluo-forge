import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
// Exercise the real source components without emitting files into the repository.
const compiled = await build({
  stdin: { contents: 'export * from "./src/nacos-ui.ts"; export * from "./src/nacos-detail.ts"; export * from "./src/destination-picker.ts"; export * from "./src/client-jsx-runtime.ts"; export * from "./src/api-errors.ts"; export * from "./src/client-operations.ts";', resolveDir: root },
  bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent',
  plugins: [{ name: 'test-dependencies', setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }],
});
export const clientModule = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
