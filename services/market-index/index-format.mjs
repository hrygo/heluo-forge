// 原生 format-1 索引的校验与构造（DESIGN-012 §3–§7）。
// 依据 2026-10-21 对 DSH 随包 @deepseek-ai/dsh-plugin-market-index 的只读核对：
// 官方解析器对未定义成员是"丢弃"而不是报错，因此企业产物只能写它真正定义的字段。

const LANGUAGE = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/u;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
const NUMERIC = '(?:0|[1-9]\\d*)';
const PRE = `(?:${NUMERIC}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`;
const SEMVER = new RegExp(`^${NUMERIC}\\.${NUMERIC}\\.${NUMERIC}(?:-${PRE}(?:\\.${PRE})*)?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`, 'u');
const COMMIT = /^[0-9a-f]{40}$/u;
const PATH_SEGMENT = /^[A-Za-z0-9._@+-]+$/u;
const DATA_ICON = /^data:(?:image\/svg\+xml|image\/png|image\/jpeg|image\/webp);base64,([A-Za-z0-9+/]*={0,2})$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const MAX_PUBLISH_TIMESTAMP = 1e11;
const MAX_ICON_BYTES = 32 * 1024;

export class IndexFormatError extends Error {
  constructor(path, reason) {
    super(`${path} ${reason}`);
    this.path = path;
    this.reason = reason;
    this.name = 'IndexFormatError';
  }
}

const fail = (path, reason) => {
  throw new IndexFormatError(path, reason);
};
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim() !== '';
const own = (record, key, value) => Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });

function objectAt(value, path) {
  if (!isRecord(value)) fail(path, 'must be an object');
  return value;
}

function stringAt(value, path) {
  if (!text(value)) fail(path, 'must be a non-empty string');
  return value;
}

function optional(object, key, path, read) {
  return Object.hasOwn(object, key) ? read(object[key], `${path}.${key}`) : undefined;
}

function localizedText(value, path) {
  if (typeof value === 'string') return stringAt(value, path);
  const object = objectAt(value, path);
  const result = {};
  for (const [language, member] of Object.entries(object)) {
    if (!LANGUAGE.test(language)) fail(`${path}.${language}`, 'must be keyed by a lowercase language id');
    own(result, language, stringAt(member, `${path}.${language}`));
  }
  if (!Object.hasOwn(result, 'en')) fail(path, 'must contain en');
  return result;
}

function declarations(value, path, read) {
  const result = {};
  for (const [id, member] of Object.entries(objectAt(value, path))) {
    if (id === '') fail(path, 'must not declare an empty id');
    own(result, id, read(objectAt(member, `${path}.${id}`), `${path}.${id}`));
  }
  return result;
}

function declaredId(value, path, declared) {
  const id = stringAt(value, path);
  if (!Object.hasOwn(declared, id)) fail(path, `references undeclared id ${JSON.stringify(id)}`);
  return id;
}

function indexMetadata(value, path) {
  const object = value === undefined ? {} : objectAt(value, path);
  return {
    categories: optional(object, 'categories', path, (member, at) => declarations(member, at, (entry, where) => ({ title: localizedText(entry.title, `${where}.title`) }))) ?? {},
    labels: optional(object, 'labels', path, (member, at) => declarations(member, at, (entry, where) => ({ title: localizedText(entry.title, `${where}.title`) }))) ?? {},
    sortKeys: optional(object, 'sortKeys', path, (member, at) => declarations(member, at, (entry, where) => {
      if (entry.order !== 'asc' && entry.order !== 'desc') fail(`${where}.order`, 'must be asc or desc');
      return { title: localizedText(entry.title, `${where}.title`), order: entry.order };
    })) ?? {},
  };
}

function pluginMetadata(value, path, index) {
  const object = value === undefined ? {} : objectAt(value, path);
  const category = optional(object, 'category', path, (member, at) => declaredId(member, at, index.categories));
  const keywords = optional(object, 'keywords', path, (member, at) => {
    if (!Array.isArray(member)) fail(at, 'must be an array');
    return member.map((keyword, position) => {
      if (typeof keyword !== 'string') fail(`${at}[${position}]`, 'must be a string');
      return keyword;
    });
  }) ?? [];
  const labels = optional(object, 'labels', path, (member, at) => {
    if (!Array.isArray(member)) fail(at, 'must be an array');
    const ids = member.map((label, position) => declaredId(label, `${at}[${position}]`, index.labels));
    if (new Set(ids).size !== ids.length) fail(at, 'must not repeat a label');
    return ids;
  }) ?? [];
  const sortKeys = optional(object, 'sortKeys', path, (member, at) => {
    const values = {};
    for (const [id, raw] of Object.entries(objectAt(member, at))) {
      declaredId(id, `${at}.${id}`, index.sortKeys);
      if (typeof raw !== 'string' || raw.trim() === '') fail(`${at}.${id}`, 'must be a non-empty string');
      own(values, id, raw);
    }
    return values;
  }) ?? {};
  return {
    ...(category === undefined ? {} : { category }),
    keywords,
    labels,
    sortKeys,
  };
}

