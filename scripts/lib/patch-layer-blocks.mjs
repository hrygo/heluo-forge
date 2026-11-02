// profile 补丁层的「条目块」模型（20261102-r9 / M3 卸载清理）。
//
// 上游 `dsh plugin remove`（remove_bundle）只做依赖移除与重载，**不清理 profile 补丁层**：
// 配置页（dsh-config-editor）写进 `<profile>/cordis.patch.yml` 的 `- id: forge-devops`
// 行会留在原地，冷启动时宿主为它打印「entry not found」。所以卸载必须自己改这个文件。
//
// 三条约束决定这里只能做**按区间的文本删除**，不能 parse → dump 重写整个 YAML：
//   1. 注释、空行、条目顺序都是用户手写的数据（AC-12 / AC-15：逐字保留，字节 diff 只含被删区间）；
//   2. 同一文件里还有 `config:` 子树中的同名形态（如 llm 模型表的 `- id: deepseek-flash`），
//      整行正则扫 `id:` 会误删别人的配置（AC-15：只按**精确**条目 id/name 匹配，禁止前缀/正则模糊匹配）；
//   3. 条目身份只在**块内直接子行**（缩进为顶层缩进 + 2）判定，深层 `- id:` 永不参与。
//
// 归属：docs/teamflow/20261102-r9-runner-refresh-uninstall/TECHNICAL.md §5.1-§5.2。

import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

/** profile 补丁层的文件名；回显只用它，不打印绝对路径（AC-14）。 */
export const PATCH_LAYER_FILE = 'cordis.patch.yml';

/** 顶层条目的写法：`- <内容>`，缩进属于文件自身的层级（真实 profile 为 0）。 */
const DASH = /^([ \t]*)- (.*)$/u;

/** 卸载命令唯一的错误类型：消息里只出现 profile 名与补丁层文件名。 */
export class UninstallError extends Error {
  constructor(message, code = 'UNINSTALL_FAILED') {
    super(message);
    this.name = 'UninstallError';
    this.code = code;
  }
}

function indentOf(line) {
  return line.match(/^[ \t]*/u)[0].length;
}

