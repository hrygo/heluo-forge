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

export function checkEngines(declared, dshVersion) {
  if (!declared) return { compatible: false, reason: 'missing-engines' };
  const min = /(\d+)\.(\d+)\.(\d+)/.exec(declared)?.slice(1);
  const actual = /(\d+)\.(\d+)\.(\d+)/.exec(String(dshVersion ?? ''))?.slice(1);
  if (!min || !actual) return { compatible: false, reason: 'unparsable' };
  const less = (a, b) => {
    for (let i = 0; i < 3; i += 1) {
      if (Number(a[i]) !== Number(b[i])) return Number(a[i]) < Number(b[i]);
    }
    return false;
  };
  return less(actual, min)
    ? { compatible: false, reason: 'requires-newer-dsh' }
    : { compatible: true, reason: null };
}
