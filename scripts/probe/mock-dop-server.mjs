#!/usr/bin/env node
/**
 * 外网独立DOP 平台 HTTP API 挡板（测试/探针资源，严禁打入发布包）。
 *
 * 1:1 仿真内网统一网关按 Path 前缀分域的真实协议细节：
 *   - 严格仅监听 127.0.0.1，读取二次脱敏离线夹具；
 *   - DOP 域（/uam|asd|ppm|bpm|odo|tmp/api/**）：强制裸 Authorization 头（拒绝 Bearer 前缀），无效返回 403；
 *   - RMP 域（/rdp/vpgatway/**）：强制先调 /sso 换 302 _tk，再持 Bearer <_tk> 调用，无效/直透返回 401 空体；
 *   - 强校验 commonDashboard 4 个互斥布尔视角参数与 getOutlineTree 的 form-urlencoded 提交格式；
 *   - 支持 x-mock-scenario=empty 与 x-mock-fault（401/403/429/503/delay:<ms>）。
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORT = 5610;
const DEFAULT_TOKENS = Object.freeze(['mock-dop-token']);
const DEFAULT_FIXTURES_DIR = fileURLToPath(new URL('./fixtures/dop-workbench', import.meta.url));
const TK_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_FAULT_DELAY_MS = 5000;

const EXCLUSIVE_REQ_VIEWS = Object.freeze([
  'managedByMe',
  'acceptanceByMe',
  'appliedByMe',
  'participantHasMe',
]);

function loadFixtures(fixturesDir) {
  const map = new Map();
  function walk(dir, relPrefix = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, rel);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name === 'manifest.json') continue;
      const parsed = JSON.parse(readFileSync(full, 'utf8'));
      map.set(rel, parsed);
      // 同时支持按裸文件名查找子目录分域夹具（仅当不覆盖已有键时）
      if (rel !== entry.name && !map.has(entry.name)) {
        map.set(entry.name, parsed);
      }
    }
  }
  walk(fixturesDir);
  return map;
}

const clone = (value) => JSON.parse(JSON.stringify(value));

function sendJson(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(text)),
    ...extraHeaders,
  });
  res.end(text);
}

function sendEmpty(res, status, extraHeaders = {}) {
  res.writeHead(status, { 'content-length': '0', 'cache-control': 'no-store', ...extraHeaders });
  res.end();
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(Buffer.byteLength(html)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(html);
}

function escapeHtml(raw) {
  return String(raw ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderPortalPage({ title, badge, rows = [], bodyHtml = '', backTitle = 'DOP 平台 · 外网挡板示意页面' }) {
  const rowsHtml = rows
    .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`)
    .join('');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(title)} - ${escapeHtml(backTitle)}</title>
<style>
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f4f6fb;color:#1f2328}
  .notice{background:#fef3c7;color:#92400e;border-bottom:1px solid #fcd34d;padding:10px 24px;font-size:13px;font-weight:600}
  .wrap{max-width:860px;margin:24px auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:22px 26px;box-shadow:0 4px 16px rgba(15,23,42,.06)}
  .hdr{display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid #e5e7eb;padding-bottom:12px;margin-bottom:16px}
  h1{margin:0;font-size:19px}
  .badge{padding:3px 10px;border-radius:999px;background:#dbeafe;color:#1d4ed8;font-size:12px;font-weight:600}
  table{width:100%;border-collapse:collapse;margin-bottom:16px}
  th,td{padding:8px 10px;border:1px solid #e5e7eb;font-size:13px;text-align:left;vertical-align:top}
  th{width:150px;background:#f8fafc;color:#4b5563;font-weight:600}
  .section-box{background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:12px 14px;font-size:13px;line-height:1.6}
</style>
</head>
<body>
  <div class="notice">外网独立挡板示意页（mock-dop-server）：真实页面样式与 URL 对齐内网实测路径；内网环境配置 DOP 服务地址后直接跳转企业 DOP 平台。</div>
  <div class="wrap">
    <div class="hdr">
      <h1>${escapeHtml(title)}</h1>
      <span class="badge">${escapeHtml(badge)}</span>
    </div>
    <table>${rowsHtml}</table>
    ${bodyHtml ? `<div class="section-box">${bodyHtml}</div>` : ''}
  </div>
</body>
</html>`;
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('REQUEST_BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJsonSafe(raw) {
  if (!raw || raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function dopForbidden(res, fixtures, req, path) {
  if (req.headers['x-mock-dop-error-mode'] === 'text') {
    return sendText(res, 403, 'Access Denied');
  }
  const tpl = fixtures.get('auth_error_dop_403.json') ?? {
    timestamp: '2026-11-26 12:00:00',
    status: 403,
    error: 'Forbidden',
    message: 'Access Denied',
    path,
  };
  return sendJson(res, 403, { ...tpl, path });
}

function isDopDomain(pathname) {
  return /^\/(?:uam|asd|ppm|bpm|odo|tmp)\/api\//u.test(pathname);
}

function isRmpDomain(pathname) {
  return pathname.startsWith('/rdp/vpgatway/');
}

function selectByKey(mapping, value, fallbackKey) {
  const key = mapping[value] ?? fallbackKey;
  return key;
}

/**
 * 创建独立DOP 平台挡板 HTTP Server 实例（仅监听 127.0.0.1）。
 * @param {{ fixturesDir?: string, validTokens?: string[], acceptAtPrefix?: boolean, host?: string, port?: number }} [options]
 */
