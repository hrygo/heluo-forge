/**
 * DOP 工作台非敏感连接配置本地持久化存储（仅保存 apiBaseUrl / requestTimeoutMs）。
 *
 * 严格约束：
 *   1. 认证方式统一由企业账号（IAM）提供，绝不写入或持久化任何 token / secret / credentialRef / 分队字段；
 *   2. 仅覆盖可配置连接参数，读取前必须经过 validateConfig 严格校验。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { validateConfig } from './config.mjs';
import { ERROR_CODES, WorkbenchError } from './errors.mjs';

export const RUNTIME_CONFIG_KEYS = Object.freeze([
  'apiBaseUrl',
  'requestTimeoutMs',
]);

export function resolveDefaultRuntimeConfigPath() {
  const envPath = process.env.WORKBENCH_CONFIG_PATH?.trim();
  if (envPath) return envPath;
  const dshHome = process.env.DSH_HOME?.trim() || join(os.homedir(), '.dsh');
  return join(dshHome, 'forge-devops-workbench-config.json');
}

function pickRuntimeConfigFields(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const picked = {};
  for (const key of RUNTIME_CONFIG_KEYS) {
    if (key in raw && raw[key] !== undefined) {
      picked[key] = raw[key];
    }
  }
  return picked;
}

/**
 * 创建连接配置持久化存储。
 *
 * @param {{ filePath?: string }} [options]
 */
export function createRuntimeConfigStore(options = {}) {
  const filePath = options.filePath || resolveDefaultRuntimeConfigPath();

  function readOverride() {
    if (!existsSync(filePath)) return null;
    try {
      const text = readFileSync(filePath, 'utf8');
      if (text.trim() === '') return null;
      const parsed = JSON.parse(text);
      const picked = pickRuntimeConfigFields(parsed);
      if (Object.keys(picked).length === 0) return null;
      validateConfig(picked);
      return picked;
    } catch {
      return null;
    }
  }

  function writeOverride(patch) {
    const picked = pickRuntimeConfigFields(patch);
    const validated = validateConfig(picked);
    const toSave = {
      apiBaseUrl: validated.apiBaseUrl,
      requestTimeoutMs: validated.requestTimeoutMs,
    };
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, `${JSON.stringify(toSave, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      return toSave;
    } catch (err) {
      throw new WorkbenchError(ERROR_CODES.UNAVAILABLE, '保存连接配置失败', {
        upstream: 'runtime-config-store',
        retryable: true,
        cause: err,
      });
    }
  }

  function clearOverride() {
    try {
      if (existsSync(filePath)) rmSync(filePath, { force: true });
    } catch (err) {
      throw new WorkbenchError(ERROR_CODES.UNAVAILABLE, '恢复默认连接配置失败', {
        upstream: 'runtime-config-store',
        retryable: true,
        cause: err,
      });
    }
  }

  return Object.freeze({
    filePath,
    readOverride,
    writeOverride,
    clearOverride,
  });
}
