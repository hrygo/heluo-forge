#!/usr/bin/env bash
# Isolated local UAT. The archived HEAD mounts the credential and IAM plugins
# with a temporary SQLite value-encrypted store and file keyring. The built-in
# backend binds the iam-atomic-store service to the active provider. IAM uses
# a mock identity provider; the configured model gateway is a loopback address.
# This harness does not establish target-platform or enterprise acceptance.
# IAM_UAT_SMOKE=1 waits for /health, prints SMOKE OK and exits. The archive does
# not include uncommitted workspace changes.
set -eu
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { printf '需在仓库内运行（脚本用 git archive HEAD 打包）\n' >&2; exit 2; }
for tool in node npm python3 git tar; do
  command -v "$tool" >/dev/null 2>&1 || { printf '缺少 %s，无法启动本地 UAT\n' "$tool" >&2; exit 2; }
done
DSH_CMD="${DSH_BIN:-dsh}"
command -v "$DSH_CMD" >/dev/null 2>&1 || { printf '找不到 DSH（%s）；把 dsh 放进 PATH 或设置 DSH_BIN\n' "$DSH_CMD" >&2; exit 2; }
want_node="$(cat .node-version 2>/dev/null || true)"
have_node="$(node -p 'process.versions.node')"
if [ -n "$want_node" ] && [ "$want_node" != "$have_node" ]; then
  printf '警告：Node %s 与仓库 .node-version（%s）不一致；结果需注明运行时\n' "$have_node" "$want_node" >&2
