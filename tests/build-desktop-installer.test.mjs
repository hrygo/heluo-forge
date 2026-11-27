/**
 * Installer configuration tests (CORP-DSH-PLAN-026 §4.3-7).
 *
 * Every identity-bearing field of the electron-builder configuration must
 * come from the employee package's app-identity.json truth — and that truth
 * itself must equal the release lane's APP_IDENTITY, so the OS-level app and
 * the plugin brand can never drift apart.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { APP_IDENTITY } from '../scripts/release-delivery.mjs';
import { afterPack, KEEP_MAC_LPROJ, pruneMacLocales } from '../scripts/lib/desktop-after-pack.mjs';
import { ASAR_UNPACK, isPackaged, isUnpacked, payloadFilter, resourcesFilter, summarizeResources } from '../scripts/lib/desktop-payload.mjs';
import { builderConfig, builderEntry, normalizeVersion, parseArguments, readAppIdentity, resolveTargetArch, stagedInsideAppDir } from '../scripts/build-desktop-installer.mjs';
import { writeAsar } from './support/asar-fixture.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRAND_DIR = join(REPO_ROOT, 'docs', 'assets', 'branding', 'cyber-long');
/** The magic number of a 64-bit Mach-O: a native library, to any reader of its first bytes. */
const MACHO = Buffer.from('cffaedfe000000020000000000000000', 'hex');

