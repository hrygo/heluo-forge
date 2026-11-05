#!/usr/bin/env bash
# Isolated local UAT only; never use test trust injections in production.
set -eu
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
python3 - <<'PY'
import json, os
from pathlib import Path
r = Path(os.environ['IAM_UAT_ROOT']); base = r / 'dsh/profiles/uat/node_modules/@heluo/forge-enterprise/node_modules/@heluo'
iam = base / 'forge-iam'; credentials = base / 'forge-credentials-keychain'
for p in (iam, credentials):
    manifest = json.loads((p / 'package.json').read_text())
    manifest['main'] = './src/index.uat.mjs'; manifest['exports']['.'] = './src/index.uat.mjs'
    (p / 'package.json').write_text(json.dumps(manifest, indent=2) + '\n')
s = (iam / 'src/index.mjs').read_text(); old = "from './service.mjs'"
if old not in s: raise SystemExit('IAM 入口已变化，请检查测试注入适配方式')
(iam / 'src/index.uat.mjs').write_text(s.replace(old, "from './uat-service.mjs'"))
fixture = (r / 'source/packages/forge-iam/test/support/atomic-gateway.mjs').as_uri()
(iam / 'src/uat-service.mjs').write_text("import {createIamService as createActual} from './service.mjs';\nimport {createAtomicGatewayFixture} from " + json.dumps(fixture) + ";\nexport function createIamService(config, options = {}) { const fixture = createAtomicGatewayFixture(); return createActual(config, {...options, credentials: fixture.credentials, getCredentials: () => fixture.credentials, verifyAtomicStore: candidate => candidate === fixture.credentials, ...fixture.options}); }\n")
(credentials / 'src/index.uat.mjs').write_text("import {apply as applyActual, createMemoryBackend} from './index.mjs';\nexport const name = 'forge-credentials-keychain-uat';\nexport const inject = [];\nexport function apply(ctx) { return applyActual(ctx, {backend: createMemoryBackend(), allowEphemeral: true}); }\n")
PY
cat > "$IAM_UAT_ROOT/serve.mjs" <<'JS'
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const root = process.env.IAM_UAT_ROOT;
const hostPort = Number(process.env.IAM_UAT_HOST_PORT || 48388);
const entryPort = Number(process.env.IAM_UAT_ENTRY_PORT || 48389);
const gateway = process.env.IAM_UAT_GATEWAY || 'http://127.0.0.1:8317/v1';
for (const port of [hostPort, entryPort]) { if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须是 1–65535 的整数'); }
if (hostPort === entryPort) throw new Error('宿主端口和入口端口不能相同');
const gatewayUrl = new URL(gateway);
if (gatewayUrl.protocol !== 'http:' || gatewayUrl.hostname !== '127.0.0.1' || gatewayUrl.username || gatewayUrl.password || gatewayUrl.search || gatewayUrl.hash || !gatewayUrl.pathname.endsWith('/v1')) throw new Error('测试网关必须是本机 127.0.0.1 的 HTTP /v1 地址');
const { startMockOidc } = await import(pathToFileURL(`${root}/source/packages/forge-iam/test/support/mock-oidc.mjs`));
const mock = await startMockOidc({ clientId: 'isolated-uat', accessTtl: 120 });
await writeFile(`${root}/dsh/profiles/uat/cordis.patch.yml`, `- id: heluo-credentials-keychain\n  disabled: false\n- id: heluo-iam\n  config:\n    clientId: isolated-uat\n    issuer: ${mock.issuer}\n    authorizationEndpoint: ${mock.issuer}/authorize\n    tokenEndpoint: ${mock.issuer}/token\n    jwksUri: ${mock.issuer}/jwks\n    revocationEndpoint: ${mock.issuer}/revoke\n    allowInsecureHttp: true\n    refreshSkewSeconds: 30\n    managedModels:\n      baseURL: ${JSON.stringify(gateway)}\n`);
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
server.listen(entryPort, '127.0.0.1', () => console.log(`测试入口：http://127.0.0.1:${entryPort}/`));
async function stop() { server.close(); child.kill('SIGTERM'); await mock.close(); process.exit(0); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
JS
printf '隔离目录：%s\n' "$IAM_UAT_ROOT"
node "$IAM_UAT_ROOT/serve.mjs"
