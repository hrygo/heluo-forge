#!/usr/bin/env node
/**
 * `heluo-r15-uat` 独立 profile 的安装/回滚计划与证据核对（TECHNICAL §9/§10、AC-19）。
 *
 * 这个脚本**只读**：不装插件、不改 profile、不启动 DSH。它做两件事：
 *   --plan     打印"建模板—装—看—回滚"四条命令，以及目标 profile 目录的现状哈希，
 *              让人（或主 agent）照着执行，事后能证明改动范围只有这一个 profile。
 *   --verify   读一份安装日志，核对 `--dump-config` 里两个条目都在、每个设置分区都有
 *              与它自己包名同现的 `settings.section` 注册证据，且没有失败信号。
 *
 * 为什么不让子代理直接装：安装与回滚会动真实桌面 profile，属于需要当次授权的动作；
 * 这里把"要做什么、做完怎么证明"固化成可复算的文本，执行仍由主 agent 完成。
 *
 * 用法：
 *   node scripts/uat-profile.mjs --plan [--profile heluo-r15-uat] [--tarball <企业组合包 tgz>] [--port 48490]
 *   node scripts/uat-profile.mjs --verify <log> [--profile heluo-r15-uat]
 * 退出码：0 = 计划已打印 / 证据齐全；1 = 证据缺失；2 = 参数错误。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_PROFILE = 'heluo-r15-uat';
export const DEFAULT_PORT = 48490;
export const UAT_ENTRIES = Object.freeze(['heluo-gitee', 'forge-devops']);
export const UAT_PACKAGES = Object.freeze(['@heluo/forge-gitee', '@heluo/forge-devops']);
export const PATCH_LAYER_FILE = 'cordis.patch.yml';

/**
 * 目标分区与它的属主。分区由对应 client 的 `settings.section` 插槽注册，
 * 所以"挂载了"只能由同时带分区 id 与属主包名的注册证据证明；任意 `slot` 字样都不算。
 */
export const UAT_SECTIONS = Object.freeze([
  { id: 'devops-readiness', order: 29, owner: '@heluo/forge-devops' },
  { id: 'gitee', order: 50, owner: '@heluo/forge-gitee' },
  { id: 'devops', order: 60, owner: '@heluo/forge-devops' },
]);

/**
 * UAT 真正要验的两个包：企业组合包不含 DevOps/Gitee 分区（它的补丁层只挂 credentials/policy/iam），
 * 所以默认计划分别安装这两个 tarball；企业组合包仅在显式 `--tarball` 时作为可选附加。
 */
export const BUNDLE_ARTIFACTS = Object.freeze([
  { package: '@heluo/forge-devops', entry: 'forge-devops', file: 'heluo-forge-devops-0.1.0.tgz' },
  { package: '@heluo/forge-gitee', entry: 'heluo-gitee', file: 'heluo-forge-gitee-0.1.0.tgz' },
]);

/** 失败信号：装错了会在冷启动日志里出现这些字样（大小写不敏感）。 */
export const FAILURE_MARKERS = Object.freeze([
  'entry not found',
  'cannot find module',
  'invalid effect',
  'slot "settings.section" is not declared',
]);

const USAGE = [
  '用法：node scripts/uat-profile.mjs --plan [--profile <名>] [--tarball <tgz>] [--port <端口>]',
  '      node scripts/uat-profile.mjs --verify <日志文件> [--profile <名>]',
  '',
  '只读脚本：不安装、不修改 profile、不启动 DSH。',
  '',
  '选项：',
  `  --profile <名>   目标 profile，默认 ${DEFAULT_PROFILE}（必须是独立 profile，不要用日常那个）`,
  '  --tarball <tgz>  可选：额外安装企业组合包（它不含 DevOps/Gitee 分区，不替代前两个包）',
  `  --port <端口>    启动端口，默认 ${DEFAULT_PORT}（仅监听 127.0.0.1）`,
  '',
  '退出码：0 = 已打印计划 / 证据齐全；1 = 证据缺失；2 = 参数错误',
].join('\n');

function argValue(argv, name) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === name) {
      const next = argv[index + 1];
      return next === undefined || next.startsWith('-') ? undefined : next;
    }
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

export function dshHomeOf(env = process.env, home = homedir()) {
  const configured = env.DSH_HOME === undefined ? '' : String(env.DSH_HOME).trim();
  return configured.length > 0 ? resolve(configured) : join(home, '.dsh');
}