function temp(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-installer-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** electron-builder 自己的库所在的清单，未安装时为 null：它的匹配器与遍历器是规则的另一方证词。 */
function appBuilderPackage() {
  const nested = join(REPO_ROOT, 'services', 'forge-desktop', 'node_modules', 'electron-builder', 'node_modules', 'app-builder-lib', 'package.json');
  const pnpm = join(REPO_ROOT, 'node_modules', '.pnpm', 'app-builder-lib@26.0.12_dmg-builder@26.0.12_electron-builder-squirrel-windows@26.0.12_supports-color@7.2.0', 'node_modules', 'app-builder-lib', 'package.json');
  return existsSync(nested) ? nested : existsSync(pnpm) ? pnpm : null;
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
    'dsh/node_modules/pkg/.github/workflows/ci.yml',
    'dsh/node_modules/pkg/fixtures/sample.json',
    'dsh/node_modules/pkg/src/native.c',
    'dsh/node_modules/pkg/include/native.h',
    'dsh/node_modules/pkg/binding.gyp',
    'dsh/node_modules/pkg/Makefile',
    'dsh/node_modules/pkg/tsconfig.json',
    'dsh/node_modules/pkg/.eslintrc.json',
    'dsh/node_modules/pkg/.DS_Store',
    // 文档扩展名与 CHANGELOG / HISTORY 前缀不分大小写：换一种写法照样裁掉。
    'dsh/node_modules/pkg/README.MD',
    'dsh/node_modules/pkg/notes.MarkDown',
    'dsh/node_modules/pkg/Changelog.rst',
    'dsh/node_modules/pkg/history.txt',
  ]) {
    assert.equal(isPackaged(excluded), false, excluded);
  }
  // 第三方包的许可证文件与 @deepseek-ai 作用域下的文档/技能文本必须保留。
  for (const kept of [
    'dsh/node_modules/zod/LICENSE.md',
    'dsh/node_modules/pkg/license.txt',
    'dsh/node_modules/pkg/NOTICE',
    'dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js',
    'dsh/node_modules/@deepseek-ai/dsh-llm/README.md',
    'dsh/node_modules/@deepseek-ai/dsh-llm/docs/prompt.md',
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
  assert.equal(isPackaged('primary-runtime/dependencies/python/lib/python3.12/site-packages/numpy/tests.map'), true);
  // 归档之外的资源原样随包：运行时不读的文件类型只在归档里的运行时闭包内被裁掉，放在别处照常交付。
  for (const beside of ['pnpm/dist/node_modules/fdir/dist/index.d.mts', 'primary-runtime-other/lib/index.d.ts', 'brand/app.js.map', 'enterprise-assets/types.d.ts']) {
    assert.equal(isPackaged(beside), true, beside);
  }
  // 名字像许可证不是许可证：类型与映射图运行时永不读取，叫 notice 也一样。
  for (const excluded of ['dsh/node_modules/@deepseek-ai/dsh-spill-policy/lib/types/notice.d.ts', 'dsh/node_modules/@deepseek-ai/dsh-spill-policy/lib/types/notice.js.map', 'dsh/node_modules/pkg/lib/copying.d.ts', 'dsh/node_modules/pkg/LICENSE.ts']) {
    assert.equal(isPackaged(excluded), false, excluded);
  }
  // 许可证文件始终保留，哪怕躺在本该裁掉的 test 或 docs 目录里。
  for (const kept of ['dsh/node_modules/pkg/test/LICENSE', 'dsh/node_modules/@scope/pkg/docs/NOTICE.md', 'dsh/node_modules/pkg/examples/LICENSE.md']) {
    assert.equal(isPackaged(kept), true, kept);
  }

  // 若本机已安装 app-builder-lib，则直接用 electron-builder 自己的匹配器核对三组模式与规则逐项一致。
  const resolvedPkg = appBuilderPackage();
  if (resolvedPkg !== null) {
    const req = createRequire(resolvedPkg);
    const { createFilter } = req('./out/util/filter.js');
    const { Minimatch } = req('minimatch');
    const matcher = (src, patterns) => createFilter(src, patterns.map((pattern) => new Minimatch(pattern, { dot: true })));
    const file = { isDirectory: () => false };
    const directory = { isDirectory: () => true };
    // 归档与归档旁的松散文件：两组模式的源目录都是暂存的资源，路径从那里数起。
    const packed = matcher('/res', payloadFilter());
    const loose = matcher('/res', resourcesFilter());
    // 解包：electron-builder 从应用目录起数路径，暂存的资源位于其中，路径里没有向上回溯的段。
    const unpacked = matcher('/app', ASAR_UNPACK);
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
      'dsh/node_modules/pkg/src/native.c',
      'dsh/node_modules/pkg/binding.gyp',
      'dsh/node_modules/pkg/tsconfig.json',
      'dsh/node_modules/pkg/.github/workflows/ci.yml',
      'dsh/node_modules/@scope/pkg/docs/NOTICE.md',
      'dsh/node_modules/pkg/README.MD',
      'dsh/node_modules/pkg/notes.MarkDown',
      'dsh/node_modules/pkg/Changelog.rst',
      'dsh/node_modules/pkg/history.txt',
      'dsh/node_modules/@deepseek-ai/dsh-spill-policy/lib/types/notice.d.ts',
      'dsh/node_modules/@deepseek-ai/dsh-spill-policy/lib/types/notice.js.map',
      'dsh/package.json',
      'primary-runtime/dependencies/pnpm/dist/node_modules/fdir/dist/index.d.mts',
      'brand/app.js.map',
      'enterprise-assets/types.d.ts',
      'enterprise-assets/INSTALL.md',
      'brand/tray.png',
    ]) {
      const inArchive = rel.startsWith('dsh/');
      assert.equal(packed(`/res/${rel}`, file), inArchive && isPackaged(rel), `archive filter parity for ${rel}`);
      assert.equal(loose(`/res/${rel}`, file), !inArchive, `loose filter parity for ${rel}`);
    }
    for (const rel of [
      'dsh/node_modules/node-addon-system-darwin-arm64/bin/system.node',
      'dsh/node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.42.dylib',
      'dsh/node_modules/node-pty/prebuilds/win32-x64/conpty.node',
      'dsh/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
      'dsh/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg',
      'dsh/node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe',
      'dsh/node_modules/@vscode/ripgrep-darwin-arm64/lib/index.js',
      'dsh/node_modules/@deepseek-ai/libreoffice-kit-darwin-arm64/bin/dsoffice',
      'dsh/node_modules/@deepseek-ai/libreoffice-kit-win32-x64/program/types/rdb.xcd',
      'dsh/node_modules/@deepseek-ai/libreoffice-kit/lib/index.js',
      'dsh/node_modules/@deepseek-ai/dsh-experimental-cua-macos/native/bin/darwin-arm64/abc/DSH Computer Use.app/Contents/MacOS/dsh-cua-native',
      'dsh/node_modules/@deepseek-ai/dsh-experimental-cua-macos/lib/index.js',
      'dsh/node_modules/open/xdg-open',
      'dsh/node_modules/open/index.js',
      'dsh/node_modules/x/lib/libfoo.so.1.2.3',
      'dsh/node_modules/x/lib/person.so.js',
      'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js',
      'primary-runtime/dependencies/node/bin/node',
      'brand/tray.png',
    ]) {
      assert.equal(unpacked(`/app/.staged/resources/${rel}`, file), isUnpacked(rel), `unpack pattern parity for ${rel}`);
    }
    // 目录决定会不会被走到：归档里的 node_modules 要走到，归档旁的 dsh 整棵不走到。
    assert.equal(packed('/res/dsh/node_modules', directory), true);
    assert.equal(packed('/res/dsh/node_modules/pkg/node_modules', directory), true);
    assert.equal(packed('/res/primary-runtime', directory), false);
    assert.equal(loose('/res/dsh', directory), false);
    assert.equal(loose('/res/primary-runtime', directory), true);
  }
});

