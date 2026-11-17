/**
 * 组织策略信封：包内 `policy/` 数据目录的读取、验签与单调合并。
 *
 * 签名证明"内容来自持钥签发流程且未被改动"，不证明规则本身正确，也不代替
 * IAM 与平台服务端权限。三态在装载期一次确定：`verified` 进入托管模式，
 * `absent` 是个人模式而不是失败，`invalid` 只降级写动作。
 */
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { classifyAction, defaultDecision, relaxes, strictestDecision } from './classify.mjs';
import { compileContentRules } from './content-rules.mjs';
import { PROCESS_RULES } from './process-rules.mjs';

export const ORG_ENVELOPE_SCHEMA = 'heluo.policy.org.v1';
export const ORG_POLICY_FILES = Object.freeze({
  envelope: 'org-policy.json',
  signature: 'org-policy.sig',
  publicKey: 'org-policy.pub',
});

const DECISIONS = new Set(['allow', 'confirm', 'deny']);
const SEVERITIES = new Set(['hard', 'soft']);
const ENVELOPE_KEYS = new Set(['schema', 'policy_version', 'issued_by', 'issued_at', 'caps', 'content_rules', 'process_rules']);
const PROCESS_KEYS = new Set(['require_durable_audit', ...Object.keys(PROCESS_RULES)]);

