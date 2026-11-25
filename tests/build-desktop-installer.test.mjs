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
import { builderConfig, builderEntry, normalizeVersion, parseArguments, readAppIdentity } from '../scripts/build-desktop-installer.mjs';

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

test('配置逐字段来自身份真源：appId/GUID/productName/可执行名/产物名', (t) => {
  const root = temp(t);
  const identity = readAppIdentity(identityFile(root));
  const config = builderConfig({ identity, version: '1.2.3', resourcesDir: join(root, 'resources'), iconsDir: join(BRAND_DIR, 'icons'), appDir: join(REPO_ROOT, 'services', 'forge-desktop'), outputDir: join(root, 'dist') });
  assert.equal(config.appId, APP_IDENTITY.appId);
  assert.equal(config.productName, APP_IDENTITY.productName);
  assert.equal(config.executableName, APP_IDENTITY.executableName);
  assert.equal(config.nsis.guid, APP_IDENTITY.upgradeGuid);
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
  for (const field of ['appId', 'upgradeGuid', 'productName', 'executableName']) {
    const doctored = builderConfig({ identity: readAppIdentity(identityFile(root, { [field]: 'doctored' })), version: '1', resourcesDir: 'r', iconsDir: 'i', appDir: 'a', outputDir: 'o' });
    const differs = real.appId !== doctored.appId || real.nsis.guid !== doctored.nsis.guid || real.productName !== doctored.productName || real.executableName !== doctored.executableName || real.artifactName !== doctored.artifactName;
    assert.equal(differs, true, `tampering ${field} must change the configuration`);
  }
});

test('图标与品牌 manifest 账本一致；参数解析限定目标', () => {
  const manifest = JSON.parse(readFileSync(join(BRAND_DIR, 'manifest.json'), 'utf8'));
  const byName = new Map(manifest.assets.map((asset) => [asset.path, asset]));
  for (const rel of ['icons/app-icon.ico', 'icons/app-icon.icns']) {
    const entry = byName.get(rel);
    const bytes = readFileSync(join(BRAND_DIR, rel));
    assert.equal(bytes.length, entry.bytes, rel);
  }
  assert.equal(parseArguments(['--identity', 'i', '--resources', 'r', '--version', 'v', '--output', 'o']).target, 'dir');
  assert.equal(parseArguments(['--identity', 'i', '--resources', 'r', '--version', 'v', '--output', 'o', '--target', 'win']).target, 'win');
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
