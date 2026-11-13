/**
 * 客户端半边构建：src/client.mjs → 包根 client.cjs。
 *
 * 形态沿用 dsh-skills-manager 先例：cjs、React/ui-primitives external
 * （宿主客户端运行时提供模块），产物入库（提交前先跑 build，仓库无 install 期
 * 构建脚本；产物放包根而非 dist/，与 forge-gitee 的 client.js 同约定，
 * 不触发仓库级 dist/ 忽略）。零 TS/JSX：组件用 createElement，无需类型管线。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..');

await build({
  entryPoints: [join(pkg, 'src/client.mjs')],
  outfile: join(pkg, 'client.cjs'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome110'],
  external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client', '@deepseek-ai/dsh-client-ui-primitives'],
  // DSH 客户端模块系统的装载格式（同 dsm 产物）：`__ModuleLoader__.load` 接收
  // factory，factory 内部 shim CJS 的 module/exports/require。
  banner: {
    js: 'window.__ModuleLoader__.load({ id: "@heluo/forge-skill-nacos", factory: (require) => {\nvar module = { exports: {} };\nvar exports = module.exports;',
  },
  footer: {
    js: 'return module.exports;\n}});',
  },
  legalComments: 'none',
  minify: false,
  logLevel: 'info',
});
console.log('client: client.cjs written');