export function createMockDopServer(options = {}) {
  const fixturesDir = resolve(options.fixturesDir ?? DEFAULT_FIXTURES_DIR);
  const fixtures = loadFixtures(fixturesDir);
  const validTokens = new Set(
    (options.validTokens && options.validTokens.length > 0 ? options.validTokens : DEFAULT_TOKENS)
      .map((item) => item.trim())
      .filter(Boolean),
  );
  const acceptAtPrefix = Boolean(options.acceptAtPrefix);
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? DEFAULT_PORT;

  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error('mock-dop-server 只允许绑定 127.0.0.1 或 localhost');
  }

  /** 内存缓存 RMP `/sso` 签发的 `_tk` 会话，模拟 12h 有效期。 */
  const tkStore = new Map();

  const isValidRawToken = (token) => {
    if (typeof token !== 'string') return false;
    const trimmed = token.trim();
    if (trimmed.length === 0 || /^bearer\s+/iu.test(trimmed)) return false;
    if (validTokens.has(trimmed)) return true;
    return acceptAtPrefix && trimmed.startsWith('at-') && trimmed.length >= 10;
  };

  const isValidTkBearer = (authHeader) => {
    if (typeof authHeader !== 'string') return false;
    const m = /^Bearer\s+(\S+)$/u.exec(authHeader.trim());
    if (!m) return false;
    const record = tkStore.get(m[1]);
    if (!record) return false;
    if (Date.now() > record.expiresAt) {
      tkStore.delete(m[1]);
      return false;
    }
    return true;
  };

  const getFixture = (name) => {
    const data = fixtures.get(name);
    if (data === undefined) throw new Error(`Missing mock fixture: ${name}`);
    return clone(data);
  };

  const handleDopRequest = async (req, res, url, emptyScenario) => {
    if (!isValidRawToken(req.headers.authorization)) {
      return dopForbidden(res, fixtures, req, url.pathname);
    }

    const { pathname, searchParams } = url;

    if (req.method === 'GET' && pathname === '/uam/api/user/myProfile') {
      return sendJson(res, 200, getFixture('uam_myProfile.json'));
    }
    if (req.method === 'GET' && (pathname === '/uam/api/team/list' || pathname === '/uam/api/group/list')) {
      return sendJson(res, 200, []);
    }

    // --- Domain: overview（顶部 6 路 DOP 待办 + ITSM 换票） ---
    if (req.method === 'GET' && pathname === '/asd/api/todo/list') {
      return sendJson(res, 200, getFixture('todo_list.json'));
    }
    if (req.method === 'GET' && pathname === '/asd/api/issue/myIssue/list') {
      const payload = getFixture('myIssue_list.json');
      if (emptyScenario) {
        payload.items = [];
        payload.totalItems = 0;
        payload.totalPages = 0;
      }
      return sendJson(res, 200, payload);
    }
    if (req.method === 'GET' && pathname === '/odo/api/bizFlow/myTasks') {
      return sendJson(res, 200, getFixture('odo_myTasks.json'));
    }
    if (req.method === 'POST' && pathname === '/tmp/api/app/defect/myDefect/query') {
      await readBody(req);
      return sendJson(res, 200, getFixture('tmp_defect_myDefect.json'));
    }
    if (req.method === 'GET' && pathname === '/odo/api/procalmation/list') {
      const payload = getFixture('odo_procalmation.json');
      const size = Math.max(1, Number(searchParams.get('size') ?? 10) || 10);
      if (emptyScenario) {
        payload.data = [];
        payload.total = 0;
      } else if (Array.isArray(payload.data)) {
        payload.data = payload.data.slice(0, size);
      }
      return sendJson(res, 200, payload);
    }
    if (req.method === 'GET' && pathname === '/odo/api/online/process/list') {
      const payload = getFixture('odo_itsm_list.json');
      if (emptyScenario && payload.data) {
        payload.data.results = [];
        payload.data.totalRecord = 0;
      }
      return sendJson(res, 200, payload);
    }
    if (req.method === 'GET' && pathname === '/odo/api/online/process/url') {
      const wjbiid = String(searchParams.get('wjbiid') ?? '').trim();
      if (!wjbiid) {
        return sendJson(res, 400, { code: 400, data: null, message: 'Missing wjbiid', total: 0 });
      }
      const reqHost = req.headers.host || `${host}:${port}`;
      const payload = getFixture('odo_itsm_process_url.json');
      return sendJson(res, 200, {
        ...payload,
        code: 0,
        data: `http://${reqHost}/backstage/workflow/serviceApply/applyCopyView?wjbiid=${encodeURIComponent(wjbiid)}`,
      });
    }

    // --- Domain: overview（三大进展板） ---
    if (req.method === 'GET' && pathname === '/asd/api/dashboard/requirement/progress') {
      const file = selectByKey(
        { business: 'requirement_progress_business.json', manager: 'requirement_progress_manager.json' },
        searchParams.get('type'),
        'requirement_progress_manager.json',
      );
      return sendJson(res, 200, getFixture(file));
    }
    if (req.method === 'GET' && pathname === '/asd/api/dashboard/requirement/inProgress') {
      const file = selectByKey(
        { business: 'requirement_inProgress_business.json', manager: 'requirement_inProgress_manager.json' },
        searchParams.get('type'),
        'requirement_inProgress_manager.json',
      );
      return sendJson(res, 200, getFixture(file));
    }
    if (req.method === 'GET' && pathname === '/asd/api/release/progress') {
      const file = selectByKey(
        {
          responsible: 'release_progress_responsible.json',
          participate: 'release_progress_participate.json',
          creator: 'release_progress_creator.json',
        },
        searchParams.get('personnel'),
        'release_progress_responsible.json',
      );
      return sendJson(res, 200, getFixture(file));
    }
    if (req.method === 'GET' && pathname === '/asd/api/story/progress') {
      const file = selectByKey(
        {
          responsible: 'story_progress_responsible.json',
          participate: 'story_progress_participate.json',
          creator: 'story_progress_creator.json',
        },
        searchParams.get('personnel'),
        'story_progress_responsible.json',
      );
      return sendJson(res, 200, getFixture(file));
    }
    if (req.method === 'GET' && pathname === '/ppm/api/project/progress') {
      const file = selectByKey(
        {
          responsible: 'project_progress_responsible.json',
          participant: 'project_progress_participant.json',
        },
        searchParams.get('qType'),
        'project_progress_responsible.json',
      );
      return sendJson(res, 200, getFixture(file));
    }

    // --- Domain: requirement（我的需求列表 & 详情 & 故事 & 迭代 & 变更） ---
    if (req.method === 'GET' && pathname === '/asd/api/commonDashboard/requirement/query') {
      const activeViews = EXCLUSIVE_REQ_VIEWS.filter((k) => searchParams.get(k) === 'true');
      if (activeViews.length > 1) {
        return sendJson(res, 400, {
          path: pathname,
          error: 'Bad Request',
          message: `互斥视角参数最多只能启用一个，当前收到: ${activeViews.join(',')}`,
          status: 400,
        });
      }
      const useParticipant = searchParams.get('participantHasMe') === 'true';
      const payload = getFixture(
        useParticipant
          ? 'commonDashboard_requirement_participant.json'
          : 'commonDashboard_requirement_managed.json',
      );
      const search = (searchParams.get('search') ?? '').trim().toLowerCase();
      if (emptyScenario) {
        payload.items = [];
        payload.totalItems = 0;
        payload.totalPages = 0;
      } else if (search !== '' && Array.isArray(payload.items)) {
        payload.items = payload.items.filter(
          (item) =>
            String(item.requirementNo ?? '').toLowerCase().includes(search) ||
            String(item.requirementName ?? '').toLowerCase().includes(search),
        );
        payload.totalItems = payload.items.length;
      }
      return sendJson(res, 200, payload);
    }

    if (req.method === 'GET' && pathname.startsWith('/asd/api/requirement/one/')) {
      const id = pathname.slice('/asd/api/requirement/one/'.length);
      if (!id || id === 'NOPE') {
        return sendJson(res, 400, { path: pathname, error: 'Common Exception', message: '数据不存在', status: 400 });
      }
      return sendJson(res, 200, getFixture('requirement_one.json'));
    }

    if (req.method === 'GET' && (pathname.startsWith('/asd/api/story/one/') || pathname === '/asd/api/story/info')) {
      const id =
        pathname === '/asd/api/story/info'
          ? searchParams.get('code') ?? ''
          : pathname.slice('/asd/api/story/one/'.length);
      if (!id || id === 'NOPE') {
        return sendJson(res, 400, { path: '/story/info', error: 'Common Exception', message: '数据不存在', status: 400 });
      }
      return sendJson(res, 200, getFixture('story_one.json'));
    }

    if (req.method === 'GET' && pathname === '/asd/api/systemChange/info') {
      const code = searchParams.get('code') ?? '';
      if (!code || code === 'NOPE') return sendJson(res, 200, {});
      const storyOne = getFixture('story_one.json');
      return sendJson(res, 200, {
        code,
        changeType: '应用开发变更',
        team: '示例分队1',
        state: '开发中',
        summary: '示例系统变更单',
        description: '外网独立挡板提供的示例系统变更单上下文',
        userStory: storyOne,
      });
    }

    if (req.method === 'GET' && /^\/asd\/api\/sprint\/[^/]+\/issue\/list$/u.test(pathname)) {
      const payload = getFixture('sprint_issue_list.json');
      if (emptyScenario) {
        payload.items = [];
        payload.totalItems = 0;
        payload.totalPages = 0;
      }
      return sendJson(res, 200, payload);
    }

    if (req.method === 'GET' && pathname === '/asd/api/sprint/issue/list') {
      return sendJson(res, 404, {
        timestamp: '2026-11-27 12:00:00',
        status: 404,
        error: 'Not Found',
        message: 'No message available',
        path: pathname,
      });
    }

    if (req.method === 'GET' && pathname === '/asd/api/story/reqItem/query') {
      return sendJson(res, 200, getFixture('asd_story_reqItem_query.json'));
    }

    // --- Domain: phase2 reserved（项目 / 研发 / 效能 / 测试四域待采契约路由占位） ---
    return sendJson(res, 404, { error: 'Not Found', path: pathname });
  };

  const handleRmpRequest = async (req, res, url, emptyScenario) => {
    const { pathname, searchParams } = url;

    if (req.method === 'GET' && pathname === '/rdp/vpgatway/vrmprovider/rms/api/sso') {
      const ssoToken = searchParams.get('token');
      if (!isValidRawToken(ssoToken)) {
        return sendEmpty(res, 401);
      }
      const tk = `tk-${randomBytes(12).toString('hex')}`;
      tkStore.set(tk, { expiresAt: Date.now() + TK_TTL_MS });
      return sendEmpty(res, 302, {
        location: '/rdp/vpgatway/home',
        'set-cookie': `_tk=${tk}; Path=/; HttpOnly`,
      });
    }

    if (req.method === 'GET' && pathname === '/rdp/vpgatway/vrmprovider/rms/api/viewDocContent') {
      const docId = searchParams.get('docId') || searchParams.get('unitId') || 'DOC-MOCK-1001';
      return sendEmpty(res, 302, {
        location: `/rdp/#/sso_login?_tk=mock-tk-preview&href=docContent&docId=${encodeURIComponent(docId)}`,
      });
    }

    if (!isValidTkBearer(req.headers.authorization)) {
      return sendEmpty(res, 401);
    }

    if (req.method === 'POST' && pathname === '/rdp/vpgatway/vrmprovider/rms/api/listAllTodoTask') {
      await readBody(req);
      return sendJson(res, 200, getFixture('rmp_listAllTodoTask.json'));
    }

    if (
      req.method === 'POST' &&
      (pathname === '/rdp/vpgatway/vrmprovider/rms/api/listAllVerDoc' ||
        pathname === '/rdp/vpgatway/vrmprovider/rms/api/listAllNewVerDoc')
    ) {
      const body = parseJsonSafe(await readBody(req));
      if (body === null) return sendJson(res, 400, { status: 400, infocode: 'VP400001', msg: 'Invalid JSON body' });
      const file =
        pathname.endsWith('listAllNewVerDoc') ? 'rmp_listAllNewVerDoc.json' : 'rmp_listAllVerDoc.json';
      const payload = getFixture(file);
      const q = String(body.quickSearch ?? '').trim().toLowerCase();
      if (emptyScenario && payload.data) {
        payload.data.resultList = [];
        payload.data.totalRows = 0;
      } else if (q !== '' && Array.isArray(payload.data?.resultList)) {
        payload.data.resultList = payload.data.resultList.filter(
          (doc) =>
            String(doc.docname ?? '').toLowerCase().includes(q) ||
            String(doc.code ?? '').toLowerCase().includes(q),
        );
        payload.data.totalRows = payload.data.resultList.length;
      }
      return sendJson(res, 200, payload);
    }

    if (req.method === 'POST' && pathname === '/rdp/vpgatway/vrmprovider/rms/api/listRelDocByReqCode') {
      await readBody(req);
      return sendJson(res, 200, getFixture('rmp_listRelDocByReqCode.json'));
    }

    if (
      req.method === 'POST' &&
      (pathname === '/rdp/vpgatway/vrmprovider/vrm/docArt/getOutlineTree' ||
        pathname === '/rdp/vpgatway/vrmprovider/vrm/docArt/selectArtInfo')
    ) {
      const ctype = String(req.headers['content-type'] ?? '').toLowerCase();
      const raw = await readBody(req);
      if (!ctype.includes('application/x-www-form-urlencoded')) {
        return sendJson(res, 400, {
          status: 400,
          infocode: 'VP400002',
          msg: 'Must send application/x-www-form-urlencoded form body, not JSON',
        });
      }
      const form = new URLSearchParams(raw);
      if (!form.get('docId')) {
        return sendJson(res, 400, { status: 400, infocode: 'VP400003', msg: 'Missing required form field docId' });
      }
      const payload = getFixture('rmp_getOutlineTree.json');
      if (emptyScenario) payload.data = [];
      return sendJson(res, 200, payload);
    }

    if (req.method === 'GET' && pathname === '/rdp/vpgatway/vrmprovider/vrm/docArt/getTabContent') {
      const payload = getFixture('rmp_getTabContent.json');
      const iid = searchParams.get('iid') ?? '';
      if ((searchParams.get('emptyContent') === '1' || iid === '90002003') && payload.data) {
        payload.data.html = '<p class="nodata"></p>';
      } else if (iid === '90002002' && payload.data) {
        payload.data.html =
          '<p>示例需求正文（1.2 异常预警规则与通知渠道）：系统按日终数据核对指标差异，发现异常触发告警。待澄清口径：差异预警阈值（固定阈值/浮动比率）、多渠道推送组合（站内信/邮件/即时消息）及重跑去重策略。</p>';
      }
      return sendJson(res, 200, payload);
    }

    // --- Domain: phase2 reserved（项目 / 研发 / 效能 / 测试四域待采契约路由占位） ---
    return sendJson(res, 404, { error: 'Not Found', path: pathname });
  };

  const handlePortalPage = (req, res, url) => {
    const { pathname, searchParams } = url;
    if (req.method !== 'GET') return false;

    if (pathname === '/dop/asd/requirement' || pathname.startsWith('/dop/requirement/')) {
      const reqOne = getFixture('requirement_one.json');
      const rawId = pathname === '/dop/asd/requirement'
        ? (searchParams.get('id') || reqOne.id)
        : decodeURIComponent(pathname.slice('/dop/requirement/'.length) || reqOne.id);
      const html = renderPortalPage({
        title: `${reqOne.no} · ${reqOne.name}`,
        badge: `${reqOne.stage?.name ?? '实施中'} / ${reqOne.state?.name ?? '正常'}`,
        rows: [
          ['需求 ID / 编号', `${rawId} / ${reqOne.no}`],
          ['需求经理', reqOne.manager?.name ?? '--'],
          ['业务负责人', reqOne.businessOwner?.name ?? '--'],
          ['计划上线时间', reqOne.onlineDate ?? '--'],
          ['关联文档', (reqOne.reqDocs ?? []).map((d) => `${d.docName} (v${d.docVer})`).join('、') || '--'],
        ],
        bodyHtml: `<strong>业务背景</strong>${reqOne.backGround ?? ''}<strong>需求描述</strong>${reqOne.description ?? ''}`,
      });
      sendHtml(res, 200, html);
      return true;
    }

    if (pathname === '/dop/asd/storyDetail' || pathname.startsWith('/dop/story/')) {
      const st = getFixture('story_one.json');
      const rawId = pathname === '/dop/asd/storyDetail'
        ? (searchParams.get('id') || st.code)
        : decodeURIComponent(pathname.slice('/dop/story/'.length) || st.code);
      const html = renderPortalPage({
        title: `${st.code} · ${st.summary}`,
        badge: st.state?.name ?? '开发中',
        rows: [
          ['故事标识', `${rawId} / ${st.code}`],
          ['所属需求', `${st.requirement?.no ?? '--'} · ${st.requirement?.name ?? '--'}`],
          ['经办人 / 业务负责', `${st.assignee?.name ?? '--'} / ${st.businessOwner?.name ?? '--'}`],
          ['计划上线时间', st.planOnlineDate ?? '--'],
          ['关联系统变更', (st.systemChanges ?? []).map((c) => `${c.code}（${c.systemName}）`).join('、') || '暂无'],
        ],
        bodyHtml: `<strong>故事描述</strong>${st.description ?? ''}`,
      });
      sendHtml(res, 200, html);
      return true;
    }

    if (pathname.startsWith('/rdp/doc/') || pathname.startsWith('/rmp/doc/') || pathname === '/rdp/') {
      const docs = getFixture('rmp_listAllVerDoc.json');
      const outline = getFixture('rmp_getOutlineTree.json');
      const content = getFixture('rmp_getTabContent.json');
      const docId = searchParams.get('docId')
        || decodeURIComponent(pathname.replace(/^\/(?:rmp|rdp)\/doc\//u, ''))
        || docs?.data?.resultList?.[0]?.docid;
      const matched = (docs?.data?.resultList ?? []).find((d) => String(d.docid) === docId || String(d.code) === docId)
        ?? docs?.data?.resultList?.[0];
      const outlineHtml = (outline?.data ?? [])
        .map((n) => `<li><strong>${escapeHtml(n.scode)}</strong> ${escapeHtml(n.sname)}</li>`)
        .join('');
      const html = renderPortalPage({
        title: `RMP 文档 · ${matched?.docname ?? docId}`,
        badge: `${matched?.docver ?? '1.0.0'} · ${matched?.docstatus ?? '已发版'}`,
        rows: [
          ['文档编号 / ID', `${matched?.code ?? '--'} / ${docId}`],
          ['作者 / 部门', `${matched?.username ?? '--'} / ${matched?.deptname ?? '--'}`],
        ],
        bodyHtml: `<strong>大纲目录</strong><ul>${outlineHtml}</ul><strong>正文摘录</strong>${content?.data?.html ?? ''}`,
      });
      sendHtml(res, 200, html);
      return true;
    }

    if (pathname === '/backstage/workflow/serviceApply/applyCopyView' || pathname.startsWith('/odo/itsm/')) {
      const itsm = getFixture('odo_itsm_list.json');
      const id = searchParams.get('wjbiid') || decodeURIComponent(pathname.replace(/^\/odo\/itsm\//u, ''));
      const item = itsm?.data?.results?.[0] ?? {};
      const html = renderPortalPage({
        title: `ITSM 工单 · ${item.BUSINESS_ID || id || '工单详情'}`,
        badge: item.USERTASK_NAME ?? '受理中',
        rows: [
          ['WJBIID / 编号', `${id || item.WJBIID || '--'} / ${item.BUSINESS_ID || '--'}`],
          ['工单标题', item.title ?? '--'],
          ['类型 / 受理人', `${item.typeName ?? '--'} / ${item.CURRENT_ACCEPTANCEMAN_NAME ?? '--'}`],
          ['分派时间', item.ASSIGN_TIME ?? '--'],
        ],
      });
      sendHtml(res, 200, html);
      return true;
    }

    if (pathname === '/dop/asd/dashboard' || pathname === '/dop/todo') {
      const html = renderPortalPage({
        title: 'DOP 平台 · 全局工作台中心示意页',
        badge: '仪表盘与待办汇聚',
        rows: [
          ['路由确认', pathname],
          ['说明', '外网挡板示意页：内网环境将直接打开企业DOP 平台对应页面'],
        ],
      });
      sendHtml(res, 200, html);
      return true;
    }

    return false;
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${host}:${port}`);

      if (req.method === 'GET' && url.pathname === '/__mock/health') {
        return sendJson(res, 200, {
          ok: true,
          service: 'mock-dop-server',
          fixtures: fixtures.size,
        });
      }

      const fault = String(req.headers['x-mock-fault'] ?? '').trim();
      if (fault === '401') return sendEmpty(res, 401);
      if (fault === '403') return dopForbidden(res, fixtures, req, url.pathname);
      if (fault === '429') return sendJson(res, 429, { status: 429, error: 'Too Many Requests' }, { 'retry-after': '2' });
      if (fault === '503') return sendJson(res, 503, { status: 503, error: 'Service Unavailable' });
      if (fault.startsWith('delay:')) {
        const ms = Math.min(MAX_FAULT_DELAY_MS, Math.max(0, Number(fault.slice(6)) || 0));
        if (ms > 0) await new Promise((r) => setTimeout(r, ms));
      }

      const emptyScenario = req.headers['x-mock-scenario'] === 'empty';

      if (isDopDomain(url.pathname)) return await handleDopRequest(req, res, url, emptyScenario);
      if (isRmpDomain(url.pathname)) return await handleRmpRequest(req, res, url, emptyScenario);
      if (handlePortalPage(req, res, url)) return undefined;

      return sendJson(res, 404, { error: 'Not Found', path: url.pathname });
    } catch (error) {
      return sendJson(res, 500, { error: 'Mock Server Internal Error', detail: String(error?.message ?? error) });
    }
  });

  return { server, fixtures, tkStore, host, port };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const port = Number(process.env.MOCK_DOP_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('MOCK_DOP_PORT 必须是 0–65535 的整数');
  }
  const extraTokens = (process.env.MOCK_DOP_TOKEN ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const { server, fixtures } = createMockDopServer({
    port,
    validTokens: extraTokens.length > 0 ? extraTokens : DEFAULT_TOKENS,
    acceptAtPrefix: process.env.MOCK_DOP_ACCEPT_AT_PREFIX === '1',
  });
  server.listen(port, '127.0.0.1', () => {
    const addr = server.address();
    console.log(`mock-dop-server listening on http://127.0.0.1:${addr.port} (fixtures=${fixtures.size})`);
  });
}
