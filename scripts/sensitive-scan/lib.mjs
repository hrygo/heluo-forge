import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export const SCANNER_NAME = 'heluo-sensitive-scan';
export const SCANNER_VERSION = '1.0.0';
export const SCANNER_ID = `${SCANNER_NAME}@${SCANNER_VERSION}`;
export const TRAILER_VERSION = 'v1';
export const TRAILER_MARKER = 'Sensitive-Scan: v1';
export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function defaultConfigDir() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'heluo-forge', 'sensitive-scan');
}

export function defaultRulesPath() {
  return process.env.SENSITIVE_SCAN_RULES || join(defaultConfigDir(), 'rules.json');
}

export function defaultKeyPath() {
  return process.env.SENSITIVE_SCAN_KEY_FILE || join(defaultConfigDir(), 'device-key.pem');
}

export function repoRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
}

export function gitOutput(args, options = {}) {
  return execFileSync('git', args, {
    cwd: options.cwd,
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  });
}

export function readJson(path, label = path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${label}: ${error.message}`);
  }
}

export function readJsonFromGit(ref, path, label = path) {
  try {
    const raw = gitOutput(['show', `${ref}:${path}`]);
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`cannot read ${label} from ${ref}: ${error.message}`);
  }
}

export function normalizeMessage(message) {
  return `${String(message)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\s+$/u, '')}\n`;
}

function messageLines(message) {
  return String(message).replace(/\r\n?/g, '\n').split('\n');
}

export function cleanMessage(message) {
  return normalizeMessage(
    execFileSync('git', ['stripspace', '--strip-comments'], {
      input: String(message),
      encoding: 'utf8',
    }),
  );
}

export function stripTrailer(message) {
  const lines = messageLines(message);
  const index = lines.findLastIndex((line) => line === TRAILER_MARKER);
  if (index === -1) return normalizeMessage(message);
  try {
    return parseTrailer(message).body;
  } catch {
    // Do not silently drop body content when the marker is embedded in prose.
    return normalizeMessage(message);
  }
}

export function parseTrailer(message) {
  const lines = messageLines(message);
  const index = lines.findLastIndex((line) => line === TRAILER_MARKER);
  if (index === -1) return null;

  const fields = {};
  for (const line of lines.slice(index)) {
    if (!line) continue;
    const match = /^Sensitive-Scan(?:-([A-Za-z]+))?: (.+)$/.exec(line);
    if (!match) {
      throw new Error(`unexpected line after ${TRAILER_MARKER}: ${line}`);
    }
    const key = (match[1] || 'version').toLowerCase();
    if (Object.hasOwn(fields, key)) throw new Error(`duplicate field: Sensitive-Scan-${key}`);
    fields[key] = match[2];
  }

  const required = ['version', 'tree', 'message', 'rules', 'scanner', 'time', 'nonce', 'key', 'sig'];
  for (const key of required) {
    if (!fields[key]) throw new Error(`missing Sensitive-Scan-${key}`);
  }
  if (fields.version !== TRAILER_VERSION) {
    throw new Error(`unsupported Sensitive-Scan version: ${fields.version}`);
  }
  const body = lines.slice(0, index).join('\n');
  return { fields, body: body.trim() ? normalizeMessage(body) : '' };
}

export function canonicalPayload({ tree, message, rules, scanner, time, nonce }) {
  return [
    TRAILER_VERSION,
    `tree=${tree}`,
    `message=${message}`,
    `rules=${rules}`,
    `scanner=${scanner}`,
    `time=${time}`,
    `nonce=${nonce}`,
  ].join('\n');
}

export function formatTrailer(body, fields) {
  const lines = [
    TRAILER_MARKER,
    `Sensitive-Scan-Tree: ${fields.tree}`,
    `Sensitive-Scan-Message: ${fields.message}`,
    `Sensitive-Scan-Rules: ${fields.rules}`,
    `Sensitive-Scan-Scanner: ${fields.scanner}`,
    `Sensitive-Scan-Time: ${fields.time}`,
    `Sensitive-Scan-Nonce: ${fields.nonce}`,
    `Sensitive-Scan-Key: ${fields.key}`,
    `Sensitive-Scan-Sig: ${fields.sig}`,
  ];
  const prefix = body.trim() ? `${body.trim()}\n\n` : '';
  return `${prefix}${lines.join('\n')}\n`;
}

export function createAttestation({ body, tree, rules, keyId, privateKey, now = Date.now() }) {
  const digest = sha256Hex(normalizeMessage(body));
  const time = Math.floor(now / 1000);
  const nonce = randomBytes(16).toString('hex');
  const payload = canonicalPayload({ tree, message: digest, rules, scanner: SCANNER_ID, time, nonce });
  const signature = sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64');
  return {
    digest,
    fields: {
      tree,
      message: digest,
      rules,
      scanner: SCANNER_ID,
      time,
      nonce,
      key: keyId,
      sig: signature,
    },
  };
}

export function keyIdFromPublicKey(publicKey) {
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return sha256Hex(spki);
}

export function loadKeyPair(privateKeyPath = defaultKeyPath()) {
  if (!existsSync(privateKeyPath)) {
    throw new Error(`private key not found: ${privateKeyPath}; run scripts/sensitive-scan/keygen.mjs`);
  }
  if (process.platform !== 'win32') {
    const mode = statSync(privateKeyPath).mode & 0o777;
    if (mode & 0o077) {
      throw new Error(`private key is accessible by group/others (${mode.toString(8)}): ${privateKeyPath}; chmod 600 it`);
    }
  }
  const privateKey = createPrivateKey(readFileSync(privateKeyPath));
  const publicKey = createPublicKey(privateKey);
  return { privateKey, publicKey, keyId: keyIdFromPublicKey(publicKey) };
}

export function loadRegistry(path) {
  const value = readJson(path, 'key registry');
  if (value?.version !== 1 || !Array.isArray(value.keys)) {
    throw new Error(`${path}: expected { version: 1, keys: [...] }`);
  }
  return value;
}

export function loadAllowedRules(path) {
  const value = readJson(path, 'rules allowlist');
  if (value?.version !== 1 || !Array.isArray(value.rules) || !Array.isArray(value.scanners)) {
    throw new Error(`${path}: expected { version: 1, rules: [...], scanners: [...] }`);
  }
  return value;
}

export function rulesDigest(path) {
  if (!existsSync(path)) throw new Error(`rules file not found: ${path}`);
  return sha256Hex(readFileSync(path));
}

export function loadRules(path) {
  const value = readJson(path, 'sensitive rules');
  if (value?.version !== 1 || !Array.isArray(value.rules)) {
    throw new Error(`${path}: expected { version: 1, rules: [...] }`);
  }
  const rules = value.rules.map((rule, index) => {
    if (typeof rule?.id !== 'string' || typeof rule?.pattern !== 'string' || !rule.id) {
      throw new Error(`${path}: rule ${index} needs id and pattern`);
    }
    let regex;
    try {
      regex = new RegExp(rule.pattern, rule.flags ?? 'g');
    } catch (error) {
      throw new Error(`${path}: invalid regex for ${rule.id}: ${error.message}`);
    }
    const paths = Array.isArray(rule.paths) ? rule.paths.map((entry) => new RegExp(entry)) : null;
    return {
      id: rule.id,
      severity: rule.severity ?? 'medium',
      regex,
      paths,
      description: rule.description ?? '',
    };
  });
  return { version: 1, rules, exclude: value.exclude ? new RegExp(value.exclude) : null };
}

export function scanText(text, rules) {
  const findings = [];
  const lines = String(text).split('\n');
  for (const rule of rules.rules) {
    for (let index = 0; index < lines.length; index += 1) {
      rule.regex.lastIndex = 0;
      if (rule.regex.test(lines[index])) {
        findings.push({ ruleId: rule.id, severity: rule.severity, line: index + 1 });
      }
    }
  }
  return findings;
}

export function scanStaged({ cwd = process.cwd(), rules, maxFileBytes = DEFAULT_MAX_FILE_BYTES } = {}) {
  if (!rules) throw new Error('rules are required');
  const raw = gitOutput(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], { cwd });
  const files = raw.split('\0').filter(Boolean);
  const findings = [];
  const skipped = [];
  let scanned = 0;

  for (const file of files) {
    if (rules.exclude?.test(file)) {
      skipped.push({ path: file, reason: 'excluded' });
      continue;
    }
    let size;
    try {
      size = Number(gitOutput(['cat-file', '-s', `:${file}`], { cwd }).trim());
      if (!Number.isSafeInteger(size) || size < 0) throw new Error('invalid blob size');
    } catch {
      skipped.push({ path: file, reason: 'unreadable' });
      continue;
    }
    if (size > maxFileBytes) {
      skipped.push({ path: file, reason: 'too-large', size });
      continue;
    }
    let buffer;
    try {
      buffer = execFileSync('git', ['show', `:${file}`], {
        cwd,
        maxBuffer: maxFileBytes + 1024,
      });
    } catch {
      skipped.push({ path: file, reason: 'unreadable' });
      continue;
    }
    if (buffer.includes(0)) {
      skipped.push({ path: file, reason: 'binary' });
      continue;
    }
    if (buffer.length > maxFileBytes) {
      skipped.push({ path: file, reason: 'too-large', size: buffer.length });
      continue;
    }
    const text = buffer.toString('utf8');
    const lines = text.split('\n');
    for (const rule of rules.rules) {
      if (rule.paths && !rule.paths.some((regex) => regex.test(file))) continue;
      for (let index = 0; index < lines.length; index += 1) {
        rule.regex.lastIndex = 0;
        if (rule.regex.test(lines[index])) {
          findings.push({ path: file, ruleId: rule.id, severity: rule.severity, line: index + 1 });
        }
      }
    }
    scanned += 1;
  }

  return { findings, skipped, scanned, total: files.length };
}

export function resolvePath(value, cwd = process.cwd()) {
  return isAbsolute(value) ? value : resolve(cwd, value);
}