test('安装包内容（真实目录树）：electron-builder 的遍历器对目录也按模式裁决——被裁目录里的许可证照收，同目录的普通文件不收，与规则逐项一致', { skip: appBuilderPackage() === null ? 'electron-builder is not installed' : false }, async (t) => {
  // 逐文件的匹配看不到目录剪枝：遍历器拿同一组模式去问每个目录，被拒绝的目录不会被进入。
  const req = createRequire(appBuilderPackage());
  const { FileMatcher } = req('./out/fileMatcher.js');
  const { AppFileWalker } = req('./out/util/AppFileWalker.js');
  const { walk } = req('builder-util/out/fs');
  const resources = temp(t);
  const planted = [
    'dsh/node_modules/pkg/index.js',
    'dsh/node_modules/pkg/test/foo.js',
    'dsh/node_modules/pkg/test/LICENSE',
    'dsh/node_modules/pkg/docs/guide.md',
    'dsh/node_modules/@scope/pkg/docs/NOTICE.md',
    'dsh/node_modules/pkg/examples/COPYING',
    'dsh/node_modules/pkg/.github/workflows/ci.yml',
    'dsh/node_modules/pkg/fixtures/LICENSE',
    'dsh/node_modules/pkg/README.MD',
    'dsh/node_modules/pkg/Changelog.rst',
    'dsh/node_modules/pkg/history.txt',
    'dsh/node_modules/open/README.md',
    'primary-runtime/dependencies/node/bin/node',
  ];
  for (const rel of planted) {
    mkdirSync(dirname(join(resources, rel)), { recursive: true });
    writeFileSync(join(resources, rel), 'x');
  }
  // electron-builder 收集应用文件的方式：过滤器逐文件裁决，遍历器逐目录裁决。
  const matcher = new FileMatcher(resources, resources, (pattern) => pattern, payloadFilter());
  const walker = new AppFileWalker(matcher, { areNodeModulesHandledExternally: false });
  const collected = (await walk(resources, walker.filter, walker)).map((file) => relative(resources, file).split(sep).join('/')).sort();
  assert.deepEqual(collected, planted.filter((rel) => rel.startsWith('dsh/') && isPackaged(rel)).sort());
});