/** 块判定只看单行文本：企业内网有人用 Windows 编辑器把补丁层存成 CRLF，不能因此一条都不认。 */
function stripCr(line) {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** 块与块之间的分隔：空行、顶格注释。删除条目时不吞并它们。 */
function isSeparator(line) {
  return line.trim().length === 0 || line.startsWith('#');
}

function unquote(raw) {
  const value = raw.trim();
  if (value.length === 0) return '';
  const quote = value[0];
  if ((quote === "'" || quote === '"') && value.length > 1 && value.endsWith(quote)) {
    return value.slice(1, -1);
  }
  return value.replace(/[ \t]+#.*$/u, '').trim();
}

/** 读一行里的 `key: value`（只用于 `id:` / `name:` 这类直接子行）。 */
function readEntryKey(content) {
  const match = content.match(/^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/u);
  if (match === null) return null;
  return { key: match[1], value: unquote(match[2]) };
}

function topIndentOf(lines) {
  let top = null;
  for (const line of lines) {
    const dash = line.match(DASH);
    if (dash === null) continue;
    if (top === null || dash[1].length < top) top = dash[1].length;
  }
  return top;
}

/**
 * 块内直接子行（缩进 = 块缩进 + 2）里的 `id:` / `name:`。
 * `config:` 子树的深层 `- id:`（llm 模型表）缩进更深，这里读不到，正是 AC-15 要的隔离。
 */
function identityOf(lines, start, top) {
  const fields = {};
  const dash = lines[start].match(DASH);
  const head = dash === null ? null : readEntryKey(dash[2]);
  if (head !== null && (head.key === 'id' || head.key === 'name')) fields[head.key] = head.value;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const next = line.match(DASH);
    if (next !== null && next[1].length <= top) break;
    if (isSeparator(line) || indentOf(line) !== top + 2) continue;
    const entry = readEntryKey(line.slice(top + 2));
    if (entry === null || (entry.key !== 'id' && entry.key !== 'name')) continue;
    if (fields[entry.key] === undefined) fields[entry.key] = entry.value;
  }
  return { id: fields.id, name: fields.name };
}

function lineCount(lines) {
  if (lines.length === 0) return 0;
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

function idSet(ids) {
  if (ids === undefined) return new Set();
  if (ids instanceof Set) return ids;
  if (Array.isArray(ids)) return new Set(ids);
  throw new UninstallError('uninstall: 匹配集合 ids 必须是 Set 或字符串数组', 'INVALID_MATCH_SET');
}

function matchesIdentity(block, wanted) {
  return (block.id !== undefined && wanted.has(block.id)) || (block.name !== undefined && wanted.has(block.name));
}

/**
 * 解析顶层条目块。
 *
 * - 顶层缩进 = 文件里 `- ` 行的最小缩进（真实 profile 为 0；若整份文件被缩进过也照样成立）；
 * - 块尾 = 下一个缩进 ≤ 块缩进的 `- ` 行或文件末，再回退掉尾部的空行与顶格注释；
 * - 身份只取块内直接子行（块缩进 + 2）的 `id:` / `name:` —— 与「行首 `- id:`」是同一层。
 */
export function parsePatchBlocks(text) {
  const lines = String(text).split('\n');
  const probe = lines.map(stripCr);
  const top = topIndentOf(probe);
  if (top === null) return { lines, blocks: [] };
  const starts = [];
  for (let index = 0; index < probe.length; index += 1) {
    const dash = probe[index].match(DASH);
    if (dash !== null && dash[1].length === top) starts.push(index);
  }
  const blocks = starts.map((start, position) => {
    const next = position + 1 < starts.length ? starts[position + 1] : probe.length;
    let end = next;
    while (end > start + 1 && isSeparator(probe[end - 1])) end -= 1;
    const { id, name } = identityOf(probe, start, top);
    return { id, name, start, end, indent: top };
  });
  return { lines, blocks };
}

/**
 * 删掉 id 或 name 精确命中 `ids` 的顶层条目块。
 *
 * 未命中时不改一个字节（`text` 与入参逐字相同），是否写盘由调用方决定：
 * 未命中不写盘，避免无谓的 mtime 变化与无意义的重载。
 */
export function removeEntryBlock(text, { ids } = {}) {
  const wanted = idSet(ids);
  const parsed = parsePatchBlocks(text);
  const lines = parsed.lines.slice();
  const before = lineCount(parsed.lines);
  const matched = parsed.blocks.filter((block) => matchesIdentity(block, wanted));
  for (let index = matched.length - 1; index >= 0; index -= 1) {
    const block = matched[index];
    lines.splice(block.start, block.end - block.start);
  }
  const removed = matched.map((block) => ({
    id: block.id,
    name: block.name,
    start: block.start,
    end: block.end,
    count: block.end - block.start,
  }));
  const deleted = removed.reduce((sum, entry) => sum + entry.count, 0);
  return { text: lines.join('\n'), removed, before, after: before - deleted };
}

/** 补丁层里还剩几条本插件的顶层条目（0 = 无残留，AC-13 的判据）。 */
export function countEntries(text, { ids } = {}) {
  const wanted = idSet(ids);
  return parsePatchBlocks(text).blocks.filter((block) => matchesIdentity(block, wanted)).length;
}

/**
 * 更深缩进里的同名条目：`- insert:` 块内的 `- id: forge-devops`（手动粘贴分发补丁层的形态）。
 *
 * 块模型刻意不碰深层条目（它可能与配置值无关，也可能属于嵌套插入列表），
 * 但也因此不能对用户谎称「无残留」——调用方据此提示手工处理，绝不静默通过。
 */
export function findResidualEntries(text, { ids } = {}) {
  const wanted = idSet(ids);
  const { lines } = parsePatchBlocks(text);
  const probe = lines.map(stripCr);
  const top = topIndentOf(probe);
  if (top === null) return [];
  const found = [];
  for (let index = 0; index < probe.length; index += 1) {
    const dash = probe[index].match(DASH);
    if (dash === null || dash[1].length <= top) continue;
    const entry = readEntryKey(dash[2]);
    if (entry === null || (entry.key !== 'id' && entry.key !== 'name')) continue;
    if (!wanted.has(entry.value)) continue;
    found.push({
      line: index + 1,
      id: entry.key === 'id' ? entry.value : null,
      name: entry.key === 'name' ? entry.value : null,
    });
  }
  return found;
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function availableProfiles(profilesDir) {
  try {
    return readdirSync(profilesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function candidatesHint(found) {
  return found.length > 0 ? `（可用：${found.join('、')}）` : '（profiles 目录下没有任何 profile）';
}

function profileByName(name, profilesDir) {
  const trimmed = String(name ?? '').trim();
  if (trimmed.length === 0) {
    throw new UninstallError('uninstall: --profile 需要一个 profile 名', 'PROFILE_UNRESOLVED');
  }
  if (trimmed === '.' || trimmed === '..' || /[\\/]/u.test(trimmed)) {
    throw new UninstallError(`uninstall: profile 名「${trimmed}」不合法`, 'PROFILE_UNRESOLVED');
  }
  const dir = join(profilesDir, trimmed);
  if (!isDirectory(dir)) {
    throw new UninstallError(`uninstall: 找不到 profile「${trimmed}」${candidatesHint(availableProfiles(profilesDir))}`, 'PROFILE_UNRESOLVED');
  }
  return { name: trimmed, dir };
}

function profileFromDir(rawDir) {
  const dir = resolve(String(rawDir).trim());
  const name = basename(dir);
  if (name.length === 0) {
    throw new UninstallError('uninstall: 无法从 DSH_PROFILE_DIR 推断 profile 名', 'PROFILE_UNRESOLVED');
  }
  if (!isDirectory(dir)) {
    throw new UninstallError(`uninstall: DSH_PROFILE_DIR 指向的 profile「${name}」目录不存在`, 'PROFILE_UNRESOLVED');
  }
  return { name, dir };
}

function profileArgOf(argv) {
  let found;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--profile') {
      found = argv[index + 1];
      if (found === undefined || found.startsWith('-')) {
        throw new UninstallError('uninstall: --profile 需要一个 profile 名', 'PROFILE_UNRESOLVED');
      }
    } else if (arg.startsWith('--profile=')) {
      found = arg.slice('--profile='.length);
    }
  }
  return found;
}

/**
 * 定位活动 profile（五分支，AC-11：不猜）。
 *
 * 顺序：`--profile <名>` → `DSH_PROFILE` → `DSH_PROFILE_DIR`（取 basename 作名）→
 * `$DSH_HOME/profiles/*` 恰好一个 → 报错并列出候选。
 * `$DSH_HOME` = `env.DSH_HOME || <home>/.dsh`。
 */
export function resolveProfile({ argv = [], env = process.env, home = homedir() } = {}) {
  const dshHome = env.DSH_HOME !== undefined && String(env.DSH_HOME).trim().length > 0
    ? resolve(String(env.DSH_HOME).trim())
    : join(home, '.dsh');
  const profilesDir = join(dshHome, 'profiles');

  const explicit = profileArgOf(argv);
  if (explicit !== undefined) return profileByName(explicit, profilesDir);

  if (env.DSH_PROFILE !== undefined && String(env.DSH_PROFILE).trim().length > 0) {
    return profileByName(env.DSH_PROFILE, profilesDir);
  }

  if (env.DSH_PROFILE_DIR !== undefined && String(env.DSH_PROFILE_DIR).trim().length > 0) {
    return profileFromDir(env.DSH_PROFILE_DIR);
  }

  const found = availableProfiles(profilesDir);
  if (found.length === 1) return { name: found[0], dir: join(profilesDir, found[0]) };
  if (found.length === 0) {
    throw new UninstallError('uninstall: 找不到 profile——请用 --profile <名> 指定（profiles 目录下没有任何 profile）', 'PROFILE_UNRESOLVED');
  }
  throw new UninstallError(`uninstall: 无法确定活动 profile${candidatesHint(found)}——请用 --profile <名> 指定`, 'PROFILE_UNRESOLVED');
}

/** 补丁层是否落在该 profile 里（不存在时命令报错退出，绝不创建，AC-12）。 */
export function patchLayerOf(profile) {
  return join(profile.dir, PATCH_LAYER_FILE);
}

/** 补丁层存在且是普通文件（目录同名也算不存在）。 */
export function patchLayerExists(profile) {
  try {
    return statSync(patchLayerOf(profile)).isFile();
  } catch {
    return false;
  }
}
