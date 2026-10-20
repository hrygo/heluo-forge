const REQUIRED_FILES = ['cordis.patch.yml', 'package.json', 'README.md'];
const PROTECTED_IDS = ['forge-iam', 'forge-policy', 'dsh-credentials', 'dsh-sandbox-policy', 'dsh-permission-presets'];
const REQUIRED_SECTIONS = ['## 用途', '## 维护人'];
const SEMVER_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
import { parseEngines } from './policy.mjs';

// 匹配 `key: value` 的任意 YAML 书写风格：块式、流式、键序不同都命中。
// 宁可对可疑写法误报，也不能让受保护行换个写法就绕过。
function scalar(key, value) {
  return new RegExp(`(?:^|[\\s,\\[{])${key}\\s*:\\s*['\"]?${value}['\"]?(?=\\s|$|[,}\\]])`, 'm');
}

export function validatePatch(text) {
  const errors = [];
  const body = String(text ?? '');
  if (/!!js/.test(body)) errors.push({ code: 'patch-js-expr' });
  if (scalar('disabled', 'true').test(body)) errors.push({ code: 'patch-disables-row' });
  if (/cordis:include/.test(body)) errors.push({ code: 'patch-include' });
  // 同时接受 / 与 \\ 两种分隔符：Windows 风格写法不能成为绕过口。
  // 盘符必须在行首或空白之后：否则 "https:/" 里的 "s:/" 会被误判成 Windows 路径。
  if (/(^|[\s'\"])\.\.?[/\\]/.test(body) || /(^|[\s'\"])[A-Za-z]:[/\\]/.test(body)) errors.push({ code: 'patch-unsafe-path' });
  for (const id of PROTECTED_IDS) {
    if (scalar('id', id).test(body)) errors.push({ code: 'patch-overrides-protected', detail: id });
  }
  return errors;
}

// 只挑形如 @scope/name 的行名，避免把 config 里的普通 name 字段当插件名。
export function patchPluginNames(text) {
  return [...String(text ?? '').matchAll(/name\s*:\s*['"]?(@[\w.-]+\/[\w.-]+)['"]?/g)].map((match) => match[1]);
}

// loader 允许 insert 行用相对路径指向 patch 旁边的文件；既然要写进白名单，
// 就得确认目标确实在归档里，否则挂载时会找不到模块。
export function patchRelativeTargets(text) {
  return [...String(text ?? '').matchAll(/name\s*:\s*['"]?(\.\/[^'"\s]+)['"]?/g)].map((match) => match[1]);
}

export function validatePlugin(input, policy = {}) {
  const errors = [];
  const files = new Set(input?.files ?? []);
  const manifest = input?.manifest ?? {};
  const readme = String(input?.readme ?? '');
  const tag = String(input?.tag ?? '');

  for (const file of REQUIRED_FILES) {
    if (files.has(file)) continue;
    // "缺 README.md" 最常见的真实原因是它放在了 docs/ 下；直接指出来，别让人猜。
    const misplaced = [...files].filter((path) => path.endsWith(`/${file}`));
    errors.push({
      code: 'missing-file',
      detail: file,
      hint: misplaced.length
        ? `found ${misplaced.join(', ')}; ${file} must be at the repository root`
        : `${file} must be at the repository root`,
    });
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
  else if (!parseEngines(engines)) errors.push({ code: 'bad-engines', detail: engines });

  for (const field of ['install', 'postinstall', 'preinstall']) {
    if (manifest.scripts?.[field]) errors.push({ code: 'install-script', detail: field });
  }

  for (const section of REQUIRED_SECTIONS) {
    if (!readme.includes(section)) errors.push({ code: 'missing-section', detail: section });
  }

  if (input?.patch && name) {
    const declared = patchPluginNames(input.patch);
    if (declared.length && !declared.includes(name)) {
      errors.push({ code: 'patch-name-mismatch', detail: declared });
    }
    for (const target of patchRelativeTargets(input.patch)) {
      const path = target.slice(2);
      if (!files.has(path)) errors.push({ code: 'patch-missing-target', detail: target });
    }
  }

  errors.push(...validatePatch(input?.patch));

  return { ok: errors.length === 0, errors };
}
