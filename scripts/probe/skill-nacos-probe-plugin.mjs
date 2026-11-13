/**
 * #97 宿主探针插件（forge-skill-nacos）。
 *
 * 在真实 DSH 宿主进程内挂载，走公开服务验证插件行为：服务暴露、安装事务、
 * 原生目录候选、`skills/change` 失效、停用退役、作用域可见性、回收站恢复、
 * 失败分类。不用模型、不读私有字段；拟定结果写 DSH_SKILL_NACOS_PROBE_OUT。
 *
 * 前置：目标插件由同一 patch 先行 insert（顺序在探针之前），mock Nacos 与
 * 临时 `$DSH_HOME`（含 .credentials.yaml）由驱动准备并通过环境变量传入。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const name = 'forge-skill-nacos-probe';
export const inject = ['skills', 'tools', 'credentials'];

const codeOf = (error) => (error instanceof Error ? error.code ?? 'NO_CODE' : String(error));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 目标插件与本探针并行挂载：轮询等待 skillNacos 就绪（同层 apply 无顺序保证）。 */
async function waitForService(ctx, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const service = ctx.get('skillNacos');
    if (service !== undefined) return service;
    if (Date.now() >= deadline) return undefined;
    await sleep(200);
  }
}

export async function apply(ctx) {
  const out = process.env.DSH_SKILL_NACOS_PROBE_OUT;
  const projectRoot = process.env.DSH_SKILL_NACOS_PROBE_PROJECT_ROOT ?? '';
  const insideProject = process.env.DSH_SKILL_NACOS_PROBE_INSIDE ?? '';
  const outsideProject = process.env.DSH_SKILL_NACOS_PROBE_OUTSIDE ?? '';
  const checks = [];
  const check = (id, ok, detail) => checks.push({ id, ok: ok === true, ...(detail !== undefined ? { detail } : {}) });

  const service = await waitForService(ctx);
  check('service-exposed', service !== undefined && typeof service.install === 'function');

  let installed;
  if (checks[0].ok) {
    try {
      installed = await service.install({ name: 'code-review-std', ref: { version: '1.5.0' } });
      check('install-commits', installed.ok === true && installed.version === '1.5.0' && /^[0-9a-f]{64}$/.test(installed.contentSha256), {
        version: installed.version, sha: String(installed.contentSha256 ?? '').slice(0, 8),
      });
    } catch (error) {
      check('install-commits', false, { code: codeOf(error), message: error.message });
    }
  }

  if (checks[0].ok && checks.at(-1).ok) {
    const catalog = await ctx.skills.list({});
    const entry = catalog.find((skill) => skill.name === 'code-review-std');
    check('native-catalog-candidate', entry !== undefined && entry.provider === 'nacos' && entry.source === 'nacos', entry === undefined ? { catalog: catalog.map((skill) => skill.name) } : { provider: entry.provider, source: entry.source });

    const definition = await ctx.skills.get('code-review-std');
    check('native-skill-load', definition !== undefined && definition.content.includes('# 指令') && definition.resourceBase?.kind === 'directory', {
      hasContent: definition !== undefined, resourceBase: definition?.resourceBase?.kind,
    });

    let changeEvent = 0;
    ctx.on('skills/change', () => { changeEvent += 1; }); // 监听器随插件 dispose 自动清理
    await service.disable('code-review-std');
    const afterDisable = await ctx.skills.list({});
    check('disable-retires-with-event', !afterDisable.some((skill) => skill.name === 'code-review-std') && changeEvent > 0, {
      retired: !afterDisable.some((skill) => skill.name === 'code-review-std'), changeEvent,
    });
    await service.enable('code-review-std');
    check('enable-restores', (await ctx.skills.list({})).some((skill) => skill.name === 'code-review-std'));

    try {
      await service.install({ name: 'code-review-std', ref: { version: '9.9.9' } });
      check('unknown-version-rejected', false, { unexpected: 'install succeeded' });
    } catch (error) {
      check('unknown-version-rejected', codeOf(error) === 'SN_NOT_FOUND', { code: codeOf(error) });
    }
  }

  if (checks[0].ok && projectRoot.length > 0) {
    try {
      await service.install({ name: 'api-doc-gen', ref: { version: '2.0.0' }, scope: 'project', cwd: insideProject });
      const inside = await ctx.skills.list({ cwd: insideProject });
      const outside = await ctx.skills.list({ cwd: outsideProject });
      check('project-scope-visibility',
        inside.some((skill) => skill.name === 'api-doc-gen') && !outside.some((skill) => skill.name === 'api-doc-gen'),
        { inside: inside.some((skill) => skill.name === 'api-doc-gen'), outside: outside.some((skill) => skill.name === 'api-doc-gen') });

      await service.changeScope({ name: 'api-doc-gen', to: 'user' });
      check('scope-convert-user', (await ctx.skills.list({ cwd: outsideProject })).some((skill) => skill.name === 'api-doc-gen'));
    } catch (error) {
      check('project-scope-visibility', false, { code: codeOf(error), message: error.message });
      check('scope-convert-user', false, { skipped: true });
    }
  } else {
    check('project-scope-visibility', false, { reason: 'service unavailable or project root missing' });
    check('scope-convert-user', false, { skipped: true });
  }

  if (checks[0].ok) {
    try {
      const { trashId } = await service.uninstall('code-review-std');
      const absent = !(await ctx.skills.list({})).some((skill) => skill.name === 'code-review-std');
      const restored = await service.restore(trashId);
      const present = (await ctx.skills.list({})).some((skill) => skill.name === 'code-review-std');
      check('trash-restore-roundtrip', absent && restored.version === '1.5.0' && present, { absent, restoredVersion: restored.version, present });
    } catch (error) {
      check('trash-restore-roundtrip', false, { code: codeOf(error), message: error.message });
    }
  }

  const passed = checks.filter((item) => item.ok).length;
  const failed = checks.length - passed;
  const report = {
    probe: 'forge-skill-nacos',
    harness: process.env.DSH_SKILL_NACOS_PROBE_HARNESS ?? 'unknown',
    env: { node: process.version, platform: `${process.platform}-${process.arch}` },
    checks,
    passed,
    failed,
  };
  if (out !== undefined) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
}
