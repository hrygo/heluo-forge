const REQUIRED_FILES = ['cordis.patch.yml', 'package.json', 'README.md'];
const PROTECTED_IDS = ['forge-iam', 'forge-policy', 'dsh-credentials', 'dsh-sandbox-policy', 'dsh-permission-presets'];
const REQUIRED_SECTIONS = ['## 用途', '## 维护人'];
const SEMVER_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const ENGINES = /^>=\s*(\d+)\.(\d+)\.(\d+)$/;

export function validatePatch(text) {
  const errors = [];
  const body = String(text ?? '');
  if (/!!js/.test(body)) errors.push({ code: 'patch-js-expr' });
  if (/^\s*disabled:\s*true\s*$/m.test(body)) errors.push({ code: 'patch-disables-row' });
  if (/cordis:include/.test(body)) errors.push({ code: 'patch-include' });
  if (/(^|[\s'\"])\.\.?\//.test(body) || /[A-Za-z]:\\\\/.test(body)) errors.push({ code: 'patch-unsafe-path' });
  for (const id of PROTECTED_IDS) {
    const re = new RegExp(`^\\s*-\\s*id:\\s*['\"]?${id}['\"]?\\s*$`, 'm');
    if (re.test(body)) errors.push({ code: 'patch-overrides-protected', detail: id });
  }
  return errors;
}

export function validatePlugin(input, policy = {}) {
  const errors = [];
  const files = new Set(input?.files ?? []);
  const manifest = input?.manifest ?? {};
  const readme = String(input?.readme ?? '');
  const tag = String(input?.tag ?? '');

  for (const file of REQUIRED_FILES) {
    if (!files.has(file)) errors.push({ code: 'missing-file', detail: file });
  }

  const name = String(manifest.name ?? '');
  const scopes = policy.allowedScopes ?? ['@heluo'];
  const scope = name.startsWith('@') ? name.slice(0, name.indexOf('/')) : '';
  if (!name) errors.push({ code: 'missing-name' });
  else if (!scope || !scopes.includes(scope)) errors.push({ code: 'scope-not-allowed', detail: name });

  const version = String(manifest.version ?? '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) errors.push({ code: 'bad-version', detail: version });
  if (version && tag && tag !== `v${version}`) errors.push({ code: 'tag-mismatch', detail: `${tag} vs ${version}` });
  if (tag && !SEMVER_TAG.test(tag)) errors.push({ code: 'bad-tag', detail: tag });

  const engines = String(manifest.engines?.dsh ?? '');
  if (!engines) errors.push({ code: 'missing-engines' });
  else if (!ENGINES.test(engines)) errors.push({ code: 'bad-engines', detail: engines });

  for (const field of ['install', 'postinstall', 'preinstall']) {
    if (manifest.scripts?.[field]) errors.push({ code: 'install-script', detail: field });
  }

  for (const section of REQUIRED_SECTIONS) {
    if (!readme.includes(section)) errors.push({ code: 'missing-section', detail: section });
  }

  errors.push(...validatePatch(input?.patch));

  return { ok: errors.length === 0, errors };
}
