/**
 * #37: final self-contained tarball -> clean offline install -> real isolated
 * Cordis/Loader activation -> upgrade/rollback/unload/uninstall. No user profile.
 * DSH_BIN selects an existing CLI; DSH_NODE_MODULES may explicitly select its
 * already installed SDK modules. No downloads, symlinks, servers or OS keychain.
 * The measured macOS desktop launcher uses its installed Electron runtime to
 * read app.asar; ordinary CLI installations keep their original Node runtime.
 * The memory credential backend is an explicit LOCAL fixture, not enterprise IAM evidence.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildBundle, buildEnterpriseBundle } from '../build-enterprise-bundle.mjs';
import { auditReleaseClosure, execNpm, parsePatchLayer } from '../lib/bundle-rules.mjs';
import { resolveDshProbeHost } from '../lib/dsh-probe-runtime.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dsh = process.env.DSH_BIN ?? 'dsh';
const hostLocation = resolveDshProbeHost({ dsh, modules: process.env.DSH_NODE_MODULES });
// Vanilla Node cannot import modules inside ASAR. Re-enter once using this
// installation's own Electron, preserving argv, exit status and the Node/npm PATH.
if (hostLocation.runtime !== null && realpathSync(process.execPath) !== hostLocation.runtime) {
  const child = spawnSync(hostLocation.runtime, ['--expose-internals', fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
  });
  if (child.error) console.error(`rehearsal: desktop runtime failed: ${child.error.message}`);
  process.exit(child.status ?? 1);
}
const profile = process.env.DSH_HOST_PROBE_PROFILE ?? 'sdk';
const { OFFICIAL_ROWS: officialRows } = await import('../../packages/forge-enterprise/src/reflow.mjs');
const dir = mkdtempSync(join(tmpdir(), 'forge-install-rehearsal-'));
const project = join(dir, 'project');
const evidence = { probe: 'forge-bundle-install-rehearsal', startedAt: new Date().toISOString(), scope: 'local final-tarball composition, NOT enterprise IAM/keychain/registry acceptance', env: { profile, platform: `${process.platform}-${process.arch}`, node: process.version, operatorRole: 'authorized local sol_worker; synthetic credential fixture' }, steps: [], ok: true };
const record = (id, ok, detail = {}) => {
  evidence.steps.push({ id, ok, detail });
  if (!ok) evidence.ok = false;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${id}${ok ? '' : ` ${JSON.stringify(detail)}`}`);
};
const isolatedEnv = { ...process.env, DSH_HOME: join(dir, 'dsh-home'), npm_config_cache: join(dir, 'npm-cache'), npm_config_userconfig: join(dir, 'empty-npmrc'), npm_config_registry: 'http://127.0.0.1:9' };
delete isolatedEnv.DSH_PROFILE;
delete isolatedEnv.DSH_PROFILE_DIR;
const npm = (args) => execNpm(['--offline', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error', ...args], { cwd: project, env: isolatedEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const enterpriseDir = join(project, 'node_modules', '@heluo', 'forge-enterprise');
const engineeringDir = join(project, 'node_modules', '@heluo', 'forge-engineering');
const intact = () => readFileSync(join(project, 'user-file.txt'), 'utf8') === 'user-workspace-marker\n' && readFileSync(join(project, 'user-notes', 'notes.md'), 'utf8') === '# 用户笔记\n';
const statusAtStart = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

async function activateInstalled(label, host) {
  const load = (name) => import(pathToFileURL(host.resolve(name)).href);
  const [{ Context }, { default: Loader }, { default: SystemPrompt }, { default: Tools }, { PluginPackages, createRuntimeResolution }] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/cordis-plugin-loader'), load('@deepseek-ai/dsh-system-prompt'), load('@deepseek-ai/dsh-tools'), load('@deepseek-ai/dsh-app-boot'),
  ]);
  const enterpriseInstalledPath = realpathSync(enterpriseDir);
  const engineeringInstalledPath = realpathSync(engineeringDir);
  const enterpriseRequire = createRequire(pathToFileURL(join(enterpriseInstalledPath, 'package.json')));
  const engineeringRequire = createRequire(pathToFileURL(join(engineeringInstalledPath, 'package.json')));
  // 通用底座与企业研发套件为两个独立预装包，各自携带 cordis.patch.yml；
  // 并存安装时仅共享 `heluo-policy` 策略行，其余能力按包隔离且互不强耦合。
  const enterprisePatch = parsePatchLayer(readFileSync(join(enterpriseDir, 'cordis.patch.yml'), 'utf8'));
  const engineeringPatch = parsePatchLayer(readFileSync(join(engineeringDir, 'cordis.patch.yml'), 'utf8'));
  const mergedRows = new Map();
  for (const row of [...enterprisePatch.inserted, ...engineeringPatch.inserted]) {
    if (!mergedRows.has(row.id)) mergedRows.set(row.id, row);
  }
  const patch = { inserted: [...mergedRows.values()] };
  const ctx = new Context();
  let unloaded = false;
  const ids = [];
  try {
    const resolution = await createRuntimeResolution({
      installAnchor: host.resolve('@deepseek-ai/dsh/package.json'),
      home: isolatedEnv.DSH_HOME,
      profile: {
        dir: project,
        layers: [
          { packageName: '@heluo/forge-enterprise', packageDir: enterpriseInstalledPath },
          { packageName: '@heluo/forge-engineering', packageDir: engineeringInstalledPath },
        ],
        skippedBundles: [],
      },
    });
    await ctx.plugin(PluginPackages, { resolution }).await();
    const enterpriseDeps = Object.keys(JSON.parse(readFileSync(join(enterpriseDir, 'package.json'), 'utf8')).dependencies);
    const engineeringDeps = Object.keys(JSON.parse(readFileSync(join(engineeringDir, 'package.json'), 'utf8')).dependencies);
    const sharedDeps = new Set(enterpriseDeps.filter((name) => engineeringDeps.includes(name)));
    const resolvedFrom = (name, prefixes) => resolution.entries.some(
      (entry) => entry.name === name
        && entry.scope === 'profile'
        && prefixes.some((prefix) => realpathSync(entry.packageDir).startsWith(`${prefix}/`)),
    );
    const enterpriseResolves = enterpriseDeps.every((name) => resolvedFrom(name, sharedDeps.has(name) ? [enterpriseInstalledPath, engineeringInstalledPath] : [enterpriseInstalledPath]));
    const engineeringResolves = engineeringDeps.every((name) => resolvedFrom(name, sharedDeps.has(name) ? [enterpriseInstalledPath, engineeringInstalledPath] : [engineeringInstalledPath]));
    record(`${label}-native-runtime-resolves-bundled-members`, enterpriseResolves && engineeringResolves);
    await ctx.plugin(SystemPrompt, {}).await();
    await ctx.plugin(Tools, {}).await();
    await ctx.plugin(Loader, { baseUrl: pathToFileURL(join(enterpriseInstalledPath, 'cordis.patch.yml')).href }).await();
    // 正式企业研发 Skill 入口声明 `inject: ['skills']`：真实宿主里该服务由 Skill 能力提供，
    // 这个最小夹具没有它。给一份"只记录注册"的最小服务，入口才能真正进入 ACTIVE，并顺带
    // 证明"装上就有入口可枚举"（AC-1）——而不是被 inject 挡在 PENDING 冒充通过或冒充失败。
    const skillProviders = new Map();
    ctx.provide('skills', {
      registerProvider: (create) => {
        const provider = create();
        skillProviders.set(provider.name, provider);
        return () => skillProviders.delete(provider.name);
      },
      register: (entry) => {
        const at = skillProviders.size;
        skillProviders.set(`direct-${at}-${entry?.name ?? 'unknown'}`, entry);
        return () => skillProviders.delete(`direct-${at}-${entry?.name ?? 'unknown'}`);
      },
    });
    const enterpriseIdSet = new Set(enterprisePatch.inserted.map((row) => row.id));
    const engineeringIdSet = new Set(engineeringPatch.inserted.map((row) => row.id));
    const enterpriseCatalogText = readFileSync(join(enterpriseDir, 'cordis.patch.yml'), 'utf8');
    const resolved = [];
    for (const row of patch.inserted) {
      const fromEngineering = engineeringIdSet.has(row.id) && !enterpriseIdSet.has(row.id);
      const ownerRequire = fromEngineering ? engineeringRequire : enterpriseRequire;
      const ownerPath = fromEngineering ? engineeringInstalledPath : enterpriseInstalledPath;
      const entry = ownerRequire.resolve(row.name);
      const memberPath = relative(ownerPath, entry);
      if (memberPath.startsWith('..') || isAbsolute(memberPath)) throw new Error(`member escaped installed tarball: ${row.name}`);
      resolved.push({ name: row.name, entry: memberPath });
      // 行配置必须**照抄补丁里的 config**：策略目录就在 heluo-policy 行里，
      // 两个预装包携带逐字一致的 6 条动作目录，合并后按 id 去重只实例化一份。
      // 只有凭据后端与策略审计是显式本地夹具（内存实现，非企业 IAM 证据）。
      const config = row.name === '@heluo/forge-credentials-keychain'
        ? { ...(row.config ?? {}), backend: (await import(pathToFileURL(entry).href)).createMemoryBackend(), allowEphemeral: true }
        : row.name === '@heluo/forge-policy'
          ? { catalog: catalogFromPatch(enterpriseCatalogText), audit: { sink: 'memory', allowNonDurable: true } }
          : (row.config ?? {});
      ids.push(await ctx.loader.create({ id: row.id, name: row.name, config }));
    }
    await ctx.loader.await();
    // 底座三行（凭据/策略/IAM）＋研发套件五行（共享策略/容器/Skill/DevOps/Gitee），
    // 按 id 去重合并为 7 行，仅共享策略行 `heluo-policy` 重合。
    record(
      `${label}-patch-mounts-base-and-overlay`,
      patch.inserted.length === 7 && new Set(patch.inserted.map((row) => row.id)).size === 7 && resolved.length === 7,
      { ids: patch.inserted.map((row) => row.id) },
    );
    // 分包隔离要被证明：底座不得偷带研发成员，研发套件不得携带 IAM/凭据行，仅共享 heluo-policy。
    const baseIds = enterprisePatch.inserted.map((row) => row.id);
    const engineeringIdsAll = engineeringPatch.inserted.map((row) => row.id);
    const sharedIds = baseIds.filter((id) => engineeringIdsAll.includes(id));
    const engineeringOnlyIds = ['heluo-engineering-ui', 'heluo-issue-delivery-skill', 'forge-devops', 'heluo-gitee'];
    const baseOnlyIds = ['heluo-credentials-keychain', 'heluo-iam'];
    record(
      `${label}-layers-are-disjoint`,
      baseIds.length === 3
        && engineeringIdsAll.length === 5
        && sharedIds.length === 1
        && sharedIds[0] === 'heluo-policy'
        && engineeringOnlyIds.every((id) => engineeringIdsAll.includes(id) && !baseIds.includes(id))
        && baseOnlyIds.every((id) => baseIds.includes(id) && !engineeringIdsAll.includes(id)),
      { baseIds, engineeringIds: engineeringIdsAll, sharedIds },
    );
    // 失败行要给出**原因**：只报 phase=3 的探针会把"配置被拒"和"依赖缺失"混成一句话。
    const phases = [];
    for (const id of ids) {
      const fiber = ctx.loader.resolve(id).fiber;
      let error;
      if (fiber !== undefined && fiber.state !== 2) {
        try {
          await fiber.await();
        } catch (failure) {
          error = failure?.message ?? String(failure);
        }
      }
      phases.push({ id, phase: fiber?.state, ...(error === undefined ? {} : { error }) });
    }
    const mounted = ['credentials', 'policy', 'iam', 'devops', 'gitee'].every((key) => ctx.get(key) !== undefined);
    record(`${label}-real-loader-instantiates-members`, mounted && phases.every((entry) => entry.phase === 2 /* FiberState.ACTIVE (const enum in the installed SDK) */), { resolved, phases, fixture: 'memory credentials; no real identity, keychain or network' });
    // AC-1：装上之后 Skill 入口必须**可枚举**（摘要 + 按需正文），而不是"装上了却静默无入口"。
    const skillProvider = skillProviders.get('enterprise-clauses');
    const listed = skillProvider === undefined ? [] : await skillProvider.list();
    const skillBody = skillProvider === undefined ? undefined : await skillProvider.get('enterprise-issue-delivery');
    record(
      `${label}-issue-delivery-skill-discoverable`,
      listed.length === 1
        && listed[0].name === 'enterprise-issue-delivery'
        && listed[0].invocation?.modelInvocable === false
        && typeof skillBody?.content === 'string'
        && skillBody.content.includes('单 Issue 可信待验收交付'),
      { providers: [...skillProviders.keys()], listed: listed.map((entry) => ({ name: entry.name, invocation: entry.invocation })) },
    );
    // D-1：候选把宿主校验的字段带齐（source/rank/provider/locator），并按需给正文路径；
    // 发现面不含正文——正文只在 `get()` 时取，避免一次装配把全部条款读进上下文。
    // 每项都按 AC-2 的判据逐条核对，而不是只看第一条。
    const candidate = listed.length === 1 ? listed[0] : undefined;
    if (label === 'install') {
      record(
        'installed-skill-candidate-shape',
        listed.length === 1
          && listed.every((entry) => typeof entry.source === 'string' && entry.source.length > 0
            && entry.resourceBase?.kind === 'directory'
            && typeof entry.resourceBase.path === 'string'
            && entry.resourceBase.path === join(engineeringInstalledPath, 'skills', 'issue-delivery')
            && !('content' in entry)
            && typeof entry.invocation?.modelInvocable === 'boolean'
            && typeof entry.invocation?.userInvocable === 'boolean')
          && candidate.source === 'bundled'
          && candidate.rank === 600
          && candidate.provider === 'enterprise-clauses'
          && candidate.locator?.clause === 'issue-delivery'
          && typeof candidate.path === 'string'
          && candidate.path.endsWith(`${sep}SKILL.md`)
          && existsSync(candidate.path),
        { candidate: candidate === undefined ? null : { ...candidate, metadata: undefined } },
      );
    }
    // 宿主拿 list() 的候选直接 get()：不要求调用方自己拆 name/locator；正文与按名取一致。
    const byCandidate = skillProvider === undefined || candidate === undefined ? undefined : await skillProvider.get(candidate);
    if (label === 'install') {
      record(
        'installed-skill-get-by-candidate',
        typeof byCandidate?.content === 'string'
          && byCandidate.content === skillBody?.content
          && byCandidate.content.includes('单 Issue 可信待验收交付'),
        { bytes: byCandidate?.content?.length ?? 0 },
      );
    }
    if (label === 'install') {
      const enterpriseManifest = JSON.parse(readFileSync(join(enterpriseDir, 'package.json'), 'utf8'));
      const engineeringManifest = JSON.parse(readFileSync(join(engineeringDir, 'package.json'), 'utf8'));
      const members = [
        ...Object.keys(enterpriseManifest.dependencies ?? {}),
        ...(enterpriseManifest.bundledDependencies ?? []),
        ...Object.keys(engineeringManifest.dependencies ?? {}),
        ...(engineeringManifest.bundledDependencies ?? []),
      ];
      record('legacy-sdd-member-retired', !members.includes('@heluo/forge-sdd'), { members });
    }
    const policy = ctx.get('policy');
    const iam = ctx.get('iam');
    record(`${label}-services-queryable`, policy !== undefined && Array.isArray(policy.actions()) && iam !== undefined && typeof iam.getView === 'function' && iam.getView() !== undefined);
    // Removing actual Loader rows must own and remove registrations, not merely files.
    for (const id of ids.reverse()) ctx.loader.remove(id);
    await ctx.loader.await();
    unloaded = ['credentials', 'policy', 'iam', 'devops', 'gitee'].every((key) => ctx.get(key) === undefined);
    record(`${label}-loader-unload-clears-registrations`, unloaded);
    record(`${label}-loader-unload-clears-skill-providers`, skillProviders.size === 0, { providers: [...skillProviders.keys()] });
  } finally {
    await ctx.fiber.dispose();
  }
  if (!unloaded) throw new Error(`${label}: lifecycle cleanup was not proven`);
}

