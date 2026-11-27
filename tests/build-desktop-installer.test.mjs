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
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { APP_IDENTITY } from '../scripts/release-delivery.mjs';
import { afterPack, KEEP_MAC_LPROJ, pruneMacLocales } from '../scripts/lib/desktop-after-pack.mjs';
import { assertSafeCertificatePath, builderConfig, builderEntry, builderEnv, isPackaged, normalizeVersion, parseArguments, readAppIdentity, resolveTargetArch, runtimeFilter, summarizeResources, validateBuilderEnvFile } from '../scripts/build-desktop-installer.mjs';

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
    'dsh/node_modules/@scope/fixtures/index.js',
    'dsh/node_modules/pkg/__fixtures__/mock.json',
  ]) {
    assert.equal(isPackaged(excluded), false, excluded);
  }
  // 第三方包的许可证文件（MIT/Apache 等版权保留义务合规保留，包含 fixtures 等子目录内的许可证）与 @deepseek-ai 作用域下的文档/技能文本必须保留；
  // 顶层包名恰好为 fixtures 时其入口保留；与排除规则同前缀但非配置的正常源码（如 tsconfig-loader.js、.npmignore-helper.js）不得被误伤。
  for (const kept of [
    'dsh/node_modules/fixtures/index.js',
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

  // 若本机已安装 app-builder-lib，则直接用真实 createFilter 核对与 isPackaged 逐项一致。
  const appBuilderPkg = join(REPO_ROOT, 'services', 'forge-desktop', 'node_modules', 'electron-builder', 'node_modules', 'app-builder-lib', 'package.json');
  const pnpmAppBuilder = join(REPO_ROOT, 'node_modules', '.pnpm', 'app-builder-lib@26.0.12_dmg-builder@26.0.12_electron-builder-squirrel-windows@26.0.12_supports-color@7.2.0', 'node_modules', 'app-builder-lib', 'package.json');
  const resolvedPkg = existsSync(appBuilderPkg) ? appBuilderPkg : existsSync(pnpmAppBuilder) ? pnpmAppBuilder : null;
  if (resolvedPkg !== null) {
    const req = createRequire(resolvedPkg);
    const { createFilter } = req('./out/util/filter.js');
    const { Minimatch } = req('minimatch');
    const realFilter = createFilter('/res', runtimeFilter().map((pattern) => new Minimatch(pattern, { dot: true })));
    for (const rel of [
      'dsh/node_modules/@deepseek-ai/dsh/lib/types/bin.d.ts',
      'dsh/node_modules/@deepseek-ai/dsh-llm/lib/types/index.d.ts',
      'dsh/node_modules/@deepseek-ai/dsh-llm/README.md',
      'dsh/node_modules/@deepseek-ai/dsh-llm/docs/prompt.md',
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
      'dsh/node_modules/tsconfig.json',
      'dsh/node_modules/pkg/fixtures/LICENSE.md',
      'dsh/node_modules/pkg/fixtures/NOTICE.flow',
      'dsh/node_modules/@deepseek-ai/dsh-llm/NOTICE.flow',
      'dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js.flow',
      'dsh/node_modules/pkg/__fixtures__/mock.json',
      'primary-runtime/dependencies/pnpm/dist/node_modules/fdir/dist/index.d.mts',
      'enterprise-assets/INSTALL.md',
    ]) {
      assert.equal(realFilter(`/res/${rel}`, { isDirectory: () => false }), isPackaged(rel), `real filter parity for ${rel}`);
    }
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
  const symlinkCert = join(root, 'certs', 'link-to-inside.pfx');
  mkdirSync(dirname(insideCert), { recursive: true });
  mkdirSync(dirname(outsideCert), { recursive: true });
  mkdirSync(appDir, { recursive: true });
  writeFileSync(insideCert, 'pfx');
  writeFileSync(outsideCert, 'pfx');
  symlinkSync(insideCert, symlinkCert);

  const safeEnv = builderEnv({ certificateFile: outsideCert, target: 'win', inputRoots: [resDir, appDir] }, baseEnv);
  assert.equal(safeEnv.WIN_CSC_LINK, resolve(outsideCert));
  assert.throws(() => assertSafeCertificatePath(insideCert, [resDir, appDir]), (err) => err.code === 'BAD_ARGUMENT');
  assert.throws(() => builderEnv({ certificateFile: symlinkCert, target: 'win', inputRoots: [resDir, appDir] }, baseEnv), (err) => err.code === 'BAD_ARGUMENT');
  assert.throws(() => builderEnv({ target: 'win', inputRoots: [resDir, appDir] }, { ...baseEnv, WIN_CSC_LINK: insideCert }), (err) => err.code === 'BAD_ARGUMENT');

  // electron-builder.env 若含 Windows 口令或不安全证书路径，必须在启动前拒绝且不回显口令
  const envFile = join(appDir, 'electron-builder.env');
  writeFileSync(envFile, `WIN_CSC_KEY_PASSWORD=${syntheticPwd}\n`);
  assert.throws(() => validateBuilderEnvFile(appDir, { target: 'win', inputRoots: [resDir, appDir] }), (err) => err.code === 'BAD_ARGUMENT' && !err.message.includes(syntheticPwd));
  assert.doesNotThrow(() => validateBuilderEnvFile(appDir, { target: 'mac', inputRoots: [resDir, appDir] }));
  writeFileSync(envFile, `WIN_CSC_LINK=${insideCert}\n`);
  assert.throws(() => validateBuilderEnvFile(appDir, { target: 'win', inputRoots: [resDir, appDir] }), (err) => err.code === 'BAD_ARGUMENT');
  writeFileSync(envFile, `WIN_CSC_LINK=${outsideCert}\n`);
  assert.doesNotThrow(() => validateBuilderEnvFile(appDir, { target: 'win', inputRoots: [resDir, appDir] }));
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
