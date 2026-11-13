/**
 * 正式企业研发 Skill 的注册契约（r12 §4.1 / AC-1 / AC-2 / AC-3）。
 *
 * 只证明"注册与发现"这一层：provider 是否被挂上、摘要是否不带正文、按需 `get` 是否拿到正文、
 * dispose 是否只撤自己那一行、缺 Skill 服务是否安静跳过。真实宿主装配与 tarball 发现另由
 * 组合／制品测试负责，不能拿本文件替代。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  INVOCATION,
  RESOURCE_BASE,
  SKILL_PREFIX,
  apply,
  inject,
  name,
} from '../src/issue-delivery-skill.mjs';

/** 假 Skill 宿主：形状取自 `registerProvider(factory) -> disposer` + `register(entry) -> disposer`。 */
function fakeHost({ withSkills = true } = {}) {
  const providers = new Map();
  const entries = [];
  const effects = [];
  const ctx = {
    effect: (fn) => {
      effects.push(fn);
    },
  };
  if (withSkills) {
    ctx.skills = {
      registerProvider: (create) => {
        const provider = create();
        providers.set(provider.name, provider);
        return () => providers.delete(provider.name);
      },
      register: (entry) => {
        entries.push(entry);
        return () => {
          const at = entries.indexOf(entry);
          if (at >= 0) entries.splice(at, 1);
        };
      },
    };
  }
  return { ctx, providers, entries, effects };
}

test('AC-1 装载形状：name/inject/apply 与蓝图一致，且声明 skills 依赖', () => {
  assert.equal(name, 'enterprise-issue-delivery');
  assert.deepEqual([...inject], ['skills']);
  assert.equal(typeof apply, 'function');
  assert.equal(SKILL_PREFIX, 'enterprise');
});

test('AC-1 注册后可枚举：provider 只有一个，摘要带取名/用途/触发但**不含正文**', async () => {
  const host = fakeHost();
  const teardown = apply(host.ctx);
  assert.equal(typeof teardown, 'function');

  assert.deepEqual([...host.providers.keys()], [`${SKILL_PREFIX}-clauses`]);
  const provider = host.providers.get(`${SKILL_PREFIX}-clauses`);
  const list = await provider.list();
  assert.equal(list.length, 1, '随包只分发一个正式研发 Skill');
  const [summary] = list;
  assert.equal(summary.name, 'enterprise-issue-delivery');
  assert.equal(summary.provider, `${SKILL_PREFIX}-clauses`);
  assert.equal(summary.invocation.modelInvocable, false, '模型不得自行进入企业交付流程');
  assert.equal(summary.invocation.userInvocable, true, '只能由用户显式触发');
  assert.equal(typeof summary.description, 'string');
  assert.ok(summary.description.length > 0);
  assert.equal(summary.content, undefined, '发现面不得展开正文');
  assert.ok(JSON.stringify(summary).length < 1200, '摘要有界：发现面不搬正文');

  const full = await provider.get('enterprise-issue-delivery');
  assert.equal(typeof full.content, 'string');
  assert.match(full.content, /单 Issue 可信待验收交付/u);
  assert.match(full.content, /references\/handoff\.md/u, '正文必须给出按需加载指引');

  assert.equal(await provider.get('enterprise-unknown'), undefined);
});

test('AC-1 候选契约：source/rank/resourceBase 齐备，get(候选) 与 get(name) 取到同一正文', async () => {
  const host = fakeHost();
  apply(host.ctx);
  const provider = host.providers.get(`${SKILL_PREFIX}-clauses`);
  const [summary] = await provider.list();

  // 宿主 `validateCandidate` 的硬要求：少了 source/rank 连 `list()` 都会抛。
  assert.equal(summary.source, 'bundled', '随包分发的 Skill 来源是 bundled');
  assert.equal(summary.rank, 600, '与宿主 BUNDLED_SKILL_RANK 同值');
  assert.equal(summary.provider, `${SKILL_PREFIX}-clauses`);
  assert.deepEqual(summary.locator, { clause: 'issue-delivery' });
  assert.equal(summary.resourceBase.kind, 'directory');
  assert.equal(summary.resourceBase.path, join(RESOURCE_BASE, 'issue-delivery'),
    '资源根必须精确到正文所在目录，references/*.md 才解析得到');
  assert.equal(summary.path, join(RESOURCE_BASE, 'issue-delivery', 'SKILL.md'));
  assert.equal(existsSync(summary.path), true);
  assert.equal(summary.content, undefined, '候选仍是摘要，不搬正文');

  // 真实宿主把 **candidate** 交给 provider.get：按 locator.clause 命中。
  const byCandidate = await provider.get(summary);
  const byName = await provider.get('enterprise-issue-delivery');
  assert.equal(typeof byCandidate.content, 'string');
  assert.equal(byCandidate.content, byName.content);
  assert.match(byCandidate.content, /单 Issue 可信待验收交付/u);
});