/**
 * 补丁行配置只重建 `heluo-policy` 的策略目录：它是 Gitee/DevOps 装配期的硬依赖，
 * 而 `parsePatchLayer` 只读 id/name。从**安装后的**补丁文本取值，避免把目录写死在
 * 夹具里、与真实组合悄悄漂移。审计 sink 仍是内存夹具（不落盘、不对接企业审计）。
 */
function catalogFromPatch(text) {
  const catalog = [];
  for (const line of text.split('\n')) {
    const flow = line.match(/^\s*- \{ (?<body>.+) \}\s*$/u);
    if (flow === null) continue;
    const entry = {};
    for (const [, key, quoted, raw] of flow.groups.body.matchAll(/([A-Za-z_][\w-]*):\s*(?:'([^']*)'|([^,}]+))/gu)) {
      const plain = raw?.trim();
      entry[key] = quoted ?? (plain === 'true' ? true : plain === 'false' ? false : Number.isNaN(Number(plain)) ? plain : Number(plain));
    }
    if (typeof entry.action === 'string') catalog.push(entry);
  }
  return catalog;
}

function dump(patches) {
  const layers = patches === undefined || patches === null ? [] : (Array.isArray(patches) ? patches : [patches]);
  const args = ['--profile', profile];
  for (const layer of layers) args.push('--patch', layer);
  args.push('--dump-config');
  return spawnSync(dsh, args, { env: isolatedEnv, encoding: 'utf8' });
}
function rows(text) {
  const found = new Map();
  let id;
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*-?\s*id:\s*['"]?([^'"\s]+)['"]?\s*$/u);
    if (match) { id = match[1]; found.set(id, false); }
    if (id && /^\s*disabled:\s*true\s*$/u.test(line)) found.set(id, true);
  }
  return found;
}