test('解包规则：交给操作系统的才是真实文件——原生库与可执行、按名字指定的程序、原生进程要读的整棵目录', () => {
  const N = 'dsh/node_modules/';
  for (const unpacked of [
    '@deepseek-ai/node-addon-system-darwin-arm64/bin/system.node',
    '@img/sharp-darwin-arm64/lib/sharp-darwin-arm64.node',
    '@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.42.dylib',
    'sherpa-onnx-darwin-arm64/libsherpa-onnx-c-api.dylib',
    'node-pty/prebuilds/darwin-arm64/pty.node',
    'node-pty/prebuilds/win32-x64/conpty.node',
    'node-pty/prebuilds/darwin-arm64/spawn-helper',
    '@vscode/ripgrep-darwin-arm64/bin/rg',
    '@vscode/ripgrep-win32-x64/bin/rg.exe',
    'open/xdg-open',
    '@deepseek-ai/libreoffice-kit-darwin-arm64/bin/dsoffice',
    '@deepseek-ai/libreoffice-kit-win32-x64/program/soffice.bin',
    '@deepseek-ai/dsh-experimental-cua-macos/native/bin/darwin-arm64/abc/DSH Computer Use.app/Contents/Info.plist',
  ]) {
    assert.equal(isUnpacked(N + unpacked), true, unpacked);
  }
  // 反向：只被运行时自己读的留在归档里——JS、技能文本、由 JS 读进内存的 wasm、清单，以及名字相同但不在那个位置的文件。
  for (const packed of [
    '@deepseek-ai/dsh/lib/bin.js',
    '@deepseek-ai/dsh/lib/types/bin.d.ts',
    '@deepseek-ai/libreoffice-kit/lib/index.js',
    '@deepseek-ai/libreoffice-kit-wasm/lib/x.wasm',
    '@deepseek-ai/dsh-experimental-cua-macos/lib/index.js',
    '@deepseek-ai/dsh-experimental-cua-macos/native/manifest.json',
    '@deepseek-ai/dsh-skill-office/assets/office/SKILL.md',
    'open/index.js',
    'nested/deep/xdg-open',
    '@vscode/ripgrep-darwin-arm64/lib/index.js',
    '@other-scope/ripgrep-darwin-arm64/bin/rg',
    'x/lib/person.so.js',
    'x/lib/is-also.js',
  ]) {
    assert.equal(isUnpacked(N + packed), false, packed);
  }
  // 归档之外的资源本来就是真实文件，不在这条规则的话下。
  assert.equal(isUnpacked('primary-runtime/dependencies/node/bin/node'), false);
  assert.equal(isUnpacked('brand/tray.png'), false);
});