/** 目录现状：文件数 + 名字/大小清单的 sha256（只读，用来证明"只动了这个 profile"）。 */
export function directoryDigest(dir) {
  if (!existsSync(dir)) return null;
  const files = [];
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const full = join(current, entry.name);
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(full, relative);
      else if (entry.isFile()) files.push(`${relative}:${statSync(full).size}`);
    }
  };
  walk(dir, '');
  return {
    files: files.length,
    digest: createHash('sha256').update(files.join('\n')).digest('hex'),
  };
}

function patchLayerState(file) {
  if (!existsSync(file)) return null;
  let hasInsert = false;
  try {
    hasInsert = /^[ \t]*-[ \t]*insert:[ \t]*$/m.test(readFileSync(file, 'utf8'));
  } catch {
    hasInsert = false;
  }
  return { path: file, ...directoryDigest(join(file, '..')), hasInsert };
}

/**
 * 安装/回滚计划。只描述命令，不执行——执行需要当次授权。
 *
 * 命令按实测宿主的真实位置生成（宿主构建为应用内置版，版本以该构建清单为准）：
 * - 先 `--from-default-profile web --dump-config` 建模板：`dsh plugin add` 建出的空 profile
 *   没有 web 模板，直接启动无监听、日志 0 字节。
 * - 装包走 `dsh plugin --profile <p> add <绝对路径 tgz>`：`plugin` 必须在子命令位置；
 *   相对路径会解析到 profile 目录而不是仓库，报 ENOENT。
 * - 启动不带 `web` 尾词（`dsh web --profile p` 会报额外参数），web 应用参数放在 profile 后。
 *
 * @param {{profile?: string, tarball?: string, port?: number, env?: NodeJS.ProcessEnv, home?: string, root?: string}} [options]
 */
export function planUat({ profile = DEFAULT_PROFILE, tarball, port = DEFAULT_PORT, env = process.env, home = homedir(), root = process.cwd() } = {}) {
  const dshHome = dshHomeOf(env, home);
  const dir = join(dshHome, 'profiles', profile);
  const patchLayerPath = join(dir, PATCH_LAYER_FILE);
  const profileExists = existsSync(dir);
  const artifacts = BUNDLE_ARTIFACTS.map((artifact) => {
    const path = resolve(root, 'dist', artifact.file);
    return { ...artifact, path, exists: existsSync(path) };
  });
  if (tarball !== undefined) {
    const enterprisePath = resolve(root, tarball);
    artifacts.push({ package: '@heluo/forge-enterprise', entry: 'forge-enterprise', path: enterprisePath, exists: existsSync(enterprisePath) });
  }

  const warnings = [];
  if (profile !== DEFAULT_PROFILE) warnings.push(`profile 不是 ${DEFAULT_PROFILE}：确认它是独立的测试 profile，不要复用日常 profile`);
  if (profileExists) warnings.push(`profile 目录已存在：--from-default-profile 会用 web 模板覆盖它（只对一次性 UAT profile 执行）`);
  for (const artifact of artifacts) {
    if (!artifact.exists) warnings.push(`产物不存在：${artifact.path}（先构建对应 tarball，或修正 --tarball）`);
  }

  const install = artifacts.map((artifact) => `dsh plugin --profile ${profile} add ${artifact.path}`);
  const remove = [
    `node scripts/uninstall-devops.mjs --profile ${profile}`,
    `dsh plugin --profile ${profile} remove @heluo/forge-gitee`,
    `dsh plugin --profile ${profile} remove @heluo/forge-devops`,
  ];
  if (tarball !== undefined) remove.push(`dsh plugin --profile ${profile} remove @heluo/forge-enterprise`);

  return {
    profile,
    profileDir: dir,
    profileExists,
    patchLayer: patchLayerState(patchLayerPath),
    artifacts,
    port,
    commands: {
      createProfile: `dsh --profile ${profile} --from-default-profile web --dump-config`,
      install,
      dumpConfig: `dsh --profile ${profile} --dump-config`,
      launch: `dsh --profile ${profile} --host 127.0.0.1 --port ${port} --no-open`,
      rollback: {
        patchLayer: {
          file: patchLayerPath,
          instruction: `先清补丁层：删除 ${patchLayerPath} 中所有 \`- insert:\` 块（id: forge-devops / heluo-gitee / heluo-iam），否则冷启动会报 entry not found`,
        },
        commands: remove,
        verify: {
          command: `dsh --profile ${profile} --dump-config`,
          expect: [
            'dsh.profile.bundles 不含 @heluo/*',
            'dependencies 为空（pnpm remove 已清）',
            `${PATCH_LAYER_FILE} 无 \`- insert:\``,
          ],
        },
      },
    },
    expect: {
      entries: [...UAT_ENTRIES],
      packages: [...UAT_PACKAGES],
      sections: UAT_SECTIONS.map((section) => ({ ...section })),
    },
    warnings,
  };
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 分区 id 必须是独立词：`devops` 不能命中 `devops-readiness` 或 `@heluo/forge-devops`。 */
function hasToken(text, token) {
  return new RegExp(`(?<![\\w-])${escapeRegExp(token)}(?![\\w-])`).test(text);
}

function sectionMatches(text, section) {
  if (!text.includes(section.owner)) return false;
  if (!hasToken(text, section.id)) return false;
  const order = text.match(/\border\s*[=:]\s*(\d+)/);
  return order === null || Number(order[1]) === section.order;
}

/**
 * 一条注册证据：`settings.section` 与分区 id、属主包名出现在同一行，
 * 或出现在同一段缩进续行里（如 `[slots] register settings.section` 后跟 id/plugin）。
 * 空行或非缩进行结束这一段——相邻的无关日志不会被拼成证据。
 */
function registrationEvidence(body, section) {
  const lines = body.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes('settings.section')) continue;
    if (sectionMatches(lines[index], section)) return lines[index].trim();
    const block = [lines[index]];
    for (let next = index + 1; next < lines.length && lines[next].trim() !== '' && /^\s+/.test(lines[next]); next += 1) {
      block.push(lines[next]);
    }
    if (block.length > 1 && sectionMatches(block.join('\n'), section)) return block.join('\n').trim();
  }
  return null;
}

