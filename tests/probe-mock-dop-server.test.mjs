import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { HOST_PATH, SECRETS } from '../scripts/lib/sensitive-patterns.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES_DIR = join(REPO, 'scripts', 'probe', 'fixtures', 'dop-workbench');
const SCRIPT = join(REPO, 'scripts', 'probe', 'mock-dop-server.mjs');
const TOKEN = 'mock-dop-token';

function freePort() {
  return new Promise((resolvePort, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolvePort(port));
    });
  });
}

async function waitForHealth(baseUrl, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/__mock/health`);
      if (res.ok) return res.json();
    } catch {
      // 等待挡板监听就绪
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`mock-dop-server 未在 ${timeoutMs}ms 内就绪`);
}

function collectJsonFixtures(dir, relPrefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectJsonFixtures(full, rel));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      out.push(rel);
    }
  }
  return out.sort();
}

test('DOP 工作台离线夹具全部二次脱敏且结构合法、体积可控', () => {
  const files = collectJsonFixtures(FIXTURES_DIR);
  assert.ok(files.includes('manifest.json'));
  assert.ok(files.length >= 30);

  const manifest = JSON.parse(readFileSync(join(FIXTURES_DIR, 'manifest.json'), 'utf8'));
  const listed = new Set(manifest.map((entry) => entry.file));
  for (const f of files) {
    if (f !== 'manifest.json') assert.ok(listed.has(f), `${f} 应在 manifest.json 中登记`);
  }

  for (const f of files) {
    const full = join(FIXTURES_DIR, f);
    const sz = statSync(full).size;
    assert.ok(sz < 32 * 1024, `${f} 体积 (${sz}B) 超过 32 KiB 裁薄上限`);
    const txt = readFileSync(full, 'utf8');
    JSON.parse(txt);

    for (const line of txt.split('\n')) {
      const clean = line.replace(/\r$/, '');
      assert.equal(/[ \t]+$/.test(clean), false, `${f} 存在行尾空白`);
      assert.equal(HOST_PATH.test(clean), false, `${f} 含宿主机绝对路径`);
      for (const [re, label] of SECRETS) {
        assert.equal(re.test(clean), false, `${f} 命中敏感模式 ${label}`);
      }
    }

    const phones = txt.match(/\b1[3-9]\d{9}\b/gu) ?? [];
    assert.equal(phones.length, 0, `${f} 含 11 位手机号格式`);
    const privateIps = txt.match(/\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/gu);
    assert.equal(privateIps, null, `${f} 含内网私网 IP`);

    const nonLoopbackIps = (txt.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu) ?? []).filter((ip) => ip !== '127.0.0.1');
    assert.equal(nonLoopbackIps.length, 0, `${f} 含非 127.0.0.1 的 IPv4 地址: ${nonLoopbackIps.join(', ')}`);

    for (const match of txt.matchAll(/https?:\/\/([A-Za-z0-9.-]+)(?::\d+)?/gu)) {
      const host = match[1].toLowerCase();
      assert.ok(
        host === '127.0.0.1' || host === 'localhost' || host.endsWith('.example'),
        `${f} 含非占位/回环 URL 主机: ${host}`,
      );
    }

    const emails = txt.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu) ?? [];
    assert.equal(emails.length, 0, `${f} 含邮箱地址格式，请使用 [at] 占位`);
  }

  const profile = JSON.parse(readFileSync(join(FIXTURES_DIR, 'uam_myProfile.json'), 'utf8'));
  for (const key of ['loginCode', 'name', 'dashboardId', 'simulating', 'firstOrg', 'secondOrg', 'roles', 'teams']) {
    assert.ok(key in profile, `uam_myProfile.json 缺少键 ${key}`);
  }
  assert.equal(profile.loginCode, '000001', 'uam_myProfile.json 应使用占位工号 000001');
  assert.ok(String(profile.name).startsWith('示例'), 'uam_myProfile.json 姓名应为示例占位');
  assert.ok(String(profile.firstOrg?.code ?? '').startsWith('ORG-MOCK-'), 'uam_myProfile.json firstOrg.code 应使用 MOCK 占位');
  assert.ok(String(profile.secondOrg?.code ?? '').startsWith('ORG-MOCK-'), 'uam_myProfile.json secondOrg.code 应使用 MOCK 占位');
  assert.ok(profile.teams.length <= 2, 'myProfile.teams 应裁薄至代表样本');
});

test('mock-dop-server 完整仿真 DOP 双轨鉴权、7 路待办、三大进展板、需求/RMP 表单及故障注入', { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [SCRIPT], {
    env: {
      ...process.env,
      MOCK_DOP_PORT: String(port),
      MOCK_DOP_TOKEN: TOKEN,
      MOCK_DOP_ACCEPT_AT_PREFIX: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));

  const health = await waitForHealth(base);
  assert.equal(health.ok, true);
  assert.ok(health.fixtures >= 30);

  // 1. DOP 鉴权护栏：无头、Bearer 前缀均返回 403
  const noAuth = await fetch(`${base}/uam/api/user/myProfile`);
  assert.equal(noAuth.status, 403);
  assert.equal((await noAuth.json()).message, 'Access Denied');

  const noAuthText = await fetch(`${base}/uam/api/user/myProfile`, {
    headers: { 'x-mock-dop-error-mode': 'text' },
  });
  assert.equal(noAuthText.status, 403);
  assert.equal(await noAuthText.text(), 'Access Denied');

  const wrongBearer = await fetch(`${base}/uam/api/user/myProfile`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(wrongBearer.status, 403);

  // 2. DOP 正常裸头（及模拟 IAM 的 at-* 令牌）
  const dopHeaders = { authorization: TOKEN };
  const profileRes = await fetch(`${base}/uam/api/user/myProfile`, { headers: dopHeaders });
  assert.equal(profileRes.status, 200);
  const profile = await profileRes.json();
  assert.equal(profile.loginCode, '000001');

  assert.deepEqual(await (await fetch(`${base}/uam/api/team/list`, { headers: dopHeaders })).json(), []);

  // 3. 6 路 DOP 待办 + 3 大进展板视角切换
  for (const [method, path, body] of [
    ['GET', '/asd/api/todo/list?pageNum=1&pageSize=10'],
    ['GET', '/asd/api/issue/myIssue/list?pageNum=1&pageSize=10&typeIds=main_story,assistance_story'],
    ['GET', '/odo/api/bizFlow/myTasks?pageNum=1&pageSize=5'],
    ['POST', '/tmp/api/app/defect/myDefect/query', JSON.stringify({ pageNum: 1, pageSize: 5 })],
    ['GET', '/odo/api/procalmation/list?page=1&size=10'],
    ['GET', '/odo/api/online/process/list?page=1&size=10&type=1'],
  ]) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body ? { ...dopHeaders, 'content-type': 'application/json' } : dopHeaders,
      body,
    });
    assert.equal(res.status, 200, `${method} ${path} 应返回 200`);
  }

  const reqMgr = await (await fetch(`${base}/asd/api/dashboard/requirement/progress?type=manager`, { headers: dopHeaders })).json();
  const reqBiz = await (await fetch(`${base}/asd/api/dashboard/requirement/progress?type=business`, { headers: dopHeaders })).json();
  assert.equal(typeof reqMgr.averageAcceptDays, 'number');
  assert.equal(reqBiz.averageAcceptDays, null);

  const relCreator = await (await fetch(`${base}/asd/api/release/progress?personnel=creator`, { headers: dopHeaders })).json();
  assert.ok('waitReleasingNum' in relCreator);
  const storyPart = await (await fetch(`${base}/asd/api/story/progress?personnel=participate`, { headers: dopHeaders })).json();
  assert.ok('normalNum' in storyPart);
  const projPart = await (await fetch(`${base}/ppm/api/project/progress?qType=participant`, { headers: dopHeaders })).json();
  assert.ok('releaseNum' in projPart && 'delayNum' in projPart);

  // 4. 我的需求互斥参数拦截 + 详情 + 故事 + 迭代桩
  const clash = await fetch(`${base}/asd/api/commonDashboard/requirement/query?managedByMe=true&participantHasMe=true`, {
    headers: dopHeaders,
  });
  assert.equal(clash.status, 400);

  const myReqs = await (
    await fetch(`${base}/asd/api/commonDashboard/requirement/query?managedByMe=true&pageNum=1&pageSize=10`, {
      headers: dopHeaders,
    })
  ).json();
  assert.ok(myReqs.items.length > 0);

  const storyOne = await (await fetch(`${base}/asd/api/story/one/2`, { headers: dopHeaders })).json();
  assert.equal(storyOne.sprint, undefined);
  assert.equal(storyOne.priority, null);
  assert.equal(storyOne.storyPoint, null);
  assert.ok(storyOne.requirement?.no);

  const storyNope = await fetch(`${base}/asd/api/story/one/NOPE`, { headers: dopHeaders });
  assert.equal(storyNope.status, 400);

  const procRes = await (await fetch(`${base}/odo/api/procalmation/list?page=1&size=10`, { headers: dopHeaders })).json();
  assert.ok(Array.isArray(procRes.data), 'procalmation.data 应为纯数组');
  assert.equal(typeof procRes.total, 'number');

  const itsmUrlRes = await (
    await fetch(`${base}/odo/api/online/process/url?wjbiid=WJBI-MOCK-01`, { headers: dopHeaders })
  ).json();
  assert.equal(itsmUrlRes.code, 0);
  assert.ok(itsmUrlRes.data.includes('/backstage/workflow/serviceApply/applyCopyView?wjbiid=WJBI-MOCK-01'));

  const sprintStub = await (await fetch(`${base}/asd/api/sprint/SPR-MOCK-001/issue/list`, { headers: dopHeaders })).json();
  assert.ok(Array.isArray(sprintStub.items) && sprintStub.items.length > 0);
  const oldSprint404 = await fetch(`${base}/asd/api/sprint/issue/list?storyId=2`, { headers: dopHeaders });
  assert.equal(oldSprint404.status, 404);

  // 5. RMP 双轨：直透返回 401 空体；/sso 换 _tk 后 Bearer 通过；getOutlineTree 拒绝 JSON、接受 form
  const directRmp = await fetch(`${base}/rdp/vpgatway/vrmprovider/rms/api/listAllTodoTask`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ currentPage: 1, numPerPage: 10 }),
  });
  assert.equal(directRmp.status, 401);
  assert.equal(await directRmp.text(), '');

  const badSso = await fetch(`${base}/rdp/vpgatway/vrmprovider/rms/api/sso?page=createRequirement`, { redirect: 'manual' });
  assert.equal(badSso.status, 401);

  const ssoRes = await fetch(
    `${base}/rdp/vpgatway/vrmprovider/rms/api/sso?page=createRequirement&token=${encodeURIComponent('at-iam-bridge-sample-12345')}`,
    { redirect: 'manual' },
  );
  assert.equal(ssoRes.status, 302);
  const cookie = ssoRes.headers.get('set-cookie') ?? '';
  const m = /_tk=([^;]+)/u.exec(cookie);
  assert.ok(m, 'SSO 应签发 _tk cookie');
  const rmpHeaders = { authorization: `Bearer ${m[1]}` };

  const docsRes = await fetch(`${base}/rdp/vpgatway/vrmprovider/rms/api/listAllVerDoc`, {
    method: 'POST',
    headers: { ...rmpHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ quickSearch: '示例', currentPage: 1, numPerPage: 10 }),
  });
  assert.equal(docsRes.status, 200);
  assert.equal((await docsRes.json()).infocode, 'VP000000');

  const outlineWrongType = await fetch(`${base}/rdp/vpgatway/vrmprovider/vrm/docArt/getOutlineTree`, {
    method: 'POST',
    headers: { ...rmpHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ docId: '1' }),
  });
  assert.equal(outlineWrongType.status, 400);

  const outlineOk = await fetch(`${base}/rdp/vpgatway/vrmprovider/vrm/docArt/getOutlineTree`, {
    method: 'POST',
    headers: { ...rmpHeaders, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ selectType: '1', docId: '90001001', currentPage: '1', numPerPage: '50' }),
  });
  assert.equal(outlineOk.status, 200);
  assert.ok((await outlineOk.json()).data.length > 0);

  const tabEmpty = await fetch(
    `${base}/rdp/vpgatway/vrmprovider/vrm/docArt/getTabContent?entityid=56&iid=1&emptyContent=1`,
    { headers: rmpHeaders },
  );
  assert.equal((await tabEmpty.json()).data.html, '<p class="nodata"></p>');

  const tabNode3Empty = await fetch(
    `${base}/rdp/vpgatway/vrmprovider/vrm/docArt/getTabContent?entityid=56&iid=90002003`,
    { headers: rmpHeaders },
  );
  assert.equal((await tabNode3Empty.json()).data.html, '<p class="nodata"></p>');

  // 5.1 仿真 DOP HTML 页面（用于外链直接弹出浏览器示意，全面对齐内网真实路由）
  for (const pagePath of [
    '/dop/asd/requirement?id=a6524d93122e4aab96022254da0c05cf',
    '/dop/asd/storyDetail?id=STORY-MOCK-1004',
    '/backstage/workflow/serviceApply/applyCopyView?wjbiid=WJBI-MOCK-01',
    '/dop/asd/dashboard',
    '/rdp/',
  ]) {
    const htmlRes = await fetch(`${base}${pagePath}`);
    assert.equal(htmlRes.status, 200, `${pagePath} 应返回 200`);
    assert.match(htmlRes.headers.get('content-type') ?? '', /text\/html/u);
    const bodyText = await htmlRes.text();
    assert.ok(bodyText.includes('外网独立挡板示意页'), `${pagePath} 应含挡板提示`);
  }

  const rmpViewDocRes = await fetch(
    `${base}/rdp/vpgatway/vrmprovider/rms/api/viewDocContent?docId=90001001`,
    { redirect: 'manual' },
  );
  assert.equal(rmpViewDocRes.status, 302);
  assert.match(rmpViewDocRes.headers.get('location') ?? '', /^\/rdp\/#\/sso_login\?/u);

  // 6. 故障与空态注入
  const emptyIssues = await fetch(`${base}/asd/api/issue/myIssue/list?pageNum=1`, {
    headers: { ...dopHeaders, 'x-mock-scenario': 'empty' },
  });
  assert.deepEqual((await emptyIssues.json()).items, []);

  const rateLimited = await fetch(`${base}/asd/api/todo/list`, {
    headers: { ...dopHeaders, 'x-mock-fault': '429' },
  });
  assert.equal(rateLimited.status, 429);
  assert.equal(rateLimited.headers.get('retry-after'), '2');
});