test('打包配置：内嵌运行时整棵进归档，其余资源原样随包，解包清单是规则的那一份；maximum 压缩、关闭差分包、afterPack 钩子与中英文语言包', (t) => {
  const root = temp(t);
  const resourcesDir = join(root, 'resources');
  const config = builderConfig({ identity: readAppIdentity(identityFile(root)), version: '1.2.3', resourcesDir, iconsDir: join(BRAND_DIR, 'icons'), appDir: join(REPO_ROOT, 'services', 'forge-desktop'), outputDir: join(root, 'dist') });
  // 壳自己的代码，加上暂存资源里的 `dsh/` 一棵：归档里只有这两样。
  assert.deepEqual(config.files.slice(0, -1), ['src/**/*', 'package.json', 'runtime-lock.json']);
  assert.deepEqual(config.files.at(-1), { from: resolve(resourcesDir), to: '.', filter: payloadFilter() });
  // 顺序就是规则：第三方开发用件先排除，许可证重新纳入，运行时不读的类型与映射图随后排除，制品目录原样保留，整棵解包的目录最后让出。
  const filter = payloadFilter();
  const verbatim = filter.indexOf('dsh/node_modules/@deepseek-ai/dsh/**');
  assert.deepEqual(filter.slice(verbatim), [
    'dsh/node_modules/@deepseek-ai/dsh/**',
    '!dsh/node_modules/@deepseek-ai/libreoffice-kit-{darwin,win32,linux}-*/{,/**}',
    '!dsh/node_modules/@deepseek-ai/dsh-experimental-cua-macos/native/bin/{,/**}',
  ]);
  assert.ok(filter.indexOf('dsh/node_modules/**/[Nn][Oo][Tt][Ii][Cc][Ee]*') < filter.indexOf('!dsh/**/*.ts'), 'license files are re-included before types are excluded');
  assert.equal(config.asar, true);
  // 归档旁：同一份暂存资源去掉 `dsh/`——内置运行时、品牌与员工包原样随包。
  assert.deepEqual(config.extraResources, [{ from: resolve(resourcesDir), to: '.', filter: resourcesFilter() }]);
  assert.deepEqual(resourcesFilter(), ['**/*', '!dsh{,/**}']);
  // 解包清单与 `isUnpacked` 是同一条规则的两种说法，一致性由上面的对照用例守住。
  assert.deepEqual(config.asarUnpack, ASAR_UNPACK);
  assert.equal(new Set(ASAR_UNPACK).size, ASAR_UNPACK.length);
  assert.equal(config.compression, 'maximum');
  assert.equal(config.dmg.writeUpdateInfo, false);
  assert.equal(existsSync(config.afterPack), true, 'afterPack hook script must exist');
  // 本应用不建自动更新 feed，差分形式的归档比 solid 归档大三分之一。
  assert.equal(config.nsis.differentialPackage, false);
  // 两种拼写各对应一种平台的语言文件名：macOS 用 en / zh_CN / zh_TW，Windows 与 Linux 用 en-US / zh-CN / zh-TW，无重复项。
  assert.deepEqual(config.electronLanguages, ['en', 'en-US', 'zh-CN', 'zh-TW', 'zh_CN', 'zh_TW']);
  assert.equal(new Set(config.electronLanguages).size, config.electronLanguages.length);
  assert.equal(config.nsis.deleteAppDataOnUninstall, false);
});

