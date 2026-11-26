/**
 * Installer configuration tests (CORP-DSH-PLAN-026 §4.3-7).
 *
 * Every identity-bearing field of the electron-builder configuration must
 * come from the employee package's app-identity.json truth — and that truth
 * itself must equal the release lane's APP_IDENTITY, so the OS-level app and
 * the plugin brand can never drift apart.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { APP_IDENTITY } from '../scripts/release-delivery.mjs';
import { builderConfig, builderEntry, isPackaged, normalizeVersion, parseArguments, readAppIdentity, resolveTargetArch, summarizeResources } from '../scripts/build-desktop-installer.mjs';

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

test('安装包内容：运行时不读取的文件类型不进包，台账钉定的制品目录与内置运行时原样保留', () => {
  // 规则只认文件类型，与所在目录无关：同一个 .d.ts，在制品目录内留下，在闭包里裁掉。
  assert.equal(isPackaged('dsh/node_modules/@deepseek-ai/dsh/lib/types/bin.d.ts'), true);
  assert.equal(isPackaged('dsh/node_modules/@deepseek-ai/dsh-llm/lib/types/index.d.ts'), false);
  // 反向：被裁的类型换成 .js 就必须留下，否则规则裁掉了整个目录而不只是无用文件。
  for (const excluded of ['core/index.ts', 'api/index.d.cts', 'api/index.d.mts', 'index.js.map', 'prebuilds/win32-x64/conpty.pdb']) {
    assert.equal(isPackaged(`dsh/node_modules/pkg/lib/${excluded}`), false, excluded);
  }
  assert.equal(isPackaged('dsh/node_modules/pkg/lib/index.js'), true);
  // 内置运行时是暂存后检查过、并按文件数与字节数记入构建记录的那棵树：进包的必须就是它。
  // 它里面 pnpm 副本的类型声明随载荷保留，而壳直接启动的那份 pnpm 属于注册表闭包，照旧裁掉。
  assert.equal(isPackaged('primary-runtime/dependencies/pnpm/dist/node_modules/fdir/dist/index.d.mts'), true);
  assert.equal(isPackaged('pnpm/dist/node_modules/fdir/dist/index.d.mts'), false);
  assert.equal(isPackaged('primary-runtime/dependencies/python/lib/python3.12/site-packages/numpy/tests.map'), true);
  // 豁免落到目录边界上：同前缀的别的目录不在豁免之列。
  assert.equal(isPackaged('primary-runtime-other/lib/index.d.ts'), false);
  // 运行文件、许可与说明文本、品牌材料、员工包和 npm 的隐藏锁文件都不在规则内。
  for (const kept of ['dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js', 'dsh/node_modules/zod/LICENSE.md', 'dsh/node_modules/openai/README.md', 'dsh/node_modules/.package-lock.json', 'brand/tray.png', 'brand/status.html', 'enterprise-assets/employee-manifest.json']) {
    assert.equal(isPackaged(kept), true, kept);
  }
});

test('打包配置：过滤规则与判定同源且顺序正确；关闭差分包；语言包只留英文与简繁中文', (t) => {
  const root = temp(t);
  const config = builderConfig({ identity: readAppIdentity(identityFile(root)), version: '1.2.3', resourcesDir: join(root, 'resources'), iconsDir: join(BRAND_DIR, 'icons'), appDir: join(REPO_ROOT, 'services', 'forge-desktop'), outputDir: join(root, 'dist') });
  // electron-builder 按顺序应用并让后者覆盖前者：豁免目录排在排除规则之后才生效。
  assert.deepEqual(config.extraResources[0].filter, ['**/*', '!**/*.ts', '!**/*.cts', '!**/*.mts', '!**/*.map', '!**/*.pdb', 'dsh/node_modules/@deepseek-ai/dsh/**', 'primary-runtime/**']);
  // 本应用不建自动更新 feed，差分形式的归档比 solid 归档大三分之一。
  assert.equal(config.nsis.differentialPackage, false);
  // 两种拼写各对应一种平台的语言文件名：macOS 用 en / zh_CN / zh_TW，Windows 与 Linux 用 en-US / zh-CN / zh-TW，无重复项。
  assert.deepEqual(config.electronLanguages, ['en', 'en-US', 'zh-CN', 'zh-TW', 'zh_CN', 'zh_TW']);
  assert.equal(new Set(config.electronLanguages).size, config.electronLanguages.length);
  assert.equal(config.nsis.deleteAppDataOnUninstall, false);
});

test('目标与架构矩阵：macOS x64 与麒麟 linux arm64/x64 各自对齐并拒绝不支持的组合', (t) => {
  const root = temp(t);
  const identity = readAppIdentity(identityFile(root));
  const common = { identity, version: '1.2.3', resourcesDir: join(root, 'resources'), iconsDir: join(BRAND_DIR, 'icons'), appDir: join(REPO_ROOT, 'services', 'forge-desktop'), outputDir: join(root, 'dist') };
  const macX64 = builderConfig({ ...common, target: 'mac', arch: 'x64' });
  assert.deepEqual(macX64.mac.target, [{ target: 'dmg', arch: ['x64'] }, { target: 'zip', arch: ['x64'] }]);
  const linuxArm = builderConfig({ ...common, target: 'linux', arch: 'arm64' });
  assert.deepEqual(linuxArm.linux.target, [{ target: 'deb', arch: ['arm64'] }]);
  assert.equal(resolveTargetArch('linux'), 'x64');
  assert.equal(resolveTargetArch('win'), 'x64');
  assert.throws(() => resolveTargetArch('win', 'arm64'), (error) => error.code === 'BAD_ARGUMENT');
  assert.throws(() => resolveTargetArch('linux', 'universal'), (error) => error.code === 'BAD_ARGUMENT');
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
    configOnly: false,
    json: false,
  });
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