/**
 * 核对一份安装日志（`--dump-config` 输出 + 启动日志的拼接）。
 * @param {string} text
 * @returns {{ok: boolean, missing: string[], failures: string[], present: string[], sections: Array<{id:string,order:number,owner:string,evidence:string|null}>}}
 */
export function verifyLog(text) {
  const body = String(text);
  const present = [];
  const missing = [];
  for (const entry of UAT_ENTRIES) {
    if (body.includes(`id: ${entry}`)) present.push(`id: ${entry}`);
    else missing.push(`dump-config 缺少条目 id: ${entry}`);
  }
  for (const name of UAT_PACKAGES) {
    if (body.includes(name)) present.push(name);
    else missing.push(`dump-config 缺少包 ${name}`);
  }
  const sections = UAT_SECTIONS.map((section) => ({ ...section, evidence: registrationEvidence(body, section) }));
  for (const section of sections) {
    if (section.evidence === null) {
      missing.push(
        `日志里没有分区 ${section.id}（order ${section.order}）的挂载证据：` +
          `需要 settings.section 注册日志同时出现分区 id 与 ${section.owner}`,
      );
    } else {
      present.push(`settings.section:${section.id}`);
    }
  }
  const failures = [];
  const lower = body.toLowerCase();
  for (const marker of FAILURE_MARKERS) {
    if (lower.includes(marker.toLowerCase())) failures.push(`日志含失败信号：${marker}`);
  }
  return { ok: missing.length === 0 && failures.length === 0, missing, failures, present, sections };
}

/**
 * @param {string[]} argv 不含 node 与脚本路径
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<number>} 退出码
 */
export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
    console.log(USAGE);
    return argv.length === 0 ? 2 : 0;
  }
  const profile = argValue(argv, '--profile') ?? DEFAULT_PROFILE;
  if (argv.includes('--plan')) {
    const portArg = argValue(argv, '--port');
    const port = portArg === undefined ? DEFAULT_PORT : Number(portArg);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error(`--port 需要 1-65535 的整数，收到「${portArg}」`);
      return 2;
    }
    const plan = planUat({ profile, port, tarball: argValue(argv, '--tarball'), env });
    console.log(JSON.stringify(plan, null, 2));
    for (const warning of plan.warnings) console.error(`注意：${warning}`);
    return 0;
  }
  if (argv.includes('--verify')) {
    const file = argValue(argv, '--verify');
    if (file === undefined) {
      console.error('--verify 需要一个日志文件路径');
      return 2;
    }
    if (!existsSync(file)) {
      console.error(`日志不存在：${file}`);
      return 1;
    }
    const result = verifyLog(readFileSync(file, 'utf8'));
    console.log(JSON.stringify({ profile, file: basename(file), ...result }, null, 2));
    for (const message of [...result.missing, ...result.failures]) console.error(`未通过：${message}`);
    return result.ok ? 0 : 1;
  }
  console.error(USAGE);
  return 2;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
