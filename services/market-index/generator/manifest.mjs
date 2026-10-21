// 管理员受控清单校验（DESIGN-012 §3.1）。
// 原则：整份输入要么全部有效，要么整份拒绝；不部分发布、不忽略未知字段。

const ROOT_FIELDS = new Set(['schemaVersion', 'registries', 'packages']);
const REGISTRY_FIELDS = new Set(['id', 'url']);
const PACKAGE_FIELDS = new Set(['name', 'registryId', 'origin']);
const ORIGINS = new Set(['public-mirror', 'internal']);
const SCHEMA_VERSION = 1;

// npm 包名：小写、可带一个 scope；不允许 *、版本、tag、range、URL、path。
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value, max = 2048) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/**
 * 把 registry 地址规范化为可比较的 canonical 值；不合法返回 null。
 * 规则：HTTPS、无凭据、无 query/fragment/空白、路径保留且以单个 / 结尾。
 */
export function canonicalizeRegistryUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null;
  if (/\s/.test(value)) return null;

  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.search || url.hash) return null;
  if (!url.hostname) return null;

  const path = url.pathname || '/';
  // 编码、空段与 // 都会让“同一路径”出现多种写法，直接拒绝而不是猜。
  if (path.includes('%') || path.includes('//')) return null;
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) return null;

  const normalizedPath = path.endsWith('/') ? path : `${path}/`;
  return `https://${url.host}${normalizedPath}`;
}

function collectUnknown(record, allowed, path, errors) {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) errors.push({ code: 'unknown-field', path: `${path}.${key}` });
  }
}

function validateRegistries(registries, errors) {
  const ids = new Set();
  const urls = new Map();
  const normalized = [];

  if (!Array.isArray(registries)) {
    errors.push({ code: 'registries-not-array', path: 'registries' });
    return { ids, normalized };
  }

  registries.forEach((entry, index) => {
    const path = `registries[${index}]`;
    if (!isRecord(entry)) {
      errors.push({ code: 'registry-not-object', path });
      return;
    }
    collectUnknown(entry, REGISTRY_FIELDS, path, errors);

    const id = entry.id;
    if (!nonEmptyString(id, 128) || /\s/.test(id)) {
      errors.push({ code: 'registry-id-invalid', path: `${path}.id` });
    } else if (ids.has(id)) {
      errors.push({ code: 'registry-id-duplicate', path: `${path}.id`, detail: id });
    }

    const canonical = canonicalizeRegistryUrl(entry.url);
    if (!canonical) {
      errors.push({ code: 'registry-url-invalid', path: `${path}.url` });
    } else if (urls.has(canonical)) {
      errors.push({
        code: 'registry-url-duplicate',
        path: `${path}.url`,
        detail: `${canonical} 与 ${urls.get(canonical)} 规范化后相同`,
      });
    } else if (nonEmptyString(id, 128)) {
      urls.set(canonical, id);
    }

    if (nonEmptyString(id, 128) && canonical) {
      ids.add(id);
      normalized.push({ id, url: canonical });
    }
  });

  return { ids, normalized };
}

function validatePackages(packages, registryIds, errors) {
  const names = new Set();
  const normalized = [];

  if (!Array.isArray(packages)) {
    errors.push({ code: 'packages-not-array', path: 'packages' });
    return normalized;
  }

  packages.forEach((entry, index) => {
    const path = `packages[${index}]`;
    if (!isRecord(entry)) {
      errors.push({ code: 'package-not-object', path });
      return;
    }
    collectUnknown(entry, PACKAGE_FIELDS, path, errors);

    const { name, registryId, origin } = entry;
    const nameOk =
      nonEmptyString(name, 214) &&
      name === name.toLowerCase() &&
      PACKAGE_NAME.test(name);
    if (!nameOk) {
      errors.push({ code: 'package-name-invalid', path: `${path}.name` });
    } else if (names.has(name)) {
      errors.push({ code: 'package-name-duplicate', path: `${path}.name`, detail: name });
    }

    if (!nonEmptyString(registryId, 128) || !registryIds.has(registryId)) {
      errors.push({ code: 'package-registry-unknown', path: `${path}.registryId`, detail: String(registryId) });
    }

    if (!ORIGINS.has(origin)) {
      errors.push({ code: 'package-origin-invalid', path: `${path}.origin` });
    }

    if (nameOk && registryIds.has(registryId) && ORIGINS.has(origin)) {
      names.add(name);
      normalized.push({ name, registryId, origin });
    }
  });

  return normalized;
}

/**
 * 校验并规范化受控清单。
 * 返回 { ok, errors, manifest? }；errors 项含 code/path，便于生成器诊断。
 */
export function validateManifest(input) {
  const errors = [];

  if (!isRecord(input)) {
    return { ok: false, errors: [{ code: 'manifest-not-object', path: '' }] };
  }
  collectUnknown(input, ROOT_FIELDS, '', errors);

  if (input.schemaVersion !== SCHEMA_VERSION) {
    errors.push({ code: 'schema-version-unsupported', path: 'schemaVersion', detail: String(input.schemaVersion) });
  }

  const { ids, normalized: registries } = validateRegistries(input.registries, errors);
  const packages = validatePackages(input.packages, ids, errors);

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    errors: [],
    manifest: { schemaVersion: SCHEMA_VERSION, registries, packages },
  };
}