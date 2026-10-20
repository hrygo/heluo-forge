const SCOPE = /^(@[a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)$/;

export function parsePackageName(name) {
  const match = SCOPE.exec(String(name ?? ''));
  if (!match) return null;
  return { scope: match[1], name: match[2] };
}

export function checkInstall(request, policy) {
  const parsed = parsePackageName(request?.name);
  if (!parsed) return { allowed: false, reason: 'invalid-name' };
  if (!policy?.registryUrl) return { allowed: false, reason: 'no-registry' };

  const allowedScopes = policy.allowedScopes ?? [];
  if (!allowedScopes.includes(parsed.scope)) return { allowed: false, reason: 'scope-not-allowed' };

  if (request.prerelease && !policy.allowPrerelease) return { allowed: false, reason: 'prerelease-blocked' };
  if (request.hasInstallScript && !policy.allowInstallScripts) return { allowed: false, reason: 'install-script-blocked' };

  const pinned = policy.pinned?.[request.name];
  if (pinned && pinned !== request.version) return { allowed: false, reason: 'version-pinned' };

  return { allowed: true, reason: null };
}

// 预发布后缀（-rc.2）按基础版本比较：运行时常在 rc 通道上，
// 拒绝解析会让所有插件在 rc 运行时被判成不兼容。
const RANGE = /^(>=|>|\^|~|=)?\s*v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseEngines(text) {
  const match = RANGE.exec(String(text ?? '').trim());
  if (!match) return null;
  return { op: match[1] || '=', major: Number(match[2]), minor: Number(match[3]), patch: Number(match[4]) };
}

function compare(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

export function satisfiesRange(range, version) {
  const order = compare(version, range);
  switch (range.op) {
    case '>=':
      return order >= 0;
    case '>':
      return order > 0;
    case '=':
      return order === 0;
    case '^': {
      if (order < 0) return false;
      return range.major > 0 ? version.major === range.major : version.minor === range.minor;
    }
    case '~':
      return order >= 0 && version.major === range.major && version.minor === range.minor;
    default:
      return false;
  }
}

export function checkEngines(declared, dshVersion) {
  if (!declared) return { compatible: false, reason: 'missing-engines' };
  const range = parseEngines(declared);
  const actual = parseEngines(String(dshVersion ?? '').replace(/^v/, ''));
  if (!range || !actual) return { compatible: false, reason: 'unparsable' };
  if (range.op === '>=' || range.op === '>' || range.op === '=') {
    return satisfiesRange(range, actual)
      ? { compatible: true, reason: null }
      : { compatible: false, reason: 'requires-newer-dsh' };
  }
  return satisfiesRange(range, actual)
    ? { compatible: true, reason: null }
    : { compatible: false, reason: 'outside-range' };
}
