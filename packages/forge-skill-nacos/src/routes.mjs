/**
 * Client 面板的 HTTP 后端（设计 §5.3"后续 Client 面板"准入项，本包落地）。
 *
 * 形态沿用 dsh-skills-manager 的 prefix 路由先例；差异：
 * - `webServer` 是**可选**服务（`ctx.get` 探测）：sdk/headless 等无 Web 宿主
 *   不注册路由，服务与工具面照常（探针依赖此行为）；
 * - 写操作直接复用 Host 服务同一判定与错误语义，页面与 agent 工具同源。
 *
 * 只读 GET：status / catalog / skill / installed；写 POST：action（install/
 * enable/disable/upgrade/uninstall/scope/restore）。同源校验拒绝跨站来源；
 * 响应统一 `{ok, result|error}`。
 */
import { REASONS, SkillNacosError } from './errors.mjs';

export const ROUTE_PREFIX = '/api/heluo/forge-skill-nacos';

/** 最小同源校验：带 Origin 头时必须与 Host 同源（防跨站写；内网部署足够，待安全复核）。 */
function assertSameOrigin(request) {
  const origin = request.headers?.origin;
  if (typeof origin !== 'string' || origin === 'null') return; // 非浏览器/同源 GET 常无 Origin
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new SkillNacosError(REASONS.FORBIDDEN, '请求 Origin 无法解析，拒绝');
  }
  const host = request.headers?.host;
  if (typeof host === 'string' && originHost !== host) {
    throw new SkillNacosError(REASONS.FORBIDDEN, `跨源请求被拒绝（Origin ${originHost} ≠ Host ${host}）`);
  }
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new SkillNacosError(REASONS.INVALID_PACKAGE, '请求体不是有效 JSON');
  }
}

/**
 * @param {{webServer?: {register?: Function}}} ctx 已注入 webServer 的子上下文
 * @param {object} service Host 服务
 * @returns {boolean} 是否注册了路由
 */
export function registerClientRoutes(ctx, service) {
  const webServer = ctx?.webServer;
  if (webServer === undefined || typeof webServer.register !== 'function') return false;

  webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname.replace(/\/+$/, '');
      const send = (status, payload) => {
        response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(payload));
      };
      try {
        assertSameOrigin(request);
        if (request.method === 'GET' && path === `${ROUTE_PREFIX}/status`) {
          return send(200, { ok: true, result: service.status() });
        }
        if (request.method === 'GET' && path === `${ROUTE_PREFIX}/catalog`) {
          const keyword = url.searchParams.get('keyword') ?? undefined;
          const page = Number(url.searchParams.get('page') ?? '1');
          const pageSize = Math.min(Number(url.searchParams.get('pageSize') ?? '20'), 20);
          return send(200, { ok: true, result: await service.searchCatalog({ keyword, page: Number.isInteger(page) && page > 0 ? page : 1, pageSize: Number.isInteger(pageSize) && pageSize > 0 ? pageSize : 20 }) });
        }
        if (request.method === 'GET' && path === `${ROUTE_PREFIX}/skill`) {
          const name = url.searchParams.get('name') ?? '';
          if (name.length === 0) throw new SkillNacosError(REASONS.NOT_FOUND, '缺少 name 参数');
          return send(200, { ok: true, result: await service.showSkill(name) });
        }
        if (request.method === 'GET' && path === `${ROUTE_PREFIX}/installed`) {
          return send(200, { ok: true, result: { items: service.listInstalled(), trash: [] } });
        }
        if (request.method === 'GET' && path === `${ROUTE_PREFIX}/trash`) {
          return send(200, { ok: true, result: { items: service.listTrash ? service.listTrash() : [] } });
        }
        if (request.method === 'GET' && path === `${ROUTE_PREFIX}/settings`) {
          return send(200, { ok: true, result: service.getSettings() });
        }
        if (request.method === 'POST' && path === `${ROUTE_PREFIX}/settings`) {
          const body = await readJsonBody(request);
          return send(200, { ok: true, result: await service.updateSettings(body) });
        }
        if (request.method === 'POST' && path === `${ROUTE_PREFIX}/action`) {
          const body = await readJsonBody(request);
          return send(200, { ok: true, result: await runAction(service, body) });
        }
        return send(404, { ok: false, error: `无此路由：${request.method} ${path}` });
      } catch (error) {
        // 服务层错误原样透传（含 SN_* 分类）；未知错误归一为 NETWORK，不把堆栈泄给页面。
        const known = typeof error?.code === 'string' && error.code.startsWith('SN_')
          ? error.code
          : error instanceof SkillNacosError ? error.code : REASONS.NETWORK;
        return send(known === REASONS.FORBIDDEN || known === REASONS.AUTH_MISSING ? 403 : 400, {
          ok: false,
          code: known,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });
  return true;
}

async function runAction(service, body) {
  switch (body?.op) {
    case 'install':
      return service.install({
        name: String(body.name ?? ''),
        ref: typeof body.version === 'string' && body.version.length > 0 ? { version: body.version } : undefined,
        scope: body.scope === 'project' ? 'project' : 'user',
        enable: body.enable !== false,
      });
    case 'upgrade':
      return service.upgrade({ name: String(body.name ?? ''), ref: typeof body.version === 'string' && body.version.length > 0 ? { version: body.version } : undefined });
    case 'enable':
      return service.enable(String(body.name ?? ''));
    case 'disable':
      return service.disable(String(body.name ?? ''));
    case 'uninstall':
      return service.uninstall(String(body.name ?? ''));
    case 'restore':
      return service.restore(String(body.name ?? ''));
    case 'purge':
      return service.purge(String(body.name ?? ''));
    case 'scope':
      return service.changeScope({ name: String(body.name ?? ''), to: body.to === 'project' ? 'project' : 'user' });
    default:
      throw new SkillNacosError(REASONS.INVALID_PACKAGE, `未知操作 ${String(body?.op)}`);
  }
}