test('AC-2 重复 apply 幂等：同 Context 只装配一次，不触发宿主重名错误', () => {
  const host = fakeHost();
  const first = apply(host.ctx);
  const second = apply(host.ctx); // Loader 重放同一行时真实宿主会因 provider 重名抛错
  assert.equal(second, first, '重复 apply 返回同一个 teardown');
  assert.equal(host.providers.size, 1);
  assert.equal(host.effects.length, 1, 'effect 也只登记一次');

  second();
  assert.equal(host.providers.size, 0);
  const third = apply(host.ctx); // 卸载后重新装载（同一 Context 换一条新装配）
  assert.notEqual(third, first);
  assert.equal(host.providers.size, 1);
  third();
});

test('AC-2 停用只撤自己那一行：dispose 后 provider 消失，别人注册的不受影响', async () => {
  const host = fakeHost();
  const teardown = apply(host.ctx);
  assert.equal(host.providers.size, 1);
  assert.equal(host.effects.length, 1, '清理登记在 ctx.effect 上，随 Context 销毁执行');

  teardown();
  teardown(); // 幂等：重复卸载不抛
  assert.equal(host.providers.size, 0);
  assert.equal(host.entries.length, 0);
});

test('AC-3 缺 Skill 服务：安静跳过，不抛异常、不注册半截', () => {
  const host = fakeHost({ withSkills: false });
  assert.equal(apply(host.ctx), undefined);
  assert.equal(host.providers.size, 0);
  assert.equal(apply(undefined), undefined, '空上下文不崩');
});

test('AC-1 资源根在包内：正文与两个按需材料都在随包目录里', () => {
  assert.equal(existsSync(join(RESOURCE_BASE, 'clauses.json')), true, '条款索引必须随包');
  const index = JSON.parse(readFileSync(join(RESOURCE_BASE, 'clauses.json'), 'utf8'));
  assert.equal(index.clauses.length, 1);
  const [clause] = index.clauses;
  assert.equal(clause.id, 'issue-delivery');
  assert.equal(clause.level, 'hard');
  assert.equal(clause.status, 'active');
  assert.equal(clause.body, 'issue-delivery/SKILL.md');
  assert.equal(existsSync(join(RESOURCE_BASE, clause.body)), true, '条款正文必须存在');
  for (const relative of ['issue-delivery/references/handoff.md', 'issue-delivery/references/evidence.md']) {
    assert.equal(existsSync(join(RESOURCE_BASE, relative)), true, `按需材料必须随包：${relative}`);
  }
});

test('AC-2 注册不写任何东西：apply 期间没有文件变化也没有子进程', () => {
  const before = readFileSync(join(RESOURCE_BASE, 'clauses.json'), 'utf8');
  const host = fakeHost();
  apply(host.ctx);
  const after = readFileSync(join(RESOURCE_BASE, 'clauses.json'), 'utf8');
  assert.equal(after, before, '注册不修改随包资源');
  const source = readFileSync(new URL('../src/issue-delivery-skill.mjs', import.meta.url), 'utf8');
  for (const forbidden of ['child_process', 'execFile(', 'spawn(', 'writeFileSync', 'rmSync']) {
    assert.equal(source.includes(forbidden), false, `注册入口不该出现 ${forbidden}`);
  }
});

test('AC-1 入口策略常量是冻结对象：运行期改不动', () => {
  assert.equal(Object.isFrozen(INVOCATION), true);
  assert.deepEqual({ ...INVOCATION }, { modelInvocable: false, userInvocable: true });
});
