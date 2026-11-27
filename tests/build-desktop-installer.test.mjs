/**
 * Installer configuration tests (CORP-DSH-PLAN-026 §4.3-7).
 *
 * Every identity-bearing field of the electron-builder configuration must
 * come from the employee package's app-identity.json truth — and that truth
 * itself must equal the release lane's APP_IDENTITY, so the OS-level app and
 * the plugin brand can never drift apart.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { APP_IDENTITY } from '../scripts/release-delivery.mjs';
import { afterPack, KEEP_MAC_LPROJ, pruneMacLocales } from '../scripts/lib/desktop-after-pack.mjs';
import { THIRD_PARTY_DIR_DEPTH, THIRD_PARTY_NESTING_DEPTH, assertSafeCertificatePath, builderConfig, builderEntry, builderEnv, isPackaged, localCertificatePath, normalizeVersion, parseArguments, readAppIdentity, resolveTargetArch, runtimeFilter, summarizeResources, validateBuilderEnvFile } from '../scripts/build-desktop-installer.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRAND_DIR = join(REPO_ROOT, 'docs', 'assets', 'branding', 'cyber-long');

function temp(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-installer-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function identityFile(root, overrides = {}) {
  const path = join(root, 'app-identity.json');
  writeFileSync(path, `${JSON.stringify({ schema: 'heluo-app-identity/1', ...APP_IDENTITY, version: '1.2.3-corp.1', brandManifest: 'test', ...overrides })}\n`);
  return path;
}

test('身份读取：schema 与五元组必填，缺字段即拒', (t) => {
  const root = temp(t);
  assert.equal(readAppIdentity(identityFile(root)).appId, APP_IDENTITY.appId);
  assert.throws(() => readAppIdentity(identityFile(root, { appId: '' })), (error) => error.code === 'IDENTITY_INVALID');
  assert.throws(() => readAppIdentity(identityFile(root, { schema: 'other/1' })), (error) => error.code === 'IDENTITY_INVALID');
});

test('配置逐字段来自身份真源：appId/GUID/productName/可执行名/产物名/卸载展示名', (t) => {
  const root = temp(t);
  const identity = readAppIdentity(identityFile(root));
  const config = builderConfig({ identity, version: '1.2.3', resourcesDir: join(root, 'resources'), iconsDir: join(BRAND_DIR, 'icons'), appDir: join(REPO_ROOT, 'services', 'forge-desktop'), outputDir: join(root, 'dist') });
  assert.equal(config.appId, APP_IDENTITY.appId);
  assert.equal(config.productName, APP_IDENTITY.productName);
  assert.equal(config.executableName, APP_IDENTITY.executableName);
  assert.equal(config.nsis.guid, APP_IDENTITY.upgradeGuid);
  assert.equal(config.nsis.uninstallDisplayName, `${APP_IDENTITY.displayName} \${version}`);
  assert.equal(config.nsis.deleteAppDataOnUninstall, false);
  assert.equal(config.artifactName, 'heluo-forge-enterprise-${version}-${arch}.${ext}');
  assert.equal(config.nsis.artifactName, 'heluo-forge-enterprise-${version}-setup-${arch}.${ext}');
  assert.equal(config.extraMetadata.version, '1.2.3');
  assert.deepEqual(config.win.target, [{ target: 'nsis', arch: ['x64'] }]);
  assert.equal(config.extraResources.length, 1);
  assert.equal(existsSync(config.win.icon), true, 'the referenced .ico must exist in the brand suite');
  assert.equal(existsSync(config.mac.icon), true, 'the referenced .icns must exist in the brand suite');
});

test('配置反向：换掉身份任一字段，配置随之偏离真源（判据会失败）', (t) => {
  const root = temp(t);
  const real = builderConfig({ identity: readAppIdentity(identityFile(root)), version: '1', resourcesDir: 'r', iconsDir: 'i', appDir: 'a', outputDir: 'o' });
  for (const field of ['appId', 'upgradeGuid', 'productName', 'executableName', 'displayName']) {
    const doctored = builderConfig({ identity: readAppIdentity(identityFile(root, { [field]: 'doctored' })), version: '1', resourcesDir: 'r', iconsDir: 'i', appDir: 'a', outputDir: 'o' });
    const differs = real.appId !== doctored.appId || real.nsis.guid !== doctored.nsis.guid || real.nsis.uninstallDisplayName !== doctored.nsis.uninstallDisplayName || real.productName !== doctored.productName || real.executableName !== doctored.executableName || real.artifactName !== doctored.artifactName;
    assert.equal(differs, true, `tampering ${field} must change the configuration`);
  }
});

test('安装包内容：运行时不读取的文件类型与第三方文档测试不进包，台账钉定的制品、内置运行时、@deepseek-ai 文档与许可原样保留', () => {
  // 规则只认文件类型与目录归属：同一个 .d.ts，在制品目录内留下，在闭包里裁掉。
  assert.equal(isPackaged('dsh/node_modules/@deepseek-ai/dsh/lib/types/bin.d.ts'), true);
  assert.equal(isPackaged('dsh/node_modules/@deepseek-ai/dsh-llm/lib/types/index.d.ts'), false);
  // 反向：被裁的类型换成 .js 就必须留下，否则规则裁掉了整个目录而不只是无用文件。
  for (const excluded of ['core/index.ts', 'api/index.d.cts', 'api/index.d.mts', 'index.js.map', 'prebuilds/win32-x64/conpty.pdb']) {
    assert.equal(isPackaged(`dsh/node_modules/pkg/lib/${excluded}`), false, excluded);
  }
  assert.equal(isPackaged('dsh/node_modules/pkg/lib/index.js'), true);
  // 第三方包（非 @deepseek-ai）里的测试、示例、docs、CHANGELOG 与非许可 markdown 一并裁掉。
  for (const excluded of [
    'dsh/node_modules/openai/README.md',
    'dsh/node_modules/pkg/CHANGELOG.md',
    'dsh/node_modules/pkg/HISTORY.txt',
    'dsh/node_modules/pkg/test/foo.js',
    'dsh/node_modules/pkg/tests/bar.js',
    'dsh/node_modules/pkg/__tests__/baz.js',
    'dsh/node_modules/@scope/pkg/docs/guide.md',
    'dsh/node_modules/@scope/pkg/example/demo.js',
    'dsh/node_modules/@scope/pkg/examples/demo.js',
    'dsh/node_modules/pkg/lib/index.js.flow',
    'dsh/node_modules/pkg/.flow',
    'dsh/node_modules/pkg/.eslintrc.json',
    'dsh/node_modules/pkg/.prettierrc.yml',
    'dsh/node_modules/pkg/.editorconfig',
    'dsh/node_modules/pkg/tsconfig.json',
    'dsh/node_modules/pkg/tsconfig.build.json',
    'dsh/node_modules/pkg/.github/workflows/ci.yml',
    'dsh/node_modules/pkg/.vscode/settings.json',
    'dsh/node_modules/pkg/fixtures/test.json',
    'dsh/node_modules/pkg/fixtures',
    'dsh/node_modules/@scope/fixtures/fixtures/test.json',
    'dsh/node_modules/pkg/node_modules/fixtures/fixtures/test.json',
    'dsh/node_modules/pkg/__fixtures__/mock.json',
    // 包内第 4 层及更深的文档与排除目录、第二层嵌套依赖：文件名规则不限深度，目录规则在枚举深度之内逐层生效。
    'dsh/node_modules/pkg/a/b/c/d/README.md',
    'dsh/node_modules/pkg/a/b/c/d/e/f/CHANGELOG.rst',
    'dsh/node_modules/pkg/a/b/c/d/test/x.js',
    'dsh/node_modules/pkg/a/b/c/d/e/f/g/test/x.js',
    'dsh/node_modules/pkg/node_modules/a/node_modules/b/test/x.js',
    'dsh/node_modules/pkg/node_modules/a/node_modules/b/node_modules/c/README.md',
    'dsh/node_modules/pkg/lib/vendor/node_modules/dep/README.md',
    `dsh/node_modules/pkg/${'a/'.repeat(THIRD_PARTY_DIR_DEPTH - 1)}test/x.js`,
    // 文档名不区分大小写，与许可证同名规则一致。
    'dsh/node_modules/pkg/README.MD',
    'dsh/node_modules/@scope/pkg/lib/History.rst',
    'dsh/node_modules/pkg/.md',
    // `dsh/node_modules` 之外没有再包含规则：与排除类型同后缀的目录连同内容一并裁掉。
    'brand/x.ts/icon.png',
  ]) {
    assert.equal(isPackaged(excluded), false, excluded);
  }
  // 第三方包的许可证文件（MIT/Apache 等版权保留义务合规保留，包含 fixtures 等子目录内的许可证）与 @deepseek-ai 作用域下的文档/技能文本必须保留；
  // 顶层与嵌套依赖包名恰好为 fixtures 时其入口保留；与排除规则同前缀但非配置的正常源码（如 tsconfig-loader.js、.npmignore-helper.js）不得被误伤。
  for (const kept of [
    'dsh/node_modules/fixtures/index.js',
    'dsh/node_modules/@scope/fixtures/index.js',
    'dsh/node_modules/pkg/node_modules/fixtures/index.js',
    'dsh/node_modules/pkg/node_modules/@scope/fixtures/index.js',
    'dsh/node_modules/tsconfig.json',
    'dsh/node_modules/zod/LICENSE.md',
    'dsh/node_modules/pkg/license.txt',
    'dsh/node_modules/pkg/NOTICE',
    'dsh/node_modules/pkg/COPYING',
    'dsh/node_modules/pkg/fixtures/LICENSE.md',
    'dsh/node_modules/pkg/fixtures/NOTICE.flow',
    'dsh/node_modules/pkg/lib/tsconfig-loader.js',
    'dsh/node_modules/pkg/lib/.npmignore-helper.js',
    'dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js',
    'dsh/node_modules/@deepseek-ai/dsh-llm/README.md',
    'dsh/node_modules/@deepseek-ai/dsh-llm/docs/prompt.md',
    'dsh/node_modules/@deepseek-ai/dsh-llm/NOTICE.flow',
    'dsh/node_modules/.package-lock.json',
    // 同一深层目录里的许可证保留。包根之下更深处才出现的 node_modules 不在枚举的依赖作用域内：其下的目录名不再受目录规则约束（文件名规则仍然生效）。
    'dsh/node_modules/pkg/a/b/c/d/LICENSE.md',
    'dsh/node_modules/pkg/a/b/c/d/e/index.js',
    'dsh/node_modules/pkg/lib/vendor/node_modules/dep/test/x.js',
    'dsh/node_modules/pkg/node_modules/a/node_modules/b/node_modules/c/lib/index.js',
    // 枚举边界之外目录规则不再生效：摘要如实计为随包，与过滤器一致。
    `dsh/node_modules/pkg/${'a/'.repeat(THIRD_PARTY_DIR_DEPTH)}test/x.js`,
    `dsh/node_modules/pkg/${'node_modules/dep/'.repeat(THIRD_PARTY_NESTING_DEPTH)}test/x.js`,
    // 许可证再包含排在排除之后，`dsh/node_modules` 与原样目录内同后缀的目录仍可进入。
    'dsh/node_modules/pkg/x.ts/a.js',
    'primary-runtime/x.ts/a.js',
    'brand/tray.png',
    'brand/status.html',
    'enterprise-assets/employee-manifest.json',
    'enterprise-assets/INSTALL.md',
  ]) {
    assert.equal(isPackaged(kept), true, kept);
  }
  // 内置运行时是暂存后检查过、并按文件数与字节数记入构建记录的那棵树：进包的必须就是它。
  assert.equal(isPackaged('primary-runtime/dependencies/pnpm/dist/node_modules/fdir/dist/index.d.mts'), true);
  assert.equal(isPackaged('pnpm/dist/node_modules/fdir/dist/index.d.mts'), false);
  assert.equal(isPackaged('primary-runtime/dependencies/python/lib/python3.12/site-packages/numpy/tests.map'), true);
  assert.equal(isPackaged('primary-runtime-other/lib/index.d.ts'), false);
});

test('过滤一致性：isPackaged 与打包过滤器对同一路径判定相同，目录被拒后子树不再进入', (t) => {
  // 取 electron-builder 复制 extraResources 所用的同一条路径（FileMatcher.createFilter），不手工拼 minimatch。
  let builder;
  try {
    const shell = createRequire(join(REPO_ROOT, 'services', 'forge-desktop', 'package.json'));
    builder = createRequire(createRequire(shell.resolve('electron-builder')).resolve('app-builder-lib'));
  } catch {
    t.skip('未安装锁定的开发依赖（pnpm install --frozen-lockfile --ignore-scripts），取不到 app-builder-lib');
    return;
  }
  const { FileMatcher } = builder('./fileMatcher.js');
  const admit = new FileMatcher('/res', '/dest', (pattern) => pattern, runtimeFilter()).createFilter();
  // builder-util 的 walk 对目录也调用过滤器，目录被拒后不再进入其子树；文件按自身路径判定。
  const copied = (rel) => {
    const segments = rel.split('/');
    let admitted = true;
    for (let end = 1; admitted && end <= segments.length; end += 1) {
      admitted = admit(`/res/${segments.slice(0, end).join('/')}`, { isDirectory: () => end < segments.length });
    }
    return admitted;
  };
  for (const rel of [
    'dsh/node_modules/@deepseek-ai/dsh/lib/types/bin.d.ts',
    'dsh/node_modules/@deepseek-ai/dsh-llm/lib/types/index.d.ts',
    'dsh/node_modules/@deepseek-ai/dsh-llm/README.md',
    'dsh/node_modules/@deepseek-ai/dsh-llm/docs/prompt.md',
    'dsh/node_modules/@deepseek-ai/dsh-llm/NOTICE.flow',
    'dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js.flow',
    'dsh/node_modules/openai/README.md',
    'dsh/node_modules/zod/LICENSE.md',
    'dsh/node_modules/pkg/license.txt',
    'dsh/node_modules/pkg/NOTICE',
    'dsh/node_modules/pkg/test/foo.js',
    'dsh/node_modules/@scope/pkg/docs/guide.md',
    'dsh/node_modules/pkg/lib/index.js.flow',
    'dsh/node_modules/pkg/.flow',
    'dsh/node_modules/pkg/.eslintrc.json',
    'dsh/node_modules/pkg/.prettierrc.yml',
    'dsh/node_modules/pkg/.editorconfig',
    'dsh/node_modules/pkg/tsconfig.json',
    'dsh/node_modules/pkg/lib/tsconfig-loader.js',
    'dsh/node_modules/pkg/.github/workflows/ci.yml',
    'dsh/node_modules/pkg/.vscode/settings.json',
    'dsh/node_modules/pkg/fixtures/test.json',
    'dsh/node_modules/pkg/fixtures',
    'dsh/node_modules/fixtures/index.js',
    'dsh/node_modules/@scope/fixtures/index.js',
    'dsh/node_modules/@scope/fixtures/fixtures/test.json',
    'dsh/node_modules/pkg/node_modules/fixtures/index.js',
    'dsh/node_modules/pkg/node_modules/@scope/fixtures/index.js',
    'dsh/node_modules/pkg/node_modules/fixtures/fixtures/test.json',
    'dsh/node_modules/tsconfig.json',
    'dsh/node_modules/pkg/fixtures/LICENSE.md',
    'dsh/node_modules/pkg/fixtures/NOTICE.flow',
    'dsh/node_modules/pkg/__fixtures__/mock.json',
    'primary-runtime/dependencies/pnpm/dist/node_modules/fdir/dist/index.d.mts',
    'enterprise-assets/INSTALL.md',
    // 审查指出的漏裁形态：包内深层文档与排除目录、更深一层的嵌套依赖；同目录许可证保留。
    'dsh/node_modules/pkg/a/b/c/d/README.md',
    'dsh/node_modules/pkg/a/b/c/d/LICENSE.md',
    'dsh/node_modules/pkg/a/b/c/d/e/f/CHANGELOG.rst',
    'dsh/node_modules/pkg/a/b/c/d/test/x.js',
    'dsh/node_modules/pkg/a/b/c/d/e/f/g/test/x.js',
    'dsh/node_modules/pkg/node_modules/a/node_modules/b/test/x.js',
    'dsh/node_modules/pkg/node_modules/a/node_modules/b/node_modules/c/README.md',
    'dsh/node_modules/pkg/lib/vendor/node_modules/dep/README.md',
    'dsh/node_modules/pkg/lib/vendor/node_modules/dep/test/x.js',
    // 目录规则的枚举边界：界内排除，界外摘要如实计为随包。
    `dsh/node_modules/pkg/${'a/'.repeat(THIRD_PARTY_DIR_DEPTH)}test/x.js`,
    `dsh/node_modules/pkg/${'a/'.repeat(THIRD_PARTY_DIR_DEPTH - 1)}test/x.js`,
    `dsh/node_modules/pkg/${'node_modules/dep/'.repeat(THIRD_PARTY_NESTING_DEPTH)}test/x.js`,
    `dsh/node_modules/pkg/${'node_modules/dep/'.repeat(THIRD_PARTY_NESTING_DEPTH - 1)}test/x.js`,
    // 同后缀目录：`dsh/node_modules` 与原样目录内因排在后面的再包含规则仍可进入，之外整棵裁掉。
    'brand/x.ts/icon.png',
    'primary-runtime/x.ts/a.js',
    'dsh/node_modules/pkg/x.ts/a.js',
  ]) {
    assert.equal(copied(rel), isPackaged(rel), `filter parity for ${rel}`);
  }

  // 确定性生成语料：包名位、任意深度的嵌套 node_modules、排除目录名与各类文件名随机组合，逐个按文件路径核对。
  const heads = ['pkg', '@scope/pkg', '@scope/fixtures', '@deepseek-ai/dsh', '@deepseek-ai/dsh-llm', 'fixtures', 'test', 'docs', '.pnpm/dep@1.0.0'];
  const inner = ['lib', 'src', 'a', 'test', 'tests', '__tests__', 'docs', 'example', 'examples', 'fixtures', '__fixtures__', '.github', 'x.ts', 'NOTICE', 'node_modules'];
  const names = ['index.js', 'package.json', 'README.md', 'README.MD', 'notes.Markdown', 'CHANGELOG', 'History.rst', 'LICENSE', 'License.md', 'NOTICE.flow', 'COPYING', 'index.d.ts', 'x.TS', 'index.js.map', 'types.cts', 'decl.mts', 'debug.pdb', '.flow', '.md', 'tsconfig.json', 'tsconfig.build.json', 'tsconfig-loader.js', '.eslintrc.json', '.eslintrc', '.prettierrc', '.babelrc.js', '.editorconfig', '.npmignore', '.flowconfig', 'test', 'fixtures'];
  let state = 20261127;
  const draw = (pool) => pool[(state = (Math.imul(state, 1664525) + 1013904223) >>> 0) % pool.length];
  for (let sample = 0; sample < 1500; sample += 1) {
    const segments = ['dsh', 'node_modules', ...draw(heads).split('/')];
    for (let step = state % 12; step > 0; step -= 1) {
      segments.push(draw(inner));
      if (segments.at(-1) === 'node_modules') segments.push(...draw(heads).split('/'));
    }
    segments.push(draw(names));
    const rel = segments.join('/');
    assert.equal(admit(`/res/${rel}`, { isDirectory: () => false }), isPackaged(rel), `filter parity for ${rel}`);
  }
});

test('打包配置：过滤规则、maximum 压缩、关闭差分包、afterPack 钩子与中英文语言包', (t) => {
  const root = temp(t);
  const config = builderConfig({ identity: readAppIdentity(identityFile(root)), version: '1.2.3', resourcesDir: join(root, 'resources'), iconsDir: join(BRAND_DIR, 'icons'), appDir: join(REPO_ROOT, 'services', 'forge-desktop'), outputDir: join(root, 'dist') });
  assert.deepEqual(config.extraResources[0].filter, runtimeFilter());
  assert.equal(config.extraResources[0].filter.at(-1), 'primary-runtime/**');
  assert.equal(config.compression, 'maximum');
  assert.equal(config.dmg.writeUpdateInfo, false);
  assert.equal(existsSync(config.afterPack), true, 'afterPack hook script must exist');
  // 本应用不建自动更新 feed，差分形式的归档比 solid 归档大三分之一。
  assert.equal(config.nsis.differentialPackage, false);
  assert.equal(config.nsis.packElevateHelper, false);
  // 两种拼写各对应一种平台的语言文件名：macOS 用 en / zh_CN / zh_TW，Windows 与 Linux 用 en-US / zh-CN / zh-TW，无重复项。
  assert.deepEqual(config.electronLanguages, ['en', 'en-US', 'zh-CN', 'zh-TW', 'zh_CN', 'zh_TW']);
  assert.equal(new Set(config.electronLanguages).size, config.electronLanguages.length);
  assert.equal(config.nsis.deleteAppDataOnUninstall, false);

  // 凭据安全：口令不落盘、不序列化入 builderConfig，证书路径通过子进程 WIN_CSC_LINK 环境变量注入
  assert.equal(config.win.certificateFile, undefined);
  assert.equal(config.win.certificatePassword, undefined);
  assert.equal(JSON.stringify(config).includes('password'), false);

  const baseEnv = { PATH: '/bin', USER: 'ci' };
  const untouchedEnv = builderEnv({}, baseEnv);
  assert.equal(untouchedEnv.WIN_CSC_LINK, undefined);
  assert.equal(untouchedEnv.PATH, '/bin');

  const signedEnv = builderEnv({ certificateFile: 'certs/code-sign.pfx', target: 'win' }, baseEnv);
  assert.equal(signedEnv.WIN_CSC_LINK, resolve('certs/code-sign.pfx'));
  assert.equal(signedEnv.WIN_CSC_KEY_PASSWORD, undefined);
  assert.equal(signedEnv.CSC_KEY_PASSWORD, undefined);

  // 省略参数时保留环境变量已有 WIN_CSC_LINK
  const existingEnv = builderEnv({}, { ...baseEnv, WIN_CSC_LINK: '/existing/cert.pfx' });
  assert.equal(existingEnv.WIN_CSC_LINK, '/existing/cert.pfx');

  // 显式传入空白证书参数或非空口令环境变量（含混合大小写，Windows 环境变量不区分大小写）在 target win 下必须直接报错拒绝，且报错中绝不回显合成口令；
  // 非 Windows 目标（如 macOS）仍保留既有的 CSC_KEY_PASSWORD 签名环境变量。
  const syntheticPwd = 'synthetic-secret-password-999';
  assert.throws(() => builderEnv({ certificateFile: 'certs/code-sign.pfx', target: 'win' }, { ...baseEnv, WIN_CSC_KEY_PASSWORD: syntheticPwd }), (err) => err.code === 'BAD_ARGUMENT' && !err.message.includes(syntheticPwd));
  assert.throws(() => builderEnv({ target: 'win' }, { ...baseEnv, CSC_KEY_PASSWORD: syntheticPwd }), (err) => err.code === 'BAD_ARGUMENT' && !err.message.includes(syntheticPwd));
  assert.throws(() => builderEnv({ target: 'win' }, { ...baseEnv, Win_Csc_Key_Password: syntheticPwd }), (err) => err.code === 'BAD_ARGUMENT' && !err.message.includes(syntheticPwd));
  assert.throws(() => builderEnv({ target: 'win' }, { ...baseEnv, csc_key_password: syntheticPwd }), (err) => err.code === 'BAD_ARGUMENT' && !err.message.includes(syntheticPwd));
  const macEnv = builderEnv({ target: 'mac' }, { ...baseEnv, CSC_KEY_PASSWORD: syntheticPwd });
  assert.equal(macEnv.CSC_KEY_PASSWORD, syntheticPwd);
  assert.throws(() => builderEnv({ certificateFile: '', target: 'win' }), (err) => err.code === 'BAD_ARGUMENT');
  assert.throws(() => builderEnv({ certificateFile: '   ', target: 'win' }), (err) => err.code === 'BAD_ARGUMENT');
  assert.throws(() => builderEnv({ certificateFile: 'certs/code-sign.pfx', target: 'mac' }), (err) => err.code === 'BAD_ARGUMENT');
  assert.throws(() => parseArguments(['--identity', 'id.json', '--resources', 'res', '--version', '1.0.0', '--output', 'out', '--certificate-file', '']), (err) => err.code === 'BAD_ARGUMENT');
  assert.throws(() => parseArguments(['--identity', 'id.json', '--resources', 'res', '--version', '1.0.0', '--output', 'out', '--certificate-file', 'cert.pfx']), (err) => err.code === 'BAD_ARGUMENT');
  assert.equal(parseArguments(['--identity', 'id.json', '--resources', 'res', '--version', '1.0.0', '--output', 'out', '--target', 'win', '--certificate-file', 'cert.pfx']).certificateFile, 'cert.pfx');

  // 私钥防入包与 electron-builder.env 口令防泄露
  const resDir = join(root, 'res');
  const appDir = join(root, 'app');
  const outsideCert = join(root, 'certs', 'outside.pfx');
  const insideCert = join(resDir, 'nested', 'inside.pfx');
  const dotDotSubdirCert = join(resDir, '..secrets', 'inside.pfx');
  const symlinkCert = join(root, 'certs', 'link-to-inside.pfx');
  mkdirSync(dirname(insideCert), { recursive: true });
  mkdirSync(dirname(dotDotSubdirCert), { recursive: true });
  mkdirSync(dirname(outsideCert), { recursive: true });
  mkdirSync(appDir, { recursive: true });
  writeFileSync(insideCert, 'pfx');
  writeFileSync(dotDotSubdirCert, 'pfx');
  writeFileSync(outsideCert, 'pfx');

  const safeEnv = builderEnv({ certificateFile: outsideCert, target: 'win', appDir, inputRoots: [resDir, appDir] }, baseEnv);
  assert.equal(safeEnv.WIN_CSC_LINK, resolve(outsideCert));
  assert.throws(() => assertSafeCertificatePath(insideCert, [resDir, appDir]), (err) => err.code === 'BAD_ARGUMENT');
  assert.throws(() => assertSafeCertificatePath(dotDotSubdirCert, [resDir, appDir]), (err) => err.code === 'BAD_ARGUMENT');
  // 相对 appDir 解析继承的 WIN_CSC_LINK：指向输入树内时拒绝，指向树外时归一化为绝对路径
  assert.throws(() => builderEnv({ target: 'win', appDir, inputRoots: [resDir, appDir] }, { ...baseEnv, WIN_CSC_LINK: '../res/nested/inside.pfx' }), (err) => err.code === 'BAD_ARGUMENT');
  const normalizedInherited = builderEnv({ target: 'win', appDir, inputRoots: [resDir, appDir] }, { ...baseEnv, WIN_CSC_LINK: '../certs/outside.pfx' });
  assert.equal(normalizedInherited.WIN_CSC_LINK, resolve(outsideCert));
  assert.throws(() => builderEnv({ target: 'win', inputRoots: [resDir, appDir] }, { ...baseEnv, WIN_CSC_LINK: insideCert }), (err) => err.code === 'BAD_ARGUMENT');

  // WIN_CSC_LINK 的取值按 app-builder-lib importCertificate 的分类处理，两者读的是同一个文件：
  // https:// 与内联 base64（data: 前缀、超过 2048 字符、以 = 结尾）不是文件，原样传递；
  // file://（去掉协议前缀）、~/（展开到 home）与裸相对路径（以 appDir 为基准）都是文件，一律校验并归一化为绝对路径。
  // 此前 file:// 被当成 URL 跳过校验，可把输入树内的私钥交给构建子进程；内联 base64 被当成相对路径改写，签名构建必然失败。
  const win = { target: 'win', appDir, inputRoots: [resDir, appDir] };
  const classify = (value) => localCertificatePath(value, appDir);
  assert.equal(classify('https://corp.example/code-sign.pfx'), null);
  assert.equal(classify('data:application/x-pkcs12;base64,c3ludGhldGlj'), null);
  assert.equal(classify('synthetic-inline-certificate=='), null);
  assert.equal(classify('A'.repeat(2049)), null);
  assert.equal(classify(insideCert), resolve(insideCert));
  assert.equal(classify('../res/nested/inside.pfx'), resolve(insideCert));
  assert.equal(classify(`file://${insideCert}`), resolve(insideCert));
  assert.equal(classify('file://../res/nested/inside.pfx'), resolve(insideCert));
  assert.equal(classify('~/certs/outside.pfx'), join(homedir(), 'certs', 'outside.pfx'));

  for (const link of [`file://${insideCert}`, 'file://../res/nested/inside.pfx', `~/${relative(homedir(), insideCert)}`]) {
    for (const key of ['WIN_CSC_LINK', 'CSC_LINK']) {
      assert.throws(() => builderEnv(win, { ...baseEnv, [key]: link }), (err) => err.code === 'BAD_ARGUMENT', `${key}=${link}`);
    }
  }
  assert.equal(builderEnv(win, { ...baseEnv, WIN_CSC_LINK: `file://${outsideCert}` }).WIN_CSC_LINK, resolve(outsideCert));
  assert.equal(builderEnv(win, { ...baseEnv, WIN_CSC_LINK: 'file://../certs/outside.pfx' }).WIN_CSC_LINK, resolve(outsideCert));
  assert.equal(builderEnv(win, { ...baseEnv, WIN_CSC_LINK: '~/certs/outside.pfx' }).WIN_CSC_LINK, join(homedir(), 'certs', 'outside.pfx'));
  for (const inline of ['https://corp.example/code-sign.pfx', 'data:application/x-pkcs12;base64,c3ludGhldGlj', 'synthetic-inline-certificate==', 'A'.repeat(2049)]) {
    assert.equal(builderEnv(win, { ...baseEnv, WIN_CSC_LINK: inline }).WIN_CSC_LINK, inline);
  }

  // 符号链接在未开启开发者模式的 Windows 上可能报 EPERM，仅在明确缺少权限时跳过该子断言，不阻塞其余安全校验
  try {
    symlinkSync(insideCert, symlinkCert);
    assert.throws(() => builderEnv({ certificateFile: symlinkCert, target: 'win', appDir, inputRoots: [resDir, appDir] }, baseEnv), (err) => err.code === 'BAD_ARGUMENT');
  } catch (err) {
    if (err?.code !== 'EPERM' && err?.code !== 'EACCES') throw err;
  }

  // target win 下禁止 appDir/electron-builder.env 存在（防止任何语法隐式注入签名口令），target mac 不受限制
  const envFile = join(appDir, 'electron-builder.env');
  writeFileSync(envFile, `WIN_CSC_KEY_PASSWORD: ${syntheticPwd}\n`);
  assert.throws(() => validateBuilderEnvFile(appDir, { target: 'win', inputRoots: [resDir, appDir] }), (err) => err.code === 'BAD_ARGUMENT' && !err.message.includes(syntheticPwd));
  assert.doesNotThrow(() => validateBuilderEnvFile(appDir, { target: 'mac', inputRoots: [resDir, appDir] }));
});

test('目标与架构矩阵：macOS 只产压缩 dmg，x64 与麒麟 linux arm64/x64 各自对齐并拒绝不支持的组合', (t) => {
  const root = temp(t);
  const identity = readAppIdentity(identityFile(root));
  const common = { identity, version: '1.2.3', resourcesDir: join(root, 'resources'), iconsDir: join(BRAND_DIR, 'icons'), appDir: join(REPO_ROOT, 'services', 'forge-desktop'), outputDir: join(root, 'dist') };
  const macX64 = builderConfig({ ...common, target: 'mac', arch: 'x64' });
  assert.deepEqual(macX64.mac.target, [{ target: 'dmg', arch: ['x64'] }]);
  const linuxArm = builderConfig({ ...common, target: 'linux', arch: 'arm64' });
  assert.deepEqual(linuxArm.linux.target, [{ target: 'deb', arch: ['arm64'] }]);
  assert.equal(resolveTargetArch('linux'), 'x64');
  assert.equal(resolveTargetArch('win'), 'x64');
  assert.throws(() => resolveTargetArch('win', 'arm64'), (error) => error.code === 'BAD_ARGUMENT');
  assert.throws(() => resolveTargetArch('linux', 'universal'), (error) => error.code === 'BAD_ARGUMENT');
});

test('afterPack：macOS 清理 Electron Framework 内多余 .lproj，非 macOS 不改动', async (t) => {
  const root = temp(t);
  const appOutDir = join(root, 'mac-arm64');
  const appBundle = join(appOutDir, 'Heluo Forge Enterprise.app');
  const frameworkRes = join(appBundle, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources');
  const appRes = join(appBundle, 'Contents', 'Resources');
  for (const locale of [...KEEP_MAC_LPROJ, 'fr.lproj', 'de.lproj', 'ja.lproj']) {
    mkdirSync(join(frameworkRes, locale), { recursive: true });
    writeFileSync(join(frameworkRes, locale, 'locale.pak'), 'data');
  }
  mkdirSync(join(appRes, 'es.lproj'), { recursive: true });
  writeFileSync(join(appRes, 'es.lproj', 'InfoPlist.strings'), 'es');
  writeFileSync(join(frameworkRes, 'icudtl.dat'), 'icu');

  // Non-macOS platform leaves bundle untouched.
  assert.equal(await afterPack({ electronPlatformName: 'win32', appOutDir, packager: { appInfo: { productFilename: 'Heluo Forge Enterprise' } } }), undefined);
  assert.equal(existsSync(join(frameworkRes, 'fr.lproj')), true);

  const summary = await afterPack({ electronPlatformName: 'darwin', appOutDir, packager: { appInfo: { productFilename: 'Heluo Forge Enterprise' } } });
  assert.equal(summary.removedDirs, 4);
  assert.equal(summary.removedFiles, 4);
  for (const kept of KEEP_MAC_LPROJ) assert.equal(existsSync(join(frameworkRes, kept)), true, `${kept} kept`);
  for (const gone of ['fr.lproj', 'de.lproj', 'ja.lproj']) assert.equal(existsSync(join(frameworkRes, gone)), false, `${gone} removed`);
  assert.equal(existsSync(join(appRes, 'es.lproj')), false);
  assert.equal(existsSync(join(frameworkRes, 'icudtl.dat')), true, 'non-lproj framework resource preserved');
  assert.equal(pruneMacLocales(join(root, 'missing.app')).removedDirs, 0);
});

test('体积摘要：逐文件分类，数字取自真实文件', (t) => {
  const root = temp(t);
  const resources = join(root, 'resources');
  const write = (rel, bytes) => {
    mkdirSync(dirname(join(resources, rel)), { recursive: true });
    writeFileSync(join(resources, rel), Buffer.alloc(bytes));
  };
  write('dsh/node_modules/@deepseek-ai/dsh/lib/bin.js', 30);
  write('dsh/node_modules/@deepseek-ai/dsh/lib/types/bin.d.ts', 40);
  write('dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js', 50);
  write('dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js.map', 60);
  write('dsh/node_modules/@deepseek-ai/dsh-llm/lib/types/index.d.ts', 70);
  write('brand/tray.png', 80);
  assert.deepEqual(summarizeResources(resources), { files: 6, bytes: 330, excluded: { files: 2, bytes: 130 } });
});

test('图标与品牌 manifest 账本一致；参数解析限定目标', () => {
  const manifest = JSON.parse(readFileSync(join(BRAND_DIR, 'manifest.json'), 'utf8'));
  const byName = new Map(manifest.assets.map((asset) => [asset.path, asset]));
  for (const rel of ['icons/app-icon.ico', 'icons/app-icon.icns']) {
    const entry = byName.get(rel);
    const bytes = readFileSync(join(BRAND_DIR, rel));
    assert.equal(bytes.length, entry.bytes, rel);
  }
  assert.deepEqual(parseArguments(['--identity', 'i', '--resources', 'r', '--version', 'v', '--output', 'o']), {
    identity: 'i',
    resources: 'r',
    version: 'v',
    output: 'o',
    appDir: undefined,
    brandDir: undefined,
    target: 'dir',
    arch: 'arm64',
    certificateFile: undefined,
    configOnly: false,
    json: false,
  });
  const parsedSigned = parseArguments(['--identity', 'i', '--resources', 'r', '--version', 'v', '--output', 'o', '--target', 'win', '--certificate-file', 'cert.pfx']);
  assert.equal(parsedSigned.certificateFile, 'cert.pfx');
  // 密码参数必须被拒绝，避免进程参数与配置序列化造成口令落盘泄漏
  assert.throws(() => parseArguments(['--identity', 'i', '--resources', 'r', '--version', 'v', '--output', 'o', '--target', 'win', '--certificate-password', 'pwd']), (error) => error.code === 'BAD_ARGUMENT');
  assert.equal(parseArguments(['--identity', 'i', '--resources', 'r', '--version', 'v', '--output', 'o', '--target', 'win']).arch, 'x64');
  assert.equal(parseArguments(['--identity', 'i', '--resources', 'r', '--version', 'v', '--output', 'o', '--target', 'mac', '--arch', 'x64']).arch, 'x64');
  assert.equal(parseArguments(['--identity', 'i', '--resources', 'r', '--version', 'v', '--output', 'o', '--target', 'linux', '--arch', 'arm64']).arch, 'arm64');
  assert.throws(() => parseArguments(['--identity', 'i', '--resources', 'r', '--version', 'v', '--output', 'o', '--target', 'win', '--arch', 'arm64']), (error) => error.code === 'BAD_ARGUMENT');
  assert.throws(() => parseArguments(['--identity', 'i', '--resources', 'r', '--version', 'v', '--output', 'o', '--target', 'zip']), (error) => error.code === 'BAD_ARGUMENT');
  assert.throws(() => parseArguments(['--identity', 'i']), (error) => error.code === 'BAD_ARGUMENT');
});

test('版本号接受 tag 形式：前导 v 统一去掉，其余一律拒绝', () => {
  // 发布 lane 交来的是 tag 本身；NSIS 从应用版本推导 Windows 数字版本，带 v 会被拒
  // （"Invalid major number"），而 macOS 的 dir 目标从不检查——两端必须走同一处规范化。
  assert.equal(normalizeVersion('v1.2.3'), '1.2.3');
  assert.equal(normalizeVersion('1.2.3'), '1.2.3');
  assert.equal(normalizeVersion('v0.1.10'), '0.1.10');
  assert.equal(normalizeVersion('v1.2.3-rc.1'), '1.2.3-rc.1');
  for (const bad of ['v1.2', '1.2', 'v1.2.3+build', 'vv1.2.3', 'main', '', undefined]) {
    assert.throws(() => normalizeVersion(bad), (error) => error.code === 'BAD_ARGUMENT', `${bad} must be refused`);
  }
});

test('构建器入口取自包自身声明的 bin：任何平台都由当前 Node 直接执行，不经 .cmd 或 sh 垫片', (t) => {
  const root = temp(t);
  const builderDir = join(root, 'node_modules', 'electron-builder');
  // 未安装：目录、清单、bin 字段、入口文件任一缺失都报 null，由调用方给出 BUILDER_MISSING。
  assert.equal(builderEntry(builderDir), null, 'no package at all');
  mkdirSync(builderDir, { recursive: true });
  assert.equal(builderEntry(builderDir), null, 'no manifest');
  writeFileSync(join(builderDir, 'package.json'), 'not json');
  assert.equal(builderEntry(builderDir), null, 'unreadable manifest');
  writeFileSync(join(builderDir, 'package.json'), JSON.stringify({ name: 'electron-builder', version: '0.0.0' }));
  assert.equal(builderEntry(builderDir), null, 'no bin declared');
  writeFileSync(join(builderDir, 'package.json'), JSON.stringify({ name: 'electron-builder', bin: { 'electron-builder': './cli.js' } }));
  assert.equal(builderEntry(builderDir), null, 'declared entry file is missing');
  writeFileSync(join(builderDir, 'cli.js'), '#!/usr/bin/env node\n');
  assert.equal(builderEntry(builderDir), join(builderDir, 'cli.js'), 'object bin form resolves the declared entry');
  writeFileSync(join(builderDir, 'package.json'), JSON.stringify({ name: 'electron-builder', bin: './cli.js' }));
  assert.equal(builderEntry(builderDir), join(builderDir, 'cli.js'), 'string bin form resolves too');

  // 真实安装布局：pnpm 把包链到 app 的 node_modules 下，入口仍是包内相对路径。
  const installed = join(REPO_ROOT, 'services', 'forge-desktop', 'node_modules', 'electron-builder');
  if (existsSync(join(installed, 'package.json'))) {
    assert.equal(existsSync(builderEntry(installed) ?? ''), true);
  }
});