export class PolicyOrgError extends Error {
  constructor(message, code, details = undefined) {
    super(message);
    this.name = 'PolicyOrgError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim().length > 0;

/**
 * Deterministic serialization: object keys in lexical order, no whitespace,
 * UTF-8, array order preserved. The signature covers exactly these bytes.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/**
 * @param {unknown} envelope
 * @returns {string} hex SHA-256 of the canonical form
 */
export function envelopeDigest(envelope) {
  return createHash('sha256').update(canonicalJson(envelope), 'utf8').digest('hex');
}

function invalid(reason, details = undefined) {
  return Object.freeze({ state: 'invalid', reason, ...(details === undefined ? {} : { details }) });
}

function validateEnvelope(envelope) {
  if (!isRecord(envelope)) return 'the envelope must be an object';
  for (const key of Object.keys(envelope)) {
    if (!ENVELOPE_KEYS.has(key)) return `unknown envelope field "${key}"`;
  }
  if (envelope.schema !== ORG_ENVELOPE_SCHEMA) return `unsupported envelope schema "${envelope.schema}"`;
  if (!isText(envelope.policy_version)) return 'policy_version is required';
  if (!isText(envelope.issued_by)) return 'issued_by is required';
  if (!isText(envelope.issued_at) || Number.isNaN(Date.parse(envelope.issued_at))) return 'issued_at must be an ISO time';
  if (envelope.caps !== undefined && !isRecord(envelope.caps)) return 'caps must be an object';
  if (envelope.content_rules !== undefined && !Array.isArray(envelope.content_rules)) return 'content_rules must be an array';
  if (envelope.process_rules !== undefined && !isRecord(envelope.process_rules)) return 'process_rules must be an object';
  return undefined;
}

function validateCaps(caps = {}) {
  for (const [action, decision] of Object.entries(caps)) {
    const classified = classifyAction(action);
    if (classified === undefined) return `caps names unclassified action "${action}"`;
    if (!DECISIONS.has(decision)) return `caps.${action} must be allow, confirm or deny`;
    // 组织层只能收紧：把内置默认放宽会让"签名"变成绕过手段。
    if (relaxes(decision, defaultDecision(action))) {
      return `caps.${action} relaxes the builtin decision "${defaultDecision(action)}"`;
    }
  }
  return undefined;
}

function validateProcessRules(rules = {}) {
  for (const [key, value] of Object.entries(rules)) {
    if (!PROCESS_KEYS.has(key)) return `unknown process rule "${key}"`;
    if (key === 'require_durable_audit') {
      if (typeof value !== 'boolean') return 'process_rules.require_durable_audit must be a boolean';
      continue;
    }
    if (!SEVERITIES.has(value)) return `process_rules.${key} must be hard or soft`;
  }
  return undefined;
}

/**
 * Verify an envelope against its signature and the organization public key.
 *
 * @param {{envelope: unknown, signature: string, publicKeyPem: string}} input
 * @returns {object} verified envelope or an `invalid` result
 */
export function verifyEnvelope({ envelope, signature, publicKeyPem } = {}) {
  const reason = validateEnvelope(envelope);
  if (reason !== undefined) return invalid('envelope-invalid', { reason });
  let publicKey;
  try {
    publicKey = createPublicKey(publicKeyPem);
  } catch (error) {
    return invalid('missing-key', { reason: String(error?.message ?? error) });
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    return invalid('missing-key', { reason: `public key is ${publicKey.asymmetricKeyType}, not ed25519` });
  }
  if (!isText(signature)) return invalid('signature-invalid', { reason: 'empty signature' });
  let signatureBytes;
  try {
    signatureBytes = Buffer.from(signature.trim(), 'base64');
  } catch {
    return invalid('signature-invalid', { reason: 'signature is not base64' });
  }
  let ok = false;
  try {
    ok = cryptoVerify(null, Buffer.from(canonicalJson(envelope), 'utf8'), publicKey, signatureBytes);
  } catch (error) {
    return invalid('signature-invalid', { reason: String(error?.message ?? error) });
  }
  if (!ok) return invalid('signature-invalid');

  const capsReason = validateCaps(envelope.caps);
  if (capsReason !== undefined) return invalid('caps-widened', { reason: capsReason });
  const processReason = validateProcessRules(envelope.process_rules);
  if (processReason !== undefined) return invalid('process-invalid', { reason: processReason });
  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
  return Object.freeze({
    state: 'verified',
    envelope,
    policyVersion: envelope.policy_version,
    issuedBy: envelope.issued_by,
    issuedAt: envelope.issued_at,
    digest: envelopeDigest(envelope),
    keyId: createHash('sha256').update(publicKeyDer).digest('hex'),
    caps: Object.freeze({ ...(envelope.caps ?? {}) }),
    contentRules: Object.freeze([...(envelope.content_rules ?? [])]),
    processRules: Object.freeze({ ...(envelope.process_rules ?? {}) }),
  });
}

/**
 * Read and verify the organization envelope bundled with this package.
 *
 * @param {{policyDir?: string, keysDir?: string, readFile?: Function}} [options]
 * @returns {object} `verified`, `absent` or `invalid`
 */
export function loadOrgPolicy(options = {}) {
  const policyDir = options.policyDir ?? fileURLToPath(new URL('../policy/', import.meta.url));
  const keysDir = options.keysDir ?? fileURLToPath(new URL('../keys/', import.meta.url));
  const readFile = options.readFile ?? ((path) => readFileSync(path, 'utf8'));
  const join = (dir, name) => `${dir.endsWith('/') || dir.endsWith('\\') ? dir : `${dir}/`}${name}`;

  let envelopeText;
  try {
    envelopeText = readFile(join(policyDir, ORG_POLICY_FILES.envelope));
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze({ state: 'absent' });
    return invalid('read-error', { reason: String(error?.message ?? error) });
  }
  let envelope;
  try {
    envelope = JSON.parse(envelopeText);
  } catch (error) {
    return invalid('envelope-invalid', { reason: `not JSON (${error?.message ?? error})` });
  }
  let signature;
  try {
    signature = readFile(join(policyDir, ORG_POLICY_FILES.signature));
  } catch {
    return invalid('signature-invalid', { reason: 'signature file is missing' });
  }
  let publicKeyPem;
  try {
    publicKeyPem = readFile(join(keysDir, ORG_POLICY_FILES.publicKey));
  } catch {
    return invalid('missing-key', { reason: 'public key file is missing' });
  }
  const result = verifyEnvelope({ envelope, signature, publicKeyPem });
  if (result.state !== 'verified') return result;
  try {
    compileContentRules(result.contentRules);
  } catch (error) {
    return invalid('content-rules-invalid', { reason: String(error?.message ?? error) });
  }
  return result;
}

/**
 * The effective decision for one action: builtin default, tightened by the
 * organization caps, then by the local layer. Local can only tighten.
 *
 * @param {{action: string, org?: object, local?: Record<string, string>}} input
 * @returns {'allow' | 'confirm' | 'deny'}
 */
export function effectiveDecision({ action, org, local } = {}) {
  const ceiling = defaultDecision(action);
  const orgCap = org?.state === 'verified' ? org.caps?.[action] : undefined;
  const localCap = local?.[action];
  return strictestDecision(ceiling, orgCap ?? ceiling, localCap ?? ceiling);
}
