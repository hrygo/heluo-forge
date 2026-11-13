/**
 * 测试基座：零依赖 ZIP 写入器、仿 Nacos HTTP 服务、临时目录与宿主假件。
 */
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

/** 构造 ZIP（stored 默认；deflate 用于炸弹/方法用例；externalAttrs 用于符号链接用例）。 */
export function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8');
    const raw = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
    const method = file.method === 'deflate' ? 8 : 0;
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const externalAttrs = file.externalAttrs ?? 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 14); // crc（读取器不校验）
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 16); // crc
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra len
    central.writeUInt16LE(0, 32); // comment len
    central.writeUInt32LE(externalAttrs >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, eocd]);
}

export function skillMd({ name, description = '示例技能', version, whenToUse, body = '# 指令\n按规范执行。\n' }) {
  const lines = ['---', `name: ${name}`, `description: ${description}`];
  if (version !== undefined) lines.push(`version: ${version}`);
  if (whenToUse !== undefined) lines.push(`when-to-use: ${whenToUse}`);
  lines.push('---', '', body);
  return lines.join('\n');
}

/** 单根目录形态的技能包（`<name>/SKILL.md` + 可选资源）。 */
export function skillPackage(name, { version, description, extra = [] } = {}) {
  return buildZip([
    { path: `${name}/SKILL.md`, data: skillMd({ name, description, version }) },
    ...extra.map((file) => ({ path: `${name}/${file.path}`, data: file.data })),
  ]);
}

/**
 * 仿 Nacos：登录换 accessToken、console list/detail、client search、config 读取与 ZIP 下载。
 * `skills` 形如 [{name, description, versions:[{version,status,updateTime}], zip}]。
 * 鉴权形态与 2026-10-29 本地实测一致：POST /v3/auth/user/login（form）→ 顶层
 * `{accessToken, tokenTtl}`；后续请求带 `accessToken` 查询参数。
 */
export async function startMockNacos({ skills = [], requireAuth = true, delayMs = 0 } = {}) {
  const requests = [];
  const TOKEN = 'mock-access-token';
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push({ path: url.pathname, query: url.searchParams, body });
      const reply = (status, responseBody, headers) => {
        response.writeHead(status, headers);
        response.end(responseBody);
      };
      setTimeout(() => {
        if (url.pathname === '/v3/auth/user/login') {
          const params = new URLSearchParams(body);
          if (!requireAuth || (params.get('username') === 'nacos' && params.get('password') === 'nacos')) {
            return reply(200, JSON.stringify({ accessToken: TOKEN, tokenTtl: 18000, globalAdmin: true, username: 'nacos' }));
          }
          return reply(403, JSON.stringify({ code: 403, message: 'bad credentials' }));
        }
        if (requireAuth && url.searchParams.get('accessToken') !== TOKEN) {
          return reply(403, JSON.stringify({ code: 403, message: 'forbidden' }));
        }
        if (url.pathname === '/v3/console/ai/skills/list' || url.pathname === '/v3/client/ai/skills/search') {
          return reply(200, JSON.stringify({
            code: 0,
            message: 'success',
            data: {
              totalCount: skills.length,
              pageItems: skills.map((skill) => ({
                name: skill.name,
                description: skill.description,
                updateTime: 1,
                editingVersion: null,
                labels: { latest: skill.versions.filter((v) => v.status === 'online').at(-1)?.version ?? skill.versions[0]?.version },
              })),
            },
          }));
        }
        if (url.pathname === '/v3/console/ai/skills' && url.searchParams.get('skillName') !== null) {
          const skill = skills.find((entry) => entry.name === url.searchParams.get('skillName'));
          if (skill === undefined) return reply(200, JSON.stringify({ code: 20004, message: 'resource not found', data: `Skill not found: ${url.searchParams.get('skillName')}` }));
          return reply(200, JSON.stringify({
            code: 0,
            data: {
              name: skill.name,
              description: skill.description,
              versions: skill.versions.map((entry) => ({ version: entry.version, status: entry.status, updateTime: entry.updateTime })),
            },
          }));
        }
        if (url.pathname === '/v3/client/cs/config') {
          const index = {
            skills: skills.map((skill) => ({
              name: skill.name,
              description: skill.description,
              versions: skill.versions.map((entry) => ({ version: entry.version, status: entry.status, updateTime: entry.updateTime })),
            })),
          };
          return reply(200, JSON.stringify({ code: 0, data: JSON.stringify(index) }));
        }
        if (url.pathname === '/v3/client/ai/skills') {
          const name = url.searchParams.get('name');
          const version = url.searchParams.get('version');
          const skill = skills.find((entry) => entry.name === name);
          const entry = skill?.versions.find((candidate) => candidate.version === version);
          if (skill === undefined || entry === undefined) {
            return reply(404, JSON.stringify({ code: 404, message: 'skill not found' }));
          }
          return reply(200, entry.zip, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment;filename=${name}.zip` });
        }
        return reply(404, JSON.stringify({ code: 404, message: 'no route' }));
      }, delayMs);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** 临时 `$DSH_HOME` + 一个含 `.git` 的项目目录。 */
export async function tempHome() {
  const base = await mkdtemp(join(tmpdir(), 'skill-nacos-'));
  const projectRoot = join(base, 'project');
  await mkdir(join(projectRoot, '.git'), { recursive: true });
  await mkdir(join(projectRoot, 'src'), { recursive: true });
  await writeFile(join(projectRoot, '.git', 'config'), '[core]\n', 'utf8');
  return { base, projectRoot, insideProject: join(projectRoot, 'src'), outside: join(base, 'elsewhere') };
}

/** 宿主假件：捕获 Provider/工具注册与服务暴露，可注入既有技能目录结果。 */
export function fakeCtx({ existingSkills = [], record } = {}) {
  const state = {
    providers: [],
    tools: [],
    services: {},
    teardowns: [],
    existingSkills,
  };
  return {
    state,
    get(key) {
      if (key === 'credentials') {
        return {
          readRecord: async (id) => (id === 'skill-nacos/test-cred' ? { kind: 'grant', payload: record ?? { username: 'nacos', password: 'nacos' } } : undefined),
        };
      }
      return undefined;
    },
    provide(key, service) {
      state.services[key] = service;
      return () => {
        delete state.services[key];
      };
    },
    effect(fn) {
      state.teardowns.push(fn);
    },
    skills: {
      registerProvider(create) {
        let disposer = () => {};
        state.providers.push(create({
          signal: new AbortController().signal,
          invalidate: () => {},
        }));
        disposer = () => {
          state.providers.length = 0;
        };
        return disposer;
      },
      list: async () => state.existingSkills,
    },
    tools: {
      register(definition) {
        state.tools.push(definition);
        return () => {
          const index = state.tools.indexOf(definition);
          if (index >= 0) state.tools.splice(index, 1);
        };
      },
    },
    logger: { info() {}, warn() {} },
  };
}

export function baseConfig(endpoint, overrides = {}) {
  return {
    endpoint,
    namespaceId: 'skill-prod',
    credentialRecordId: 'test-cred',
    ...overrides,
  };
}