mkdirSync(join(project, 'user-notes'), { recursive: true });
writeFileSync(join(project, 'package.json'), '{"name":"rehearsal-project","private":true}\n');
writeFileSync(join(project, 'user-file.txt'), 'user-workspace-marker\n');
writeFileSync(join(project, 'user-notes', 'notes.md'), '# 用户笔记\n');
writeFileSync(join(dir, 'empty-npmrc'), '');
try {
  const version = spawnSync(dsh, ['--version'], { env: isolatedEnv, encoding: 'utf8' });
  if (version.status !== 0) throw new Error(`DSH unavailable: ${version.error?.message ?? version.stderr}`);
  evidence.env.dshVersion = version.stdout.trim();
  evidence.env.npmVersion = execNpm(['--version'], { encoding: 'utf8' }).trim();
  evidence.env.sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  evidence.env.sourceState = 'uncommitted shared implementation; git HEAD is not a release commit';
  evidence.env.targetVersion = readFileSync(join(repo, '.dsh-version'), 'utf8').trim();
  const host = createRequire(pathToFileURL(hostLocation.anchor));
  evidence.env.sdkLayout = hostLocation.kind;
  const toolsManifest = JSON.parse(readFileSync(host.resolve('@deepseek-ai/dsh-tools/package.json'), 'utf8'));
  evidence.env.sdkVersion = toolsManifest.version;
  evidence.env.targetVerified = toolsManifest.version === evidence.env.targetVersion;
  evidence.env.targetStatus = evidence.env.targetVerified ? 'tested' : 'NOT RUN: installed SDK differs from target baseline';
  record('dsh-available', true, evidence.env);
  // This rehearsal checks composition with synthetic credentials, not production storage.
  const first = buildEnterpriseBundle({ destination: join(dir, 'pack-v1') });
  const engineeringFirst = buildBundle({ entry: '@heluo/forge-engineering', destination: join(dir, 'pack-v1-engineering') });
  evidence.artifact = {
    sha256: sha256(first.tarball),
    members: first.members,
    files: first.packed.length,
    version: first.manifest.version,
    engineering: {
      sha256: sha256(engineeringFirst.tarball),
      members: engineeringFirst.members,
      files: engineeringFirst.packed.length,
      version: engineeringFirst.manifest.version,
    },
    storage: 'synthetic fixture; production storage not verified',
  };
  npm(['install', first.tarball, engineeringFirst.tarball]);
  const installed = JSON.parse(readFileSync(join(enterpriseDir, 'package.json'), 'utf8'));
  const installedEngineering = JSON.parse(readFileSync(join(engineeringDir, 'package.json'), 'utf8'));
  record('install-v1-with-patch-and-workspace-intact', installed.version === first.manifest.version && installedEngineering.version === engineeringFirst.manifest.version && intact());
  const closure = [
    ...auditReleaseClosure(enterpriseDir, { allowInstalledBinLinks: true }),
    ...auditReleaseClosure(engineeringDir, { allowInstalledBinLinks: true }),
  ];
  record('installed-final-tarball-closure', closure.length === 0, { errors: closure, isolatedEmptyCache: true, registryUnreachable: true });
  const base = dump();
  const patched = dump([
    join(enterpriseDir, 'cordis.patch.yml'),
    join(engineeringDir, 'cordis.patch.yml'),
  ]);
  const baselineRows = rows(base.stdout ?? '');
  const patchedRows = rows(patched.stdout ?? '');
  const present = officialRows.filter((id) => baselineRows.has(id));
  record('installed-patch-disables-official-rows', base.status === 0 && patched.status === 0 && present.length > 0 && present.every((id) => patchedRows.get(id) === true && baselineRows.get(id) === false), { present, absent: officialRows.filter((id) => !baselineRows.has(id)), note: 'dump proves composition only; absent rows are NOT disabled' });
  // §6.3：两个独立预装包各自携带同 id（`heluo-policy`）且目录逐字一致（六条并集，无 `isolate`），
  // 运行期由 Cordis Loader 按 id 去重保留单一策略实例；`--dump-config` 中每层补丁各占一节 `# == <path>`。
  // 带 `, patched by <path>` 的是被本补丁改写的官方 bundle 头，必须与独立插入段区分。
  const patchedLines = (patched.stdout ?? '').split('\n');
  const sectionStarts = [];
  for (let i = 0; i < patchedLines.length; i += 1) {
    const line = patchedLines[i];
    if (line.startsWith('# == ') && line.includes('cordis.patch.yml') && !line.includes('patched by')) {
      sectionStarts.push(i);
    }
  }
  const sections = sectionStarts.map((start, idx) => patchedLines.slice(start, sectionStarts[idx + 1] ?? patchedLines.length).join('\n'));
  const section = sections.join('\n');
  const rowCount = (text, id) => (text.match(new RegExp(`^-\\s*id:\\s*${id}\\s*$`, 'gmu')) ?? []).length;
  const actionsOf = (text) => [...text.matchAll(/^\s*-\s*action:\s*([\w.]+)\s*$/gmu)].map((match) => match[1]);
  const expectedActions = ['change.read', 'change.list', 'gitee.repository.read', 'gitee.issue.read', 'gitee.pr.read', 'gitee.delivery.judge'];
  const enterprisePolicyCatalog = catalogFromPatch(readFileSync(join(enterpriseDir, 'cordis.patch.yml'), 'utf8'));
  const engineeringPolicyCatalog = catalogFromPatch(readFileSync(join(engineeringDir, 'cordis.patch.yml'), 'utf8'));
  const catalogsIdentical = JSON.stringify(enterprisePolicyCatalog) === JSON.stringify(engineeringPolicyCatalog);
  record(
    'installed-patch-policy-union',
    patched.status === 0
      && sections.length === 2
      && sections.every((chunk) => rowCount(chunk, 'heluo-policy') === 1 && actionsOf(chunk).join() === expectedActions.join())
      && catalogsIdentical
      && rowCount(section, 'forge-devops') === 1
      && rowCount(section, 'heluo-gitee') === 1
      && rowCount(section, 'heluo-engineering-ui') === 1
      && !/isolate/u.test(section),
    {
      sections: sections.length,
      perSectionPolicyRows: sections.map((chunk) => rowCount(chunk, 'heluo-policy')),
      perSectionActions: sections.map(actionsOf),
      catalogsIdentical,
      devopsRows: rowCount(section, 'forge-devops'),
      giteeRows: rowCount(section, 'heluo-gitee'),
      containerRows: rowCount(section, 'heluo-engineering-ui'),
    },
  );
  await activateInstalled('install', host);
  const upgraded = buildEnterpriseBundle({ destination: join(dir, 'pack-v2'), version: '0.1.1' });
  const engineeringUpgraded = buildBundle({ entry: '@heluo/forge-engineering', destination: join(dir, 'pack-v2-engineering'), version: '0.1.1' });
  npm(['install', upgraded.tarball, engineeringUpgraded.tarball]);
  await activateInstalled('upgrade', host);
  record('upgrade-to-0.1.1-keeps-composition-and-workspace', JSON.parse(readFileSync(join(enterpriseDir, 'package.json'), 'utf8')).version === '0.1.1' && JSON.parse(readFileSync(join(engineeringDir, 'package.json'), 'utf8')).version === '0.1.1' && intact());
  npm(['install', first.tarball, engineeringFirst.tarball]);
  await activateInstalled('rollback', host);
  record('rollback-to-0.1.0-keeps-composition-and-workspace', JSON.parse(readFileSync(join(enterpriseDir, 'package.json'), 'utf8')).version === first.manifest.version && JSON.parse(readFileSync(join(engineeringDir, 'package.json'), 'utf8')).version === engineeringFirst.manifest.version && intact());
  npm(['uninstall', '@heluo/forge-enterprise', '@heluo/forge-engineering']);
  // SDD 退役后 bin 链接也应消失；路径按安装位置就地计算，不依赖已删除的变量。
  const retiredBin = join(project, 'node_modules', '.bin', process.platform === 'win32' ? 'forge-sdd.cmd' : 'forge-sdd');
  record('uninstall-removes-packages-and-keeps-workspace', !existsSync(enterpriseDir) && !existsSync(engineeringDir) && !existsSync(retiredBin) && intact());
  record('repository-working-tree-untouched', execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }) === statusAtStart, { note: 'concurrent edits in shared worktree may invalidate this snapshot' });
} catch (error) {
  record('rehearsal-exception', false, { error: error.message });
} finally {
  writeFileSync(join(dir, 'install-rehearsal.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`rehearsal: ${evidence.steps.filter((step) => step.ok).length}/${evidence.steps.length} steps ok`);
  console.log(`rehearsal: evidence ${join(dir, 'install-rehearsal.json')}`);
  if (!evidence.ok) process.exitCode = 1;
}