function httpsUrl(value, path) {
  if (!text(value)) fail(path, 'must be a non-empty string');
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(path, 'must be an absolute URL');
  }
  if (url.protocol !== 'https:') fail(path, 'must use https:');
  return url.href;
}

function registryUrl(value, path) {
  if (!text(value)) fail(path, 'must be a non-empty string');
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(path, 'must be an absolute URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail(path, 'must use http: or https:');
  if (url.username || url.password || url.search || url.hash) fail(path, 'must not carry credentials, query or fragment');
  return url.href;
}

function packagePath(value, path) {
  const textValue = stringAt(value, path);
  if (textValue.split('/').some((segment) => segment === '.' || segment === '..' || !PATH_SEGMENT.test(segment))) {
    fail(path, 'must be a relative directory without . or ..');
  }
  return textValue;
}

function repository(value, path) {
  const object = objectAt(value, path);
  const url = httpsUrl(object.url, `${path}.url`);
  const directory = optional(object, 'directory', path, packagePath);
  return { url, ...(directory === undefined ? {} : { directory }) };
}

function source(value, path, { allowGit = false } = {}) {
  const object = objectAt(value, path);
  if (object.type === 'npm') {
    const registry = optional(object, 'registry', path, (member, at) => registryUrl(member, at));
    return { type: 'npm', ...(registry === undefined ? {} : { registry }) };
  }
  if (object.type === 'git' && allowGit) {
    const commit = stringAt(object.commit, `${path}.commit`);
    if (!COMMIT.test(commit)) fail(`${path}.commit`, 'must be a lowercase 40-hex commit');
    const url = httpsUrl(object.url, `${path}.url`);
    if (!/^(?:\/[^/]+){2,}$/u.test(new URL(url).pathname)) fail(`${path}.url`, 'must name a repository');
    const packageDir = optional(object, 'path', path, packagePath);
    return { type: 'git', url, commit, ...(packageDir === undefined ? {} : { path: packageDir }) };
  }
  fail(`${path}.type`, allowGit ? 'must be npm or git' : 'must be npm');
}

function isSemverRange(value) {
  if (value === '*') return true;
  if (value.startsWith('workspace:') || value.includes('||')) return false;
  return value.trim().split(/\s+/).every((token) => /^(?:\^|~|>=|<=|>|<|=)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(token));
}

function engines(value, path) {
  const object = objectAt(value, path);
  const dsh = optional(object, 'dsh', path, (member, at) => {
    const range = stringAt(member, at);
    if (!isSemverRange(range)) fail(at, 'must be a SemVer range');
    return range;
  });
  return dsh === undefined ? {} : { dsh };
}

function icon(value, path, indexUrl) {
  const raw = stringAt(value, path);
  if (raw.startsWith('data:')) {
    const payload = DATA_ICON.exec(raw)?.[1];
    if (payload === undefined || payload === '' || !BASE64.test(payload)) fail(path, 'must be a base64 SVG/PNG/JPEG/WebP data URL');
    const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
    if ((payload.length / 4) * 3 - padding > MAX_ICON_BYTES) fail(path, 'must not exceed 32 KiB decoded');
    return raw;
  }
  let resolved;
  try {
    resolved = new URL(raw, indexUrl);
  } catch {
    fail(path, 'must be a URL reference');
  }
  if (resolved.protocol !== 'https:') fail(path, 'must use https:');
  return resolved.href;
}

function marketVersion(value, path, options) {
  const object = objectAt(value, path);
  const version = stringAt(object.version, `${path}.version`);
  if (!SEMVER.test(version)) fail(`${path}.version`, 'must be an exact SemVer version');
  const publishTimestamp = object.publishTimestamp;
  if (!Number.isInteger(publishTimestamp) || publishTimestamp < 0 || publishTimestamp >= MAX_PUBLISH_TIMESTAMP) {
    fail(`${path}.publishTimestamp`, 'must be integer Unix seconds in [0, 10^11)');
  }
  return {
    version,
    publishTimestamp,
    source: source(object.source, `${path}.source`, options),
    engines: optional(object, 'engines', path, engines) ?? {},
  };
}

function parseSemver(version) {
  const [core, pre] = version.split('+')[0].split('-');
  return { core: core.split('.').map(Number), pre: pre === undefined ? null : pre.split('.') };
}

function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] - right.core[index];
  }
  if (left.pre === null && right.pre === null) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    if (left.pre[index] === undefined) return -1;
    if (right.pre[index] === undefined) return 1;
    const leftNumeric = /^\d+$/u.test(left.pre[index]);
    const rightNumeric = /^\d+$/u.test(right.pre[index]);
    if (leftNumeric && rightNumeric && Number(left.pre[index]) !== Number(right.pre[index])) return Number(left.pre[index]) - Number(right.pre[index]);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    if (left.pre[index] !== right.pre[index]) return left.pre[index] < right.pre[index] ? -1 : 1;
  }
  return 0;
}

