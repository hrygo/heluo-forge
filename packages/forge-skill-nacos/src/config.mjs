/**
 * 插件配置校验与默认值（设计 §5.2）。
 *
 * 必填缺失、类型不符或数值越界都在加载时拒绝（fail loud）；`caFile` 在
 * 自定义 CA 通道核验前显式不支持（P0 项），配置出现即拒绝。
 */
import { REASONS, SkillNacosError } from './errors.mjs';

export const CATALOG_MODES = Object.freeze(['console-list', 'client-search', 'config-index']);

export const DEFAULT_CONFIG = Object.freeze({
  catalogMode: 'console-list',
  requestTimeoutMs: 10000,
  catalogRefreshIntervalMs: 300000,
  catalogCacheTtlMs: 300000,
  catalogPageSize: 100,
  pollMaxBackoffMs: 60000,
  pollJitterMs: 5000,
  maxUncompressedBytes: 20971520,
  maxFileCount: 512,
  downloadMaxBytes: 33554432,
  installStoreQuotaBytes: 268435456,
  providerName: 'nacos',
  environments: [],
});

const REQUIRED_STRINGS = Object.freeze(['endpoint', 'namespaceId', 'credentialRecordId']);

/** 有 environments 配置时，连接三件套从环境对象取，顶层不再必填。 */
function hasEnvironments(input) {
  return Array.isArray(input.environments) && input.environments.length > 0;
}
const OPTIONAL_URL_STRINGS = Object.freeze(['consoleEndpoint']);
const POSITIVE_INTEGERS = Object.freeze([
  'requestTimeoutMs',
  'catalogRefreshIntervalMs',
  'catalogCacheTtlMs',
  'catalogPageSize',
  'pollMaxBackoffMs',
  'pollJitterMs',
  'maxUncompressedBytes',
  'maxFileCount',
  'downloadMaxBytes',
  'installStoreQuotaBytes',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} input 原始插件 config
 * @returns {{value: object}} 校验通过的完整配置
 * @throws {SkillNacosError} REASONS.CONFIG_INVALID
 */
export function validateConfig(input = {}) {
  if (!isPlainObject(input)) {
    throw new SkillNacosError(REASONS.CONFIG_INVALID, 'skill-nacos 配置必须是对象');
  }
  if ('caFile' in input) {
    throw new SkillNacosError(
      REASONS.CONFIG_INVALID,
      'caFile 暂不支持：企业 CA 通道待宿主内核选项核验（P0 项），当前仅支持系统信任链',
    );
  }
  const issues = [];
  if (!hasEnvironments(input)) {
    for (const key of REQUIRED_STRINGS) {
      const value = input[key];
      if (typeof value !== 'string' || value.length === 0) {
        issues.push(`${key} 必须是非空字符串`);
      }
    }
  }
  const endpoint = typeof input.endpoint === 'string' ? input.endpoint : '';
  if (endpoint.length > 0 && !/^https?:\/\//.test(endpoint)) {
    issues.push('endpoint 必须是 http(s) URL');
  }
  for (const key of OPTIONAL_URL_STRINGS) {
    const value = input[key];
    if (value !== undefined && (typeof value !== 'string' || !/^https?:\/\//.test(value))) {
      issues.push(`${key} 必须是 http(s) URL`);
    }
  }
  if ('catalogMode' in input && !CATALOG_MODES.includes(input.catalogMode)) {
    issues.push(`catalogMode 必须是 ${CATALOG_MODES.join(' / ')} 之一`);
  }
  if (('catalogMode' in input ? input.catalogMode : DEFAULT_CONFIG.catalogMode) === 'config-index'
    && (typeof input.configIndexDataId !== 'string' || input.configIndexDataId.length === 0)) {
    issues.push('config-index 模式必须提供 configIndexDataId');
  }
  const resolved = { ...DEFAULT_CONFIG, ...input };
  for (const key of POSITIVE_INTEGERS) {
    const value = resolved[key];
    if (!Number.isInteger(value) || value < 0) {
      issues.push(`${key} 必须是非负整数`);
    } else if (key !== 'catalogRefreshIntervalMs' && value < 1) {
      issues.push(`${key} 必须是正整数`);
    }
  }
  if (Array.isArray(input.environments)) {
    for (const env of input.environments) {
      if (typeof env?.id !== 'string' || env.id.length === 0) issues.push('environments[].id 必须是非空字符串');
      if (typeof env?.label !== 'string' || env.label.length === 0) issues.push(`environments[${env?.id ?? '?'}].label 必须是非空字符串`);
      if (typeof env?.endpoint !== 'string' || !/^https?:\/\//.test(env.endpoint)) issues.push(`environments[${env?.id ?? '?'}].endpoint 必须是 http(s) URL`);
      if (typeof env?.namespaceId !== 'string' || env.namespaceId.length === 0) issues.push(`environments[${env?.id ?? '?'}].namespaceId 必须是非空字符串`);
      if (typeof env?.credentialRecordId !== 'string' || env.credentialRecordId.length === 0) issues.push(`environments[${env?.id ?? '?'}].credentialRecordId 必须是非空字符串`);
    }
    const ids = input.environments.map((env) => env?.id);
    if (new Set(ids).size !== ids.length) issues.push('environments[].id 不得重复');
  }
  if (issues.length > 0) {
    throw new SkillNacosError(REASONS.CONFIG_INVALID, `skill-nacos 配置无效：${issues.join('；')}`, { issues });
  }
  return { value: resolved };
}
