/** Skill Manager deployment rules shared by the maker and delivery preflight. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const NACOS_RUNTIME_FILE = 'packages/forge-skills-manager/lib/nacos.js';
export const NACOS_PACKAGING_GUIDE = 'packages/forge-skills-manager/docs/packaging.md';
export const NACOS_ENV_MAP = Object.freeze({
  HELUO_NACOS_SERVER_URL: 'serverUrl',
  HELUO_NACOS_NAMESPACE_ID: 'namespaceId',
  HELUO_NACOS_USERNAME: 'username',
  HELUO_NACOS_PASSWORD: 'password',
  HELUO_NACOS_TIMEOUT_MS: 'timeoutMs',
});

export function parseNacosConfig(byKey, problems) {
  const nacos = {};
  for (const [key, field] of Object.entries(NACOS_ENV_MAP)) {
    const raw = byKey.get(key);
    if (raw === undefined) continue;
    if (field === 'timeoutMs') {
      if (!/^\d+$/u.test(raw) || Number(raw) < 100 || Number(raw) > 120000) problems.push(`${key} must be an integer between 100 and 120000`);
      else nacos[field] = Number(raw);
    } else {
      nacos[field] = raw;
      if (field === 'namespaceId' && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(raw)) problems.push(`${key} must be a valid namespace ID of 1 to 128 characters`);
      if ((field === 'username' || field === 'password') && !raw.trim()) problems.push(`${key} must be non-empty`);
    }
  }
  if (Object.keys(nacos).length > 0) {
    let valid = false;
    try {
      const url = new URL(nacos.serverUrl);
      valid = ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
    } catch (error) {
      if (!(error instanceof TypeError && error.code === 'ERR_INVALID_URL')) throw error;
    }
    if (!valid) problems.push('HELUO_NACOS_SERVER_URL is required and must be an http or https URL without userinfo/query/hash');
  }
  return nacos;
}

export function assertNacosReleaseConfig(config, fail) {
  const missing = Object.entries(NACOS_ENV_MAP)
    .filter(([, field]) => field !== 'timeoutMs')
    .filter(([, field]) => typeof config.nacos?.[field] !== 'string' || !config.nacos[field].trim())
    .map(([key]) => key);
  if (missing.length > 0) fail('CONFIG_INVALID', `formal release requires ${missing.join(', ')}`);
}

/** No runtime code from the downloaded artifact is executed by the maker. */
export function checkNacosRelease(entries, config, { installed, fail, toolRoot } = {}) {
  if (!installed) {
    if (Object.keys(config.nacos ?? {}).length > 0) {
      fail('PUBLIC_TARBALL_INVALID', 'public tarball does not declare the Skill Manager insert row required by Nacos configuration');
    }
    return { nacosConfigured: false, embeddedSecrets: [], secretEmbedded: false };
  }
  assertNacosReleaseConfig(config, fail);
  const runtime = entries.find(entry => entry.path === 'node_modules/@heluo/forge-skills-manager/lib/nacos.js');
  const path = toolRoot === undefined ? new URL(`../../${NACOS_RUNTIME_FILE}`, import.meta.url) : join(toolRoot, NACOS_RUNTIME_FILE);
  let expected;
  try { expected = readFileSync(path); }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EISDIR'].includes(error.code)) throw error;
    fail('NACOS_RUNTIME_MISMATCH', 'Nacos runtime is unavailable in this toolchain; use the toolchain paired with the public release');
  }
  const normalize = content => Buffer.from(content.toString('latin1').replace(/\r\n/gu, '\n'), 'latin1');
  if (!runtime?.content || !normalize(expected).equals(normalize(runtime.content))) {
    fail('NACOS_RUNTIME_MISMATCH', 'Nacos runtime differs from the public bundle; use the toolchain paired with the public release');
  }
  return { nacosConfigured: true, embeddedSecrets: ['nacos.password'], secretEmbedded: true };
}
