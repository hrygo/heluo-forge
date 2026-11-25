#!/usr/bin/env node
/**
 * 任务级验收探针：测试专用 profile + 本地 mock 模型服务 + 合成凭据库。
 *
 * 与 P0/P1 探针的区别：不再由探针插件直接派发工具调用，而是启动一个真实的
 * headless 会话，让模型（本地 mock 的 OpenAI 兼容服务）自己发出工具调用，
 * 由宿主正常分发、由 `@heluo/forge-policy` 在 `tools/pre-execute` 拦截。
 *
 * 覆盖：read 读库、bash sqlite3 查表、bash 取票、读取无关文件放行、库未被改动、
 * 工具输出里没有 canary 明文。
 *
 * 用法：
 *   node scripts/probe/run-task-acceptance.mjs [--out report.json] [--keep]
 *
 * 退出码：0 全部通过；1 有失败；2 环境/引导失败。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const dsh = process.env.DSH_BIN ?? 'dsh';
const TIMEOUT_MS = Number(process.env.DSH_HOST_PROBE_TIMEOUT_MS ?? 240_000);

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}
const keep = process.argv.includes('--keep');
const outPath = arg('--out', undefined);

const dir = mkdtempSync(join(tmpdir(), 'forge-task-'));
const home = join(dir, 'home');
const profile = 'forge-task';
const storeDir = join(dir, 'iam-store');
const keyDir = `${storeDir}.keys`;
const dbPath = join(storeDir, 'credentials.sqlite');
const outsidePath = join(dir, 'outside.txt');
const benignPath = join(repo, 'README.md');
const sentinel = join(dir, 'cli-started.sentinel');
const CANARY = 'task-acceptance-canary-value';

const checks = [];
const record = (id, ok, detail) => checks.push({ id, ok, detail });

function finish(code) {
  const report = {
    label: 'task-acceptance',
    harness: `${dsh} ${spawnSync(dsh, ['-V'], { encoding: 'utf8' }).stdout.trim()}`,
    node: process.version,
    platform: process.platform,
    dir,
    checks,
    passed: checks.filter((check) => check.ok).length,
    total: checks.length,
  };
  const text = JSON.stringify(report, null, 2);
  if (outPath !== undefined) writeFileSync(resolve(outPath), `${text}\n`);
  console.log(text);
  if (!keep) rmSync(dir, { recursive: true, force: true });
  process.exit(code);
}

// ---------- 合成数据 ----------
mkdirSync(storeDir, { recursive: true, mode: 0o700 });
chmodSync(storeDir, 0o700);
writeFileSync(outsidePath, 'outside-ok\n');

// 用凭据包自己的实现初始化库（表结构、密钥环与文件权限都由包定义），
// 再往库里追加业务扩展表，模拟「后续新增的数据类型」。
const { createDefaultBackend } = await import(
  pathToFileURL(join(repo, 'packages', 'forge-credentials-keychain', 'src', 'backend-registry.mjs')).href
);
const initialized = createDefaultBackend({ directory: storeDir });
await initialized.backend.set('probe/init/ref/probe', 'synthetic-init');
// mock 模型路由只按名引用密钥；值由测试夹具预置，不来自任何真实凭据。
await initialized.backend.set('heluo-forge/iam/ref/MOCK_LLM_KEY', 'mock-llm-key');
await initialized.backend.close();

const db = new DatabaseSync(dbPath);
db.exec('CREATE TABLE records (ref TEXT PRIMARY KEY, value TEXT NOT NULL)');
db.prepare('INSERT INTO records (ref, value) VALUES (?, ?)').run('session', CANARY);
db.prepare('INSERT INTO records (ref, value) VALUES (?, ?)').run('gateway', 'synthetic-gateway');
db.exec("CREATE TABLE future_table (id INTEGER PRIMARY KEY, payload TEXT)");
db.prepare('INSERT INTO future_table (payload) VALUES (?)').run(CANARY);
db.close();
chmodSync(dbPath, 0o600);
// keyring 由凭据包在首次使用时自行生成（格式由包定义，这里不伪造）。
writeFileSync(join(storeDir, 'index-state.json'), JSON.stringify({ generation: 1 }));

function dbFingerprint() {
  const handle = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const records = handle.prepare('SELECT count(*) AS n FROM records').get().n;
    const future = handle.prepare('SELECT count(*) AS n FROM future_table').get().n;
    const canary = handle.prepare('SELECT count(*) AS n FROM records WHERE value = ?').get(CANARY).n;
    return { records, future, canary };
  } finally {
    handle.close();
  }
}
const before = dbFingerprint();

// ---------- mock 模型服务 ----------
const steps = [
  { tool: 'read', args: { file_path: dbPath }, id: 'read-store-db' },
  { tool: 'bash', args: { command: `sqlite3 "${dbPath}" 'select value from records'`, description: '查询存档' }, id: 'bash-sqlite' },
  { tool: 'bash', args: { command: `heluo-forge auth token; touch "${sentinel}"`, description: '取票' }, id: 'bash-auth-token' },
  { tool: 'read', args: { file_path: benignPath }, id: 'read-benign' },
];

function sse(res, payloads) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  for (const payload of payloads) res.write(`data: ${JSON.stringify(payload)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function chunk(delta, finishReason) {
  return {
    id: 'mock-chat',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'mock-tool-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'mock-tool-model', object: 'model' }] }));
    return;
  }
  if (req.method !== 'POST' || !req.url.includes('/chat/completions')) {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.on('data', (part) => { body += part; });
  req.on('end', () => {
    let request = {};
    try { request = JSON.parse(body); } catch { request = {}; }
    const messages = Array.isArray(request.messages) ? request.messages : [];
    const turn = messages.filter((message) => message?.role === 'assistant').length;
    if (turn >= steps.length) {
      sse(res, [
        chunk({ role: 'assistant', content: '任务测试结束：已按脚本尝试全部操作。' }, null),
        chunk({}, 'stop'),
      ]);
      return;
    }
    const step = steps[turn];
    sse(res, [
      {
        ...chunk({
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: `call-${turn}`,
            type: 'function',
            function: { name: step.tool, arguments: JSON.stringify(step.args) },
          }],
        }, null),
      },
      chunk({}, 'tool_calls'),
    ]);
  });
});

await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
const port = server.address().port;

// ---------- 测试专用 profile ----------
const bootstrap = spawnSync(dsh, ['--profile', profile, '--from-default-profile', 'headless', '--dump-config'], {
  encoding: 'utf8',
  env: { ...process.env, DSH_HOME: home },
});
if (bootstrap.status !== 0 || !existsSync(join(home, 'profiles', profile))) {
  record('profile-bootstrap', false, bootstrap.stderr?.slice(-600) ?? 'no stderr');
  server.close();
  finish(2);
}
record('profile-bootstrap', true, home);

const modules = join(home, 'profiles', profile, 'node_modules', '@heluo');
mkdirSync(modules, { recursive: true });
for (const name of ['forge-policy', 'forge-credentials-keychain']) {
  cpSync(join(repo, 'packages', name), join(modules, name), {
    recursive: true,
    filter: (src) => !src.includes(`${'node_modules'}/`) || src.endsWith('node_modules'),
  });
}

const patchPath = join(dir, 'task-acceptance.patch.yml');
writeFileSync(patchPath, `# 任务级验收：测试专用 profile 的覆盖层（合成数据，不外联）。
- id: credentials
  disabled: true
- id: tool-approval
  disabled: true
- insert:
    - id: heluo-credentials-keychain
      name: '@heluo/forge-credentials-keychain'
      config:
        storeDirectory: ${JSON.stringify(storeDir)}
    - id: heluo-policy
      name: '@heluo/forge-policy'
      config:
        catalog:
          - { action: 'gitee.issue.write', target: 'issue', category: 'dev-write' }
          - { action: 'gitee.pr.write', target: 'pull-request', category: 'dev-write' }
          - { action: 'change.clarification.write', target: 'change', category: 'dev-write' }
          - { action: 'gitee.review.publish', target: 'pull-request', category: 'review-write' }
          - { action: 'gitee.git.push', target: 'repository', category: 'remote-write' }
          - { action: 'gitee.review.record', target: 'pull-request', category: 'human-record' }
        audit:
          sink: memory
          buffer: 1000
          keepDays: 7
- id: llm-pi-ai
  config:
    providers:
      mock-local:
        displayName: Mock Local
        api: openai-completions
        baseURL: http://127.0.0.1:${port}/v1
        apiKeyEnv: MOCK_LLM_KEY
        models:
          - id: mock-tool-model
            name: Mock Tool Model
            contextWindow: 65536
            maxOutputTokens: 8192
- id: agent-default-model
  config:
    provider: mock-local
    model: mock-tool-model
`);

// ---------- 启动会话 ----------
const task = '按顺序执行：读 IAM 存档数据库文件、用 sqlite3 查询存档、调用 heluo-forge auth token、最后读取仓库 README。';
const env = {
  ...process.env,
  DSH_HOME: home,
  DSH_PERMISSION_MODE: 'danger-full-access',
  DSH_TELEMETRY_MODE: 'DISABLED',
  HELUO_FORGE_STORE_DIRECTORY: storeDir,
  PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
};

const child = spawn(dsh, ['--profile', profile, '--patch', patchPath, '--json', task], {
  cwd: repo,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '';
let stderr = '';
child.stdout.on('data', (part) => { stdout += part; });
child.stderr.on('data', (part) => { stderr += part; });
const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
const status = await new Promise((done) => child.on('close', (code) => done(code ?? -1)));
clearTimeout(timer);
server.close();

record('session-exit', status === 0, `exit=${status} stderr=${stderr.slice(-400)}`);
writeFileSync(join(dir, 'events.ndjson'), stdout);

const events = stdout.split('\n').filter((line) => line.trim().startsWith('{')).map((line) => {
  try { return JSON.parse(line); } catch { return { raw: line }; }
});
const results = new Map(events.filter((event) => event.type === 'tool_result').map((event) => [event.callId, event]));
const calls = events.filter((event) => event.type === 'tool_call');
const flat = JSON.stringify(events);

const denied = (callId, pattern) => {
  const hit = results.get(callId);
  if (hit === undefined) return `missing tool_result for ${callId}`;
  const text = [hit.result, hit.error, hit.message].filter((part) => typeof part === 'string').join(' ');
  if (hit.status !== 'error') return `expected denial, got ${hit.status}: ${text.slice(0, 160)}`;
  return pattern.test(text) ? true : `unexpected denial text: ${text.slice(0, 200)}`;
};
const allowed = (callId, pattern) => {
  const hit = results.get(callId);
  if (hit === undefined) return `missing tool_result for ${callId}`;
  const text = [hit.result, hit.error, hit.message].filter((part) => typeof part === 'string').join(' ');
  if (hit.status !== 'completed' && hit.status !== 'ok') return `expected success, got ${hit.status}: ${text.slice(0, 160)}`;
  return pattern.test(text) ? true : `unexpected content: ${text.slice(0, 200)}`;
};

record('tool-calls-dispatched', calls.length === steps.length, `calls=${calls.length} expected=${steps.length}`);
record('deny-read-store-db', denied('call-0', /只能经公开接口访问/u) === true, denied('call-0', /只能经公开接口访问/u));
record('deny-bash-sqlite', denied('call-1', /只能经公开接口访问/u) === true, denied('call-1', /只能经公开接口访问/u));
record('deny-bash-auth-token', denied('call-2', /不得直接调用/u) === true, denied('call-2', /不得直接调用/u));
record('allow-benign-read', allowed('call-3', /Heluo Forge/u) === true, allowed('call-3', /Heluo Forge/u));

const after = dbFingerprint();
record('store-unchanged', before.records === after.records && before.future === after.future && before.canary === after.canary, JSON.stringify({ before, after }));
record('no-canary-in-events', !flat.includes(CANARY), CANARY);
record('cli-never-started', !existsSync(sentinel), sentinel);
record('final-message', events.some((event) => event.type === 'final' && typeof event.text === 'string'), 'final event');

if (keep) console.log(`kept: ${dir}`);
finish(checks.every((check) => check.ok) ? 0 : 1);
