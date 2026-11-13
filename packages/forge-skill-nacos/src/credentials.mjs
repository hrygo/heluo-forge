/**
 * Nacos 凭据解析（设计 §6）：凭据值只在这里出现，永不进入日志、错误细节与
 * 模型上下文；每操作重新解析，凭据服务或记录不可用一律 fail closed。
 *
 * 记录地址沿用 DSH 凭据记录的 `<owner>/<id>` 形态（owner 固定 `skill-nacos`）。
 * payload 形态（2026-10-29 实测收敛）：`{username, password}` 走 Nacos 登录换
 * accessToken（catalog 内缓存复用），或 `{token}` 直接提供 accessToken。
 */
import { REASONS, SkillNacosError } from './errors.mjs';

export const CREDENTIAL_OWNER = 'skill-nacos';

/**
 * @param {{get?: (key: string) => unknown}} ctx 宿主上下文
 * @param {string} credentialRecordId 配置声明的记录 id
 * @returns {() => Promise<{kind: 'password', username: string, password: string} | {kind: 'token', token: string}>}
 */
export function createCredentialReader(ctx, credentialRecordId) {
  return async () => {
    const credentials = typeof ctx?.get === 'function' ? ctx.get('credentials') : undefined;
    if (credentials === undefined || typeof credentials.readRecord !== 'function') {
      throw new SkillNacosError(REASONS.AUTH_MISSING, '凭据服务不可用（skill-nacos 保持未开放）');
    }
    let record;
    try {
      record = await credentials.readRecord(`${CREDENTIAL_OWNER}/${credentialRecordId}`);
    } catch (error) {
      throw new SkillNacosError(REASONS.AUTH_MISSING, '读取凭据记录失败（凭据服务保持未开放）', { error: String(error?.message ?? error) });
    }
    if (record === undefined || record === null) {
      throw new SkillNacosError(REASONS.AUTH_MISSING, `凭据记录未配置（${CREDENTIAL_OWNER}/${credentialRecordId}），请先在企业凭据面录入`);
    }
    return credentialOf(record);
  };
}

function credentialOf(record) {
  const payload = record?.payload;
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    if (typeof payload.token === 'string' && payload.token.length > 0) {
      return { kind: 'token', token: payload.token };
    }
    if (typeof payload.username === 'string' && payload.username.length > 0
      && typeof payload.password === 'string' && payload.password.length > 0) {
      return { kind: 'password', username: payload.username, password: payload.password };
    }
  }
  throw new SkillNacosError(REASONS.AUTH_MISSING, '凭据记录形态不受支持（期望 {username,password} 或 {token}）');
}