fi
printf '环境：Node %s，DSH %s\n' "$have_node" "$("$DSH_CMD" --version 2>/dev/null | head -1)"
export IAM_UAT_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/heluo-iam-uat.XXXXXXXX")"
mkdir -p "$IAM_UAT_ROOT/source" "$IAM_UAT_ROOT/artifacts" "$IAM_UAT_ROOT/workspace" "$IAM_UAT_ROOT/dsh/profiles/uat"
git archive HEAD | tar -x -C "$IAM_UAT_ROOT/source"
cat > "$IAM_UAT_ROOT/build.mjs" <<'JS'
import { buildBundle } from './source/scripts/build-enterprise-bundle.mjs';
import { fileURLToPath } from 'node:url';
buildBundle({ root: fileURLToPath(new URL('./source/', import.meta.url)), destination: fileURLToPath(new URL('./artifacts/', import.meta.url)) });
JS
node "$IAM_UAT_ROOT/build.mjs"
python3 - <<'PY'
import json, os
from pathlib import Path
r = Path(os.environ['IAM_UAT_ROOT']); p = r / 'dsh/profiles/uat'
tarball = next((r / 'artifacts').glob('*.tgz'))
profile = {'name': 'heluo-isolated-uat', 'private': True, 'dsh': {'profile': {'bundles': ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@heluo/forge-enterprise']}}, 'dependencies': {'@heluo/forge-enterprise': 'file:' + str(tarball)}}
(p / 'package.json').write_text(json.dumps(profile))
(p / 'cordis.yml').write_text('[]\n')
PY
npm install --ignore-scripts --no-audit --no-fund --prefix "$IAM_UAT_ROOT/dsh/profiles/uat"
cat > "$IAM_UAT_ROOT/serve.mjs" <<'JS'
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const root = process.env.IAM_UAT_ROOT;
const hostPort = Number(process.env.IAM_UAT_HOST_PORT || 48388);
const entryPort = Number(process.env.IAM_UAT_ENTRY_PORT || 48389);
const gateway = process.env.IAM_UAT_GATEWAY || 'http://127.0.0.1:8317/v1';
// 0 表示由系统分配回环端口，与 IAM 登记的前缀 http://127.0.0.1: 一致；固定值用于验证端口被占用时的拒绝路径。
const callbackPort = process.env.IAM_UAT_CALLBACK_PORT === undefined || process.env.IAM_UAT_CALLBACK_PORT === '' ? 0 : Number(process.env.IAM_UAT_CALLBACK_PORT);
for (const port of [hostPort, entryPort]) { if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须是 1–65535 的整数'); }
if (!Number.isInteger(callbackPort) || (callbackPort !== 0 && (callbackPort < 1024 || callbackPort > 65535))) throw new Error('IAM_UAT_CALLBACK_PORT 必须是 0 或 1024–65535 的整数');
if (hostPort === entryPort) throw new Error('宿主端口和入口端口不能相同');
const gatewayUrl = new URL(gateway);
if (gatewayUrl.protocol !== 'http:' || gatewayUrl.hostname !== '127.0.0.1' || gatewayUrl.username || gatewayUrl.password || gatewayUrl.search || gatewayUrl.hash || !gatewayUrl.pathname.endsWith('/v1')) throw new Error('测试网关必须是本机 127.0.0.1 的 HTTP /v1 地址');
const { startMockOidc } = await import(pathToFileURL(`${root}/source/packages/forge-iam/test/support/mock-oidc.mjs`));
const mock = await startMockOidc({ clientId: 'isolated-uat', accessTtl: 120 });
await writeFile(`${root}/dsh/profiles/uat/cordis.patch.yml`, `- id: heluo-credentials-keychain\n  config:\n    storeDirectory: ${root}/dsh/credentials\n- id: heluo-iam\n  config:\n    clientId: isolated-uat\n    callbackPort: ${callbackPort}\n    issuer: ${mock.issuer}\n    authorizationEndpoint: ${mock.issuer}/authorize\n    tokenEndpoint: ${mock.issuer}/token\n    jwksUri: ${mock.issuer}/jwks\n    revocationEndpoint: ${mock.issuer}/revoke\n    refreshSkewSeconds: 30\n    managedModels:\n      baseURL: ${JSON.stringify(gateway)}\n`);
const child = spawn(process.env.DSH_BIN || 'dsh', ['--profile', 'uat', '--host', '127.0.0.1', '--port', String(hostPort), '--no-open'], { cwd: `${root}/workspace`, env: { ...process.env, DSH_HOME: `${root}/dsh` }, stdio: ['ignore', 'pipe', 'pipe'] });
let launchUrl; let buffer = ''; let warnings = '';
child.stdout.on('data', chunk => { buffer += chunk.toString(); const match = buffer.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/); if (match) { launchUrl = match[1]; buffer = ''; } if (buffer.length > 16384) buffer = buffer.slice(-16384); });
child.stderr.on('data', chunk => { warnings = (warnings + chunk).slice(-4096); });
child.on('error', error => { console.error('无法启动 DSH：', error.message); process.exit(1); });
child.on('exit', code => { console.error(`DSH 已退出：${code}`, warnings.replace(/\?token=[^\s]+/g, '?token=[redacted]')); process.exit(1); });
const server = createServer((req, res) => {
  res.setHeader('cache-control', 'no-store'); res.setHeader('referrer-policy', 'no-referrer');
  if (req.url === '/health') { res.writeHead(launchUrl ? 200 : 503).end(launchUrl ? 'ready' : 'starting'); return; }
  if (req.method !== 'GET' || req.url !== '/') { res.writeHead(404).end(); return; }
  if (!launchUrl) { res.writeHead(503).end('Starting; refresh shortly.'); return; }
  res.writeHead(303, { location: launchUrl }).end();
});
server.on('error', async error => { console.error('无法启动入口：', error.message); child.kill('SIGTERM'); await mock.close(); process.exit(1); });
server.listen(entryPort, '127.0.0.1', () => {
  console.log(`测试入口：http://127.0.0.1:${entryPort}/`);
  console.log(callbackPort === 0 ? '回调端口：系统分配（只在该次登录期间监听）' : `回调端口：固定 ${callbackPort}`);
  if (process.env.IAM_UAT_SMOKE === '1') {
    const deadline = Date.now() + 120_000;
    const timer = setInterval(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${entryPort}/health`);
        if (response.ok) {
          clearInterval(timer);
          console.log('SMOKE OK');
          await stop();
        }
      } catch {}
      if (Date.now() > deadline) {
        clearInterval(timer);
        console.error('SMOKE TIMEOUT：宿主未在 120 秒内就绪');
        server.close();
        child.kill('SIGTERM');
        await mock.close();
        process.exit(1);
      }
    }, 1000);
  }
});
async function stop() { server.close(); child.kill('SIGTERM'); await mock.close(); process.exit(0); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
JS
printf '隔离目录：%s\n' "$IAM_UAT_ROOT"
node "$IAM_UAT_ROOT/serve.mjs"