function versions(value, path, options) {
  if (!Array.isArray(value) || value.length === 0) fail(path, 'must be a non-empty array');
  const seen = new Set();
  return value
    .map((member, position) => {
      const at = `${path}[${position}]`;
      const entry = marketVersion(member, at, options);
      if (seen.has(entry.version)) fail(`${at}.version`, `duplicates ${entry.version}`);
      seen.add(entry.version);
      return entry;
    })
    .sort((left, right) => compareSemver(right.version, left.version));
}

function plugin(value, path, index, indexUrl, options) {
  const object = objectAt(value, path);
  const name = stringAt(object.name, `${path}.name`);
  if (name.length > 214 || !PACKAGE_NAME.test(name)) fail(`${path}.name`, 'must be a valid npm package name');
  const title = optional(object, 'title', path, localizedText);
  const description = optional(object, 'description', path, localizedText);
  const iconUrl = optional(object, 'icon', path, (member, at) => icon(member, at, indexUrl));
  const author = optional(object, 'author', path, (member, at) => stringAt(member, at));
  const homepage = optional(object, 'homepage', path, (member, at) => httpsUrl(member, at));
  const repo = optional(object, 'repository', path, repository);
  return {
    name,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(iconUrl === undefined ? {} : { icon: iconUrl }),
    ...(author === undefined ? {} : { author }),
    ...(homepage === undefined ? {} : { homepage }),
    ...(repo === undefined ? {} : { repository: repo }),
    metadata: pluginMetadata(object.metadata, `${path}.metadata`, index),
    versions: versions(object.versions, `${path}.versions`, options),
  };
}

/**
 * 校验 format-1 文档。未定义成员按官方行为丢弃；返回规范化结果，版本按 SemVer 降序。
 */
export function parseMarketIndex(value, indexUrl, options = {}) {
  if (!text(indexUrl)) fail('$', 'index URL must be an absolute URL');
  let base;
  try {
    base = new URL(indexUrl);
  } catch {
    fail('$', 'index URL must be an absolute URL');
  }
  const object = objectAt(value, '$');
  if (object.format !== 1) fail('$.format', 'must be 1');
  const metadata = indexMetadata(object.metadata, '$.metadata');
  if (!Array.isArray(object.plugins)) fail('$.plugins', 'must be an array');
  const names = new Set();
  const plugins = object.plugins.map((entry, position) => {
    const parsed = plugin(entry, `$.plugins[${position}]`, metadata, base, options);
    if (names.has(parsed.name)) fail(`$.plugins[${position}].name`, `duplicates ${parsed.name}`);
    names.add(parsed.name);
    return parsed;
  });
  const title = localizedText(object.title, '$.title');
  const description = optional(object, 'description', '$', localizedText);
  return {
    format: 1,
    title,
    ...(description === undefined ? {} : { description }),
    metadata,
    plugins,
  };
}

/**
 * 生成并自校验一份企业索引。只输出 npm source；相对 icon 基于 indexUrl 解析。
 */
export function buildMarketIndex({ title, description, metadata = {}, plugins, indexUrl }) {
  const index = {
    format: 1,
    title,
    ...(description === undefined ? {} : { description }),
    metadata,
    plugins,
  };
  return parseMarketIndex(index, indexUrl);
}

/** 精确版本的安装目标；企业索引只接受 npm source。 */
export function installTarget(plugin, version) {
  if (version.source?.type !== 'npm') throw new IndexFormatError('$.source.type', 'must be npm');
  return {
    spec: `${plugin.name}@${version.version}`,
    ...(version.source.registry === undefined ? {} : { registry: version.source.registry }),
  };
}