test('目标与架构矩阵：macOS 只产压缩 dmg，x64 与麒麟 linux arm64/x64 各自对齐并拒绝不支持的组合', (t) => {
  const root = temp(t);
  const identity = readAppIdentity(identityFile(root));
  const common = { identity, version: '1.2.3', resourcesDir: join(root, 'resources'), iconsDir: join(BRAND_DIR, 'icons'), appDir: join(REPO_ROOT, 'services', 'forge-desktop'), outputDir: join(root, 'dist') };
  const macX64 = builderConfig({ ...common, target: 'mac', arch: 'x64' });
  assert.deepEqual(macX64.mac.target, [{ target: 'dmg', arch: ['x64'] }]);
  const linuxArm = builderConfig({ ...common, target: 'linux', arch: 'arm64' });
  assert.deepEqual(linuxArm.linux.target, [{ target: 'deb', arch: ['arm64'] }]);
  assert.equal(linuxArm.linux.icon.endsWith('app-icon-512.png'), true);
  assert.equal(linuxArm.linux.maintainer.includes('@'), true);
  const desktopPkg = JSON.parse(readFileSync(join(REPO_ROOT, 'services', 'forge-desktop', 'package.json'), 'utf8'));
  assert.match(desktopPkg.homepage, /^https:\/\//);
  assert.equal(resolveTargetArch('linux'), 'x64');
  assert.equal(resolveTargetArch('win'), 'x64');
  assert.throws(() => resolveTargetArch('win', 'arm64'), (error) => error.code === 'BAD_ARGUMENT');
  assert.throws(() => resolveTargetArch('linux', 'universal'), (error) => error.code === 'BAD_ARGUMENT');
});

/** A packed app as afterPack finds it: staged resources inside the app directory, and the archive with its unpacked tree. */
function packedApp(t, electronPlatformName) {
  const root = temp(t);
  const resourcesDir = join(root, 'app', '.staged', 'resources');
  const appOutDir = join(root, electronPlatformName === 'darwin' ? 'mac-arm64' : 'win-unpacked');
  const appBundle = join(appOutDir, 'Heluo Forge Enterprise.app');
  const resources = electronPlatformName === 'darwin' ? join(appBundle, 'Contents', 'Resources') : join(appOutDir, 'resources');
  const staged = (rel, content) => {
    mkdirSync(dirname(join(resourcesDir, rel)), { recursive: true });
    writeFileSync(join(resourcesDir, rel), content);
  };
  const MODULE = 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js';
  const NATIVE = 'dsh/node_modules/node-pty/prebuilds/darwin-arm64/pty.node';
  staged(MODULE, 'entry');
  staged(NATIVE, MACHO);
  const archivePath = join(resources, 'app.asar');
  const entries = [
    { path: 'src/main.mjs', content: 'the shell' },
    { path: MODULE, content: 'entry' },
    { path: NATIVE, content: MACHO, unpacked: true },
  ];
  writeAsar(archivePath, entries);
  const context = { electronPlatformName, appOutDir, packager: { appInfo: { productFilename: 'Heluo Forge Enterprise' }, config: { extraResources: [{ from: resourcesDir, to: '.', filter: [] }] } } };
  return { appBundle, appOutDir, archivePath, context, entries, resourcesDir };
}

test('afterPack：每个平台先核对归档里的运行时与暂存逐字节一致；macOS 另清理 Electron Framework 内多余 .lproj', async (t) => {
  const windows = packedApp(t, 'win32');
  const archive = { files: 2, packed: 1, unpacked: 1, links: 0, trimmedManifests: 0, bytes: 'entry'.length, archiveBytes: statSync(windows.archivePath).size };
  assert.deepEqual(await afterPack(windows.context), { archive }, 'a Windows build is verified the same way');
  assert.equal(existsSync(join(windows.archivePath, '..', 'app.asar.unpacked', 'dsh', 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64', 'pty.node')), true);

  const mac = packedApp(t, 'darwin');
  const frameworkRes = join(mac.appBundle, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources');
  const appRes = join(mac.appBundle, 'Contents', 'Resources');
  for (const locale of [...KEEP_MAC_LPROJ, 'fr.lproj', 'de.lproj', 'ja.lproj']) {
    mkdirSync(join(frameworkRes, locale), { recursive: true });
    writeFileSync(join(frameworkRes, locale, 'locale.pak'), 'data');
  }
  mkdirSync(join(appRes, 'es.lproj'), { recursive: true });
  writeFileSync(join(appRes, 'es.lproj', 'InfoPlist.strings'), 'es');
  writeFileSync(join(frameworkRes, 'icudtl.dat'), 'icu');

  const summary = await afterPack(mac.context);
  assert.deepEqual(summary.archive, archive);
  assert.equal(summary.removedDirs, 4);
  assert.equal(summary.removedFiles, 4);
  for (const kept of KEEP_MAC_LPROJ) assert.equal(existsSync(join(frameworkRes, kept)), true, `${kept} kept`);
  for (const gone of ['fr.lproj', 'de.lproj', 'ja.lproj']) assert.equal(existsSync(join(frameworkRes, gone)), false, `${gone} removed`);
  assert.equal(existsSync(join(appRes, 'es.lproj')), false);
  assert.equal(existsSync(join(frameworkRes, 'icudtl.dat')), true, 'non-lproj framework resource preserved');
  assert.equal(pruneMacLocales(join(mac.appOutDir, 'missing.app')).removedDirs, 0);
});

test('afterPack 反向：归档与暂存不一致、或无从对照时，任何平台的构建都失败', async (t) => {
  for (const electronPlatformName of ['win32', 'darwin']) {
    const app = packedApp(t, electronPlatformName);
    // One byte of the packed runtime is not what was staged.
    writeAsar(app.archivePath, app.entries.map((entry) => (entry.path.endsWith('bin.js') ? { ...entry, content: 'tampered' } : entry)));
    await assert.rejects(afterPack(app.context), (error) => error.code === 'ARCHIVE_MISMATCH' && /bytes differ/u.test(error.message), electronPlatformName);
    // The native library left inside the archive.
    writeAsar(app.archivePath, app.entries.map((entry) => ({ ...entry, unpacked: false })));
    await assert.rejects(afterPack(app.context), (error) => error.code === 'NATIVE_PACKED', electronPlatformName);
    // Nothing staged to compare against is not a pass.
    writeAsar(app.archivePath, app.entries);
    await assert.rejects(afterPack({ ...app.context, packager: { appInfo: { productFilename: 'Heluo Forge Enterprise' } } }), (error) => error.code === 'ARCHIVE_UNVERIFIED', electronPlatformName);
  }
});

test('体积摘要：逐文件分类，数字取自真实文件；进安装器后只有归档之外的与解包的才是真实文件', (t) => {
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
  write('dsh/node_modules/node-pty/prebuilds/darwin-arm64/pty.node', 90);
  write('brand/tray.png', 80);
  // 员工包里的 source map 在归档之外：原样随包，记入磁盘上的那一份，不算已裁剪。
  write('enterprise-assets/employee/app.js.map', 100);
  const summary = summarizeResources(resources);
  assert.deepEqual(summary, {
    files: 8,
    bytes: 520,
    excluded: { files: 2, bytes: 130 },
    archive: { files: 3, bytes: 120 },
    onDisk: { files: 3, bytes: 270 },
  });
  // 归档里的与磁盘上的加起来，就是进包的那些。
  assert.equal(summary.archive.files + summary.onDisk.files, summary.files - summary.excluded.files);
  assert.equal(summary.archive.bytes + summary.onDisk.bytes, summary.bytes - summary.excluded.bytes);
});

test('暂存的资源必须位于应用目录之内：electron-builder 从应用目录起数路径，目录之外、或经链接指向别处的树都被拒', (t) => {
  const root = temp(t);
  const appDir = join(root, 'services', 'forge-desktop');
  const inside = join(appDir, '.staged', 'resources');
  mkdirSync(inside, { recursive: true });
  // Both come back as where they really are, and go to electron-builder that way.
  assert.deepEqual(stagedInsideAppDir(appDir, inside), { appDir: realpathSync(appDir), resourcesDir: realpathSync(inside) });
  // An app directory reached through a link is followed: what counts is where things are.
  const link = join(root, 'link-to-app');
  symlinkSync(appDir, link, 'dir');
  assert.deepEqual(stagedInsideAppDir(link, join(link, '.staged', 'resources')), { appDir: realpathSync(appDir), resourcesDir: realpathSync(inside) });

  const outside = join(root, 'elsewhere', 'resources');
  mkdirSync(outside, { recursive: true });
  const refused = (error) => error.code === 'RESOURCES_OUTSIDE_APP_DIR' && /inside the app directory/u.test(error.message);
  assert.throws(() => stagedInsideAppDir(appDir, outside), refused);
  // Inside by name only: a link under the app directory that leads somewhere else.
  const throughLink = join(appDir, '.staged', 'linked');
  symlinkSync(outside, throughLink, 'dir');
  assert.throws(() => stagedInsideAppDir(appDir, throughLink), refused);
  // A sibling whose name merely starts the same.
  const sibling = join(root, 'services', 'forge-desktop-other');
  mkdirSync(join(sibling, 'resources'), { recursive: true });
  assert.throws(() => stagedInsideAppDir(appDir, join(sibling, 'resources')), refused);
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
