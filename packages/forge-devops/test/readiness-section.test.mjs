/**
 * ReadinessSection 的行为用例（DESIGN §3：七行收敛为两条固定行）。
 *
 * 断言的是**渲染出来的文本**：摘要行、两条固定行、按成员分组的详情、检查四项与四层证据
 * 都必须真的在屏上，而不是只在状态对象里。夹具按请求顺序喂三源，检查/刷新各多一次请求。
 *
 * 主列表（`.fdv-row-state`）只允许「主状态 · 说明」：原因、三层来源、插件与版本都收进详情。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deferred, loadClient, mountReadiness } from './support/readiness-harness.mjs';

const CLIENT_FILE = fileURLToPath(new URL('../client.js', import.meta.url));

const ROW_LABELS = ['身份与 Key', '本机工具'];

function ok(body) {
  return { status: 200, body };
}

function status(code, body = null) {
  return { status: code, body };
}

function readinessView(overrides = {}) {
  return {
    contract: 1,
    object: 'devops',
    at: '2026-11-06T04:00:00.000Z',
    revision: 'rev-abcdef1234567890',
    sourceType: 'local-diagnostic',
    plugin: { name: '@heluo/forge-devops', version: '0.1.0' },
    layers: { inherited: ['dopBin', 'timeoutMs'], override: ['dopBin'], missing: [] },
    evidence: [
      { id: 'file', state: 'pass', reason: null, basis: 'filesystem-stat' },
      { id: 'executable', state: 'pass', reason: null, basis: 'filesystem-stat' },
      { id: 'target', state: 'pass', reason: null, basis: 'config-shape' },
      { id: 'readonly', state: 'pass', reason: null, basis: 'policy-admission' },
    ],
    verdict: 'pass',
    blockedBy: null,
    reason: null,
    ...overrides,
  };
}

function devopsSnapshot(overrides = {}) {
  return {
    revision: 'rev-abcdef1234567890',
    ready: true,
    plugin: { name: '@heluo/forge-devops', version: '0.1.0' },
    layers: { inherited: ['dopBin', 'timeoutMs'], override: ['dopBin'], missing: [] },
    entries: {
      dopBin: { origin: 'config', path: 'C:/tools/dop.exe' },
      dopEndpoint: { origin: 'default', value: 'https://dop.example' },
      sourceType: { origin: 'default', value: 'enterprise' },
      timeoutMs: { origin: 'default', value: 20000 },
    },
    readiness: readinessView(),
    ...overrides,
  };
}

function iamBody(overrides = {}) {
  return {
    state: 'ready',
    accessExpiresAt: '2026-11-06T12:00:00.000Z',
    gatewayCredential: { state: 'configured', matchesAccount: true },
    modelAccess: { state: 'ready' },
    ...overrides,
  };
}

function giteeBody(overrides = {}) {
  return {
    revision: 'rev-gitee-12345678',
    ready: true,
    plugin: { name: '@heluo/forge-gitee', version: '0.1.0' },
    entries: {
      owner: { inherited: 'corp', override: null },
      repo: { inherited: null, override: 'demo' },
    },
    ...overrides,
  };
}

function three({ iam = ok(iamBody()), devops = ok(devopsSnapshot()), gitee = ok(giteeBody()) } = {}) {
  return [iam, devops, gitee];
}

function segments(page) {
  const rows = page.rows();
  assert.equal(rows.length, 2, `期望两行，实际 ${rows.length}：${page.text()}`);
  rows.forEach((row, index) => {
    assert.ok(row.startsWith(ROW_LABELS[index]), `第 ${index + 1} 行应为「${ROW_LABELS[index]}」：${row}`);
  });
  return {
    identity: page.rowState('identity'),
    tools: page.rowState('tools'),
    identityDetail: page.rowDetail('identity'),
    toolsDetail: page.rowDetail('tools'),
  };
}

async function mount(t, options = {}) {
  const page = await mountReadiness(options);
  t.after(() => page.unmount());
  return page;
}

test('两条固定行：身份与 Key、本机工具；摘要行与一句页脚恒在场', async (t) => {
  const page = await mount(t, { responses: three() });
  const rows = page.rows();
  assert.equal(rows.length, 2, `期望两行，实际 ${rows.length}：${page.text()}`);
  rows.forEach((row, index) => {
    assert.ok(row.startsWith(ROW_LABELS[index]), `第 ${index + 1} 行应为「${ROW_LABELS[index]}」：${row}`);
  });
  assert.match(page.rowState('identity'), /^已登录 · Key 已验证$/u);
  assert.match(page.rowState('tools'), /^已配置 · dop 已找到 · Gitee 已配置$/u);

  assert.ok(page.text().includes('✅ 可以开始'), '全部就绪时摘要行是「✅ 可以开始」');
  assert.ok(
    page.text().includes('本页只显示本机可见性，不代表业务授权。公共参数由企业分发；写权限由企业侧判定，本页不判断。'),
    '页脚只留一句统一声明',
  );
  assert.equal(page.text().split('不代表业务授权').length - 1, 1, '免责声明每页只能出现一次');

  // 公共参数 / 写权限不占行，只出现在各自组的详情里。
  const identityDetail = page.rowDetail('identity');
  assert.ok(identityDetail.startsWith('详情公共参数：企业分发，本机不可改'), identityDetail);
  const toolsDetail = page.rowDetail('tools');
  assert.ok(toolsDetail.endsWith('写权限：由企业侧判定，本页不判断'), toolsDetail);
  assert.equal(page.findAll('详情').length, 2, '每条固定行各有一个详情入口');
});

test('四组反例只改自己那一组，另一组逐字不变', async (t) => {
  const baseline = segments(await mount(t, { responses: three() }));

  // ① IAM 404 → 身份组「未安装」，本机工具组不动。
  const missing = segments(await mount(t, { responses: three({ iam: status(404) }) }));
  assert.match(missing.identity, /^未安装 · 账号插件未安装$/u);
  assert.equal(missing.tools, baseline.tools);

  // ② IAM 不可达 → 身份组「不可达」且给出重试文案；Key 只能显示「无法判定」，不写裸「未知」。
  const unreachable = segments(await mount(t, { responses: three({ iam: { status: 0, body: null, networkError: true } }) }));
  assert.match(unreachable.identity, /^不可达 · 无法判定$/u);
  assert.ok(unreachable.identityDetail.includes('账号服务不可达，请稍后重试'), '重试文案在身份组详情里');
  assert.equal(unreachable.tools, baseline.tools);

  // ③ 未列出的 state=error → 「退出未确认」，不是「未知」也不是「未登录」。
  const unknown = segments(await mount(t, { responses: three({ iam: ok(iamBody({ state: 'error' })) }) }));
  assert.match(unknown.identity, /^退出未确认/u);
  assert.ok(!unknown.identity.includes('未登录'));
  assert.ok(!unknown.identity.includes('未知'));
  assert.equal(unknown.tools, baseline.tools);

  // ④ Key 已配置但凭据不属于本账号 → 说明位「Key 未验证」，原因在详情里，工具组不动。
  const mismatch = segments(await mount(t, {
    responses: three({ iam: ok(iamBody({ gatewayCredential: { state: 'configured', matchesAccount: false } })) }),
  }));
  assert.match(mismatch.identity, /^已登录 · Key 未验证$/u);
  assert.ok(mismatch.identityDetail.includes('凭据属于其他账号'), '原因在详情里');
  assert.equal(mismatch.tools, baseline.tools);
});

test('Key 五态映射到说明位：未配置个人 Key / Key 已验证 / Key 未验证 / 账号插件未安装 / 无法判定', async (t) => {
  const cases = [
    ['unconfigured', ok(iamBody({ gatewayCredential: { state: 'unconfigured' } })), /^已登录 · 未配置个人 Key$/u, '尚未写入网关凭据'],
    ['verified', ok(iamBody()), /^已登录 · Key 已验证$/u, null],
    ['model-not-ready', ok(iamBody({ modelAccess: { state: 'error' } })), /^已登录 · Key 未验证$/u, '模型访问未就绪'],
    ['owner-mismatch', ok(iamBody({ gatewayCredential: { state: 'configured', matchesAccount: false } })), /^已登录 · Key 未验证$/u, '凭据属于其他账号'],
    ['not-installed', status(404), /^未安装 · 账号插件未安装$/u, '账号插件未安装'],
    ['credential-absent', ok(iamBody({ gatewayCredential: undefined })), /^已登录 · 无法判定$/u, '无法判定'],
  ];
  for (const [name, iam, expected, reason] of cases) {
    const page = await mount(t, { responses: three({ iam }) });
    assert.match(page.rowState('identity'), expected, `${name} 的说明位`);
    if (reason) assert.ok(page.text().includes(reason), `${name} 的原因文案（详情里）`);
  }
});

test('身份六态各配一条下一步，unreachable 的重试真的重新发起三源读取', async (t) => {
  const cases = [
    ['ready', '身份已就绪，可继续核对网关 Key'],
    ['signed-out', '前往企业账号登录'],
    ['authenticating', '返回账号页等待登录完成'],
    ['expired', '登录已过期，需要重新登录'],
    ['unconfigured', '前往企业账号登录'],
  ];
  for (const [state, next] of cases) {
    const page = await mount(t, { responses: three({ iam: ok(iamBody({ state })) }) });
    assert.ok(page.text().includes(next), `${state} 的下一步`);
  }

  const page = await mount(t, {
    responses: [
      ...three({ iam: { status: 0, body: null, networkError: true } }),
      ...three(),
    ],
  });
  assert.match(page.rowState('identity'), /^不可达/u);
  assert.equal(page.calls.length, 3);
  await page.click('刷新', 0);
  assert.equal(page.calls.length, 6, '重试必须重新发起三源读取');
  assert.match(page.rowState('identity'), /^已登录 · Key 已验证$/u);
});

test('导航：注入 navigate 才有一个「前往企业账号」按钮，点击收到 forge-iam', async (t) => {
  const received = [];
  const page = await mount(t, { responses: three(), props: { navigate: (id) => received.push(id) } });
  assert.equal(page.buttons('前往企业账号').length, 1);
  await page.click('前往企业账号');
  assert.deepEqual(received, ['forge-iam']);

  const degraded = await mount(t, { responses: three() });
  assert.equal(degraded.buttons('前往企业账号').length, 0, '探测不到导航能力时不得渲染无响应按钮');
  assert.ok(degraded.text().includes('设置 → 企业账号'));
});

test('迟到的 IAM 回包整包丢弃：最后落地的是最新一次读取', async (t) => {
  const second = [deferred(), deferred(), deferred()];
  const third = [deferred(), deferred(), deferred()];
  const page = await mount(t, {
    responses: [...three(), ...second.map((entry) => entry.promise), ...third.map((entry) => entry.promise)],
  });
  const baseline = segments(page);

  await page.click('刷新', 0);
  await page.click('刷新', 0);

  third[0].resolve(ok(iamBody()));
  third[1].resolve(ok(devopsSnapshot()));
  third[2].resolve(ok(giteeBody()));
  await page.flush();
  assert.match(page.rowState('identity'), /^已登录 · Key 已验证$/u);

  second[0].resolve(ok(iamBody({ state: 'signed-out', gatewayCredential: { state: 'unconfigured' } })));
  second[1].resolve(ok(devopsSnapshot()));
  second[2].resolve(ok(giteeBody()));
  await page.flush();

  const after = segments(page);
  assert.equal(after.identity, '已登录 · Key 已验证', '旧回包不得把身份改回未登录');
  assert.equal(after.tools, baseline.tools, '旧回包不得改动本机工具组');
});

test('检查：只多一次请求且只有它带 ?refresh=1，verdict 四态各渲染对应状态词', async (t) => {
  const view = readinessView();
  const cases = [
    ['pass', view, '检查：通过'],
    ['fail', readinessView({
      evidence: [
        { id: 'file', state: 'pass', reason: null, basis: 'filesystem-stat' },
        { id: 'executable', state: 'pass', reason: null, basis: 'filesystem-stat' },
        { id: 'target', state: 'pass', reason: null, basis: 'config-shape' },
        { id: 'readonly', state: 'fail', reason: 'policy-denied', basis: 'policy-admission' },
      ],
      verdict: 'fail',
      blockedBy: 'readonly',
      reason: 'policy-denied',
    }), '检查：失败 · 策略拒绝只读 · '],
    ['incomplete', readinessView({
      evidence: [
        { id: 'file', state: 'pass', reason: null, basis: 'filesystem-stat' },
        { id: 'executable', state: 'pass', reason: null, basis: 'filesystem-stat' },
        { id: 'target', state: 'not-run', reason: 'confirmation-required', basis: null },
        { id: 'readonly', state: 'pass', reason: null, basis: 'policy-admission' },
      ],
      verdict: 'incomplete',
      blockedBy: 'target',
      reason: 'confirmation-required',
    }), '检查：未知 · 需要确认 · '],
  ];
  for (const [name, checked, expected] of cases) {
    const page = await mount(t, {
      responses: [...three(), ok(devopsSnapshot({ readiness: checked }))],
    });
    assert.equal(page.calls.length, 3);
    await page.click('检查 DevOps');
    assert.equal(page.calls.length, 4, `${name}：检查只发一次请求`);
    assert.ok(page.calls[3].url.includes('?refresh=1'), `${name}：检查必须带 refresh=1`);
    assert.ok(page.text().includes(expected), `${name}：${expected}`);
  }

  const bare = await mount(t, { responses: [...three(), ok(devopsSnapshot({ readiness: undefined }))] });
  await bare.click('检查 DevOps');
  assert.ok(bare.text().includes('检查：未知 · 无可复核证据'), '没有 readiness 视图时结果必须是未知 + 无可复核证据');
});

test('检查四项上屏：基准前 8 位 / 时间 / 对象 / 来源类型，revision 缺失显示未知', async (t) => {
  const page = await mount(t, { responses: [...three(), ok(devopsSnapshot())] });
  await page.click('检查 DevOps');
  const text = page.text();
  assert.ok(text.includes('基准rev-abcd'), text);
  assert.match(text, /检查时间\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/u);
  assert.ok(text.includes('对象DevOps'));
  assert.ok(text.includes('来源类型本地诊断'));

  const unknown = await mount(t, {
    responses: [...three(), ok(devopsSnapshot({ revision: null, readiness: readinessView({ revision: null }) }))],
  });
  await unknown.click('检查 DevOps');
  assert.ok(unknown.text().includes('基准未知'), 'revision 缺失时基准显示未知');
});

test('四层证据：固定四行、顺序固定，fail/not-run 带原因，pass 带依据', async (t) => {
  const evidence = [
    { id: 'file', state: 'pass', reason: null, basis: 'filesystem-stat' },
    { id: 'executable', state: 'fail', reason: 'not-executable', basis: 'filesystem-stat' },
    { id: 'target', state: 'not-run', reason: 'path-resolution-required', basis: null },
    { id: 'readonly', state: 'not-run', reason: 'no-evidence', basis: null },
  ];
  const page = await mount(t, {
    responses: [...three(), ok(devopsSnapshot({ readiness: readinessView({ evidence, verdict: 'fail', blockedBy: 'executable', reason: 'not-executable' }) }))],
  });
  await page.click('检查 DevOps');
  const text = page.text();
  const order = ['文件存在', '可启动', '目标可识别', '只读可访问'].map((label) => text.lastIndexOf(label));
  assert.deepEqual(order, order.slice().sort((a, b) => a - b), '四层顺序固定');
  assert.ok(text.includes('文件存在通过文件系统只读探测'));
  assert.ok(text.includes('可启动未通过入口不可执行'));
  assert.ok(text.includes('目标可识别未执行需要可解析的完整路径'));
  assert.ok(text.includes('只读可访问未执行无可复核证据'));

  const short = await mount(t, {
    responses: [...three(), ok(devopsSnapshot({ readiness: readinessView({ evidence: [{ id: 'file', state: 'pass', reason: null, basis: 'filesystem-stat' }] }) }))],
  });
  await short.click('检查 DevOps');
  assert.ok(short.text().includes('可启动未执行无可复核证据'), '证据缺项必须降级为未执行 + NO_EVIDENCE');
});

test('过期：devops 基准换掉后标「已过期」并保留旧四项与旧时间', async (t) => {
  const page = await mount(t, {
    responses: [
      ...three(),
      ok(devopsSnapshot()),
      ...three({ devops: ok(devopsSnapshot({ revision: 'rev-22222222aaaaaaaa' })) }),
    ],
  });
  await page.click('检查 DevOps');
  const time = page.text().match(/检查时间(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/u)[1];
  assert.ok(page.text().includes('检查：通过'));

  await page.click('刷新', 0);
  const text = page.text();
  assert.ok(text.includes('已过期'), '基准不一致必须标已过期');
  assert.ok(text.includes('rev-abcd'), '保留旧基准');
  assert.ok(text.includes(time), '保留旧检查时间');
});

test('迟到的检查回包被丢弃：界面等于最后一次检查', async (t) => {
  const slow = deferred();
  const fast = deferred();
  const page = await mount(t, {
    responses: [...three(), slow.promise, fast.promise],
  });
  const check = page.buttons('检查 DevOps')[0];
  check.props.onClick();
  check.props.onClick();
  fast.resolve(ok(devopsSnapshot()));
  await page.flush();
  slow.resolve(ok(devopsSnapshot({ readiness: readinessView({ verdict: 'fail', blockedBy: 'readonly', reason: 'policy-denied' }) })));
  await page.flush();
  assert.ok(page.text().includes('检查：通过'));
  assert.ok(!page.text().includes('检查：失败'), '旧检查回包不得复活');
});

test('Gitee 禁用按钮在工具行，原因在详情，且不发起第二次 Gitee 请求', async (t) => {
  const page = await mount(t, { responses: three() });
  const button = page.button('检查 Gitee');
  assert.equal(button.props.disabled, true, 'Gitee 检查按钮必须禁用');
  assert.equal(button.props.title, '未执行 · 未获批准的只读探测，本页不发起请求');
  assert.ok(page.text().includes('未执行 · 未获批准的只读探测，本页不发起请求'));
  assert.equal(page.calls.length, 3);
  assert.equal(page.calls.filter((call) => call.url.includes('/api/forge-gitee/config')).length, 1);
});

test('检查与刷新都不写配置：全程只有 GET，没有 POST', async (t) => {
  const page = await mount(t, { responses: [...three(), ok(devopsSnapshot()), ...three()] });
  await page.click('检查 DevOps');
  await page.click('刷新', 0);
  for (const call of page.calls) {
    assert.ok(call.init.method === undefined || call.init.method === 'GET', `只允许 GET：${call.url}`);
  }
});

test('三层来源：收进工具组详情，devops 三段齐全，缺 layers 显示未知与原因，Gitee 由 entries 投影', async (t) => {
  const page = await mount(t, { responses: three() });
  const text = page.text();
  assert.ok(text.includes('生效来源dopBin: 配置、dopEndpoint: 默认、sourceType: 默认、timeoutMs: 默认'));
  assert.ok(text.includes('公共参数dopBin、timeoutMs'));
  assert.ok(text.includes('本机覆盖dopBin'));
  assert.ok(text.includes('最终生效dopBin、timeoutMs · rev-abcd'));
  assert.ok(text.includes('公共参数owner'), 'Gitee inherited 投影');
  assert.ok(text.includes('本机覆盖repo'), 'Gitee override 投影');
  assert.ok(text.includes('@heluo/forge-devops · 0.1.0'));
  assert.ok(page.rowDetail('tools').includes('生效来源'), '来源只在详情里，不在主列表');

  const bare = await mount(t, {
    responses: three({ devops: ok(devopsSnapshot({ layers: undefined })) }),
  });
  assert.ok(bare.text().includes('无法读取条目，三层来源未知'));
});

test('详情承接原先的固定声明与死键：detail.public / detail.write / loading / failed，draftWarning 已删除', async (t) => {
  const ready = await mount(t, { responses: three() });
  assert.ok(ready.text().includes('公共参数：企业分发，本机不可改'));
  assert.ok(ready.text().includes('写权限：由企业侧判定，本页不判断'));

  const loading = await mount(t, { responses: [deferred().promise, deferred().promise, deferred().promise] });
  assert.ok(loading.text().includes('正在读取…'));

  const failed = await mount(t, {
    responses: [
      ...three(),
      { status: 0, body: null, networkError: true },
      { status: 0, body: null, networkError: true },
      { status: 0, body: null, networkError: true },
    ],
  });
  await failed.click('刷新', 0);
  assert.ok(failed.text().includes('无法读取（不可达）'), failed.text());

  const source = readFileSync(CLIENT_FILE, 'utf8');
  assert.ok(!source.includes('draftWarning'), 'draftWarning 必须已删除');
});

test('摘要行随待处理项变化：0 项 ✅ 可以开始 / 1 项用该行说明 / ≥2 项先处理身份与 Key', async (t) => {
  const ready = await mount(t, { responses: three() });
  assert.ok(ready.text().includes('✅ 可以开始'));

  const single = await mount(t, {
    responses: three({ iam: ok(iamBody({ gatewayCredential: { state: 'unconfigured' } })) }),
  });
  assert.ok(single.text().includes('1 项待处理 · 未配置个人 Key'), single.text());

  const two = await mount(t, {
    responses: three({ iam: ok(iamBody({ state: 'signed-out', gatewayCredential: { state: 'unconfigured' } })) }),
  });
  assert.ok(two.text().includes('2 项待处理 · 先处理身份与 Key'), two.text());

  const toolsOnly = await mount(t, { responses: three({ devops: ok(devopsSnapshot({ ready: false })) }) });
  assert.ok(toolsOnly.text().includes('1 项待处理 · dop 未找到'), toolsOnly.text());
});

test('主列表不出现裸「未知」：异常态都给具体说明', async (t) => {
  const cases = [
    status(404),
    ok(iamBody({ state: 'error' })),
    ok(iamBody({ gatewayCredential: undefined })),
    { status: 0, body: null, networkError: true },
  ];
  for (const iam of cases) {
    const page = await mount(t, { responses: three({ iam }) });
    for (const group of ['identity', 'tools']) {
      assert.ok(!page.rowState(group).includes('未知'), `${group} 行出现裸「未知」：${page.rowState(group)}`);
    }
  }
  const bareDevops = await mount(t, { responses: three({ devops: { status: 0, body: null, networkError: true } }) });
  assert.ok(!bareDevops.rowState('tools').includes('未知'), bareDevops.rowState('tools'));
});

test('zh/en 字典键集等值（readiness 前缀单独比）', () => {
  const source = readFileSync(CLIENT_FILE, 'utf8');
  const block = (name) => {
    const start = source.indexOf(`const ${name} = {`);
    assert.ok(start >= 0, `找不到 ${name} 字典`);
    return source.slice(start, source.indexOf('\n    });', start));
  };
  const keysOf = (text) => new Set([...text.matchAll(/'([A-Za-z0-9_.-]+)':/gu)].map((match) => match[1]));
  const zh = keysOf(block('zh'));
  const en = keysOf(block('en'));
  assert.deepEqual([...zh].sort(), [...en].sort(), 'zh/en 键集必须完全一致');
  const readinessOf = (set) => [...set].filter((key) => key.startsWith('readiness.')).sort();
  assert.ok(readinessOf(zh).length >= 70, `readiness 键过少：${readinessOf(zh).length}`);
  assert.deepEqual(readinessOf(zh), readinessOf(en));
});

test('未引用 readiness 键计数为 0：每个字面键都在源码其余位置出现一次', () => {
  const source = readFileSync(CLIENT_FILE, 'utf8');
  const body = source
    .split('\n')
    .filter((line) => !/^\s*'readiness\.[A-Za-z0-9.-]+':/u.test(line))
    .join('\n');
  const keys = [...source.matchAll(/'readiness\.([A-Za-z0-9.-]+)':/gu)].map((match) => match[1]);
  const dynamicPrefixes = [
    'state.', 'reason.', 'row.', 'evidence.reason.', 'evidence.layer.', 'evidence.state.', 'evidence.basis.',
    'check.sourceType.', 'layers.reason.', 'origin.', 'key.reason.', 'next.',
  ];
  const unused = keys.filter((key) => {
    if (dynamicPrefixes.some((prefix) => key.startsWith(prefix))) return false;
    return !body.includes(`'readiness.${key}'`);
  });
  assert.deepEqual(unused, [], `未引用的 readiness 键：${unused.join(', ')}`);
});

test('脱敏：渲染文本不含绝对路径、http、sk-、eyJ、邮箱', async (t) => {
  const page = await mount(t, { responses: [...three(), ok(devopsSnapshot())] });
  await page.click('检查 DevOps');
  const text = page.text().replaceAll('@heluo/forge-devops', '').replaceAll('@heluo/forge-gitee', '');
  assert.ok(!/https?:/u.test(text), '不得出现 http 地址');
  assert.ok(!/(^|\s)\/[A-Za-z]/u.test(text), '不得出现 POSIX 绝对路径');
  assert.ok(!/[A-Za-z]:\\/u.test(text), '不得出现盘符路径');
  assert.ok(!text.includes('sk-') && !text.includes('eyJ'), '不得出现凭据前缀');
  assert.ok(!text.includes('@'), '不得出现邮箱/账号标识');
});

test('「企业联调已通过」在客户端源码出现 0 次', () => {
  const source = readFileSync(CLIENT_FILE, 'utf8');
  assert.equal(source.includes('企业联调已通过'), false);
});

test('D-1 未检查态用自己的词：「检查：未检查」，不与证据的「未执行」同词', async (t) => {
  const page = await mount(t, { responses: three() });
  const text = page.text();
  assert.ok(text.includes('检查：未检查'), `未检查态必须渲染「检查：未检查」，实际：${text}`);
  assert.equal(text.includes('检查：未执行'), false, '未检查不得复用检查结果的「未执行」');

  const checked = await mount(t, {
    responses: [...three(), ok(devopsSnapshot({
      readiness: readinessView({
        evidence: [
          { id: 'file', state: 'pass', reason: null, basis: 'filesystem-stat' },
          { id: 'executable', state: 'pass', reason: null, basis: 'filesystem-stat' },
          { id: 'target', state: 'not-run', reason: 'confirmation-required', basis: null },
          { id: 'readonly', state: 'not-run', reason: 'no-evidence', basis: null },
        ],
        verdict: 'incomplete',
        blockedBy: 'target',
        reason: 'confirmation-required',
      }),
    }))],
  });
  await checked.click('检查 DevOps');
  assert.ok(checked.text().includes('未执行'), '四层证据的 not-run 仍用「未执行」');
});

test('D-2 身份不可达：重试之外同时给出账号页文字入口，不出现无响应按钮', async (t) => {
  const page = await mount(t, {
    responses: three({ iam: { status: 0, body: null, networkError: true } }),
  });
  const text = page.text();
  assert.match(page.rowState('identity'), /^不可达/u);
  assert.ok(text.includes('账号服务不可达'), '不可达态必须保留重试文案');
  assert.ok(text.includes('设置 → 企业账号'), '不可达态必须给出账号页文字入口');
  assert.equal(page.buttons('前往企业账号').length, 0, '探测不到导航能力时不得渲染无响应按钮');
  assert.equal(page.buttons('刷新').length >= 1, true, '重试按钮仍在');
});

test('状态标签必须有字：所有 .fdv-tag 的屏上文本非空', async (t) => {
  const page = await mount(t, {
    responses: three({ iam: { status: 0, body: null, networkError: true } }),
  });
  // 夹具是裸元素树：`h(Tag, …, 状态词)` 里 Tag 仍是函数，children 挂在元素而不在 props。
  // 所以按真实 React 的调用约定把 children 塞回 props 再调用一次，才能看出标签有没有字。
  const textOf = (node) => {
    if (node === null || node === undefined || node === false) return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(textOf).join('');
    return (node.children ?? []).map(textOf).join('');
  };
  const tags = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const child of node) walk(child); return; }
    if (typeof node.type === 'function' && node.type.name === 'Tag') {
      tags.push(textOf(node.type({ ...node.props, children: node.children })));
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(page.tree());
  assert.ok(tags.length > 0, '面板必须渲染状态标签');
  for (const label of tags) {
    assert.ok(label.length > 0, '状态标签在屏上是空块：Tag 只读了 props.text，没用 children');
  }
});

test('P2 交错：刷新先发、检查后回、刷新再回，结论不得对着另一代读面显示通过', async (t) => {
  // 复核意见 5822026563 ①：load() 用请求发起时的 check 闭包比较基准，
  // 刷新与检查交错时旧结论不会过期。这里让检查先落地、更早发出的刷新后落地。
  const refresh = [deferred(), deferred(), deferred()];
  const check = deferred();
  const page = await mount(t, {
    responses: [
      ...three(),
      refresh[0].promise,
      refresh[1].promise,
      refresh[2].promise,
      check.promise,
    ],
  });

  await page.click('刷新', 0); // 刷新在途（本次请求发出时还没有检查结论）
  await page.click('检查 DevOps'); // 刷新未回时检查仍可点
  check.resolve(ok(devopsSnapshot({ revision: 'rev-aaaaaaaa11111111' })));
  await page.flush();
  assert.ok(page.text().includes('检查：通过'));

  // 刷新回包带的是更早一代的读面（rev-bbbb…），不得把读面退回旧代、也不得让结论与读面错代。
  refresh[0].resolve(ok(iamBody()));
  refresh[1].resolve(ok(devopsSnapshot({ revision: 'rev-bbbbbbbb22222222' })));
  refresh[2].resolve(ok(giteeBody()));
  await page.flush();

  const text = page.text();
  assert.ok(text.includes('检查：通过'), text);
  assert.ok(text.includes('基准rev-aaaa'), text);
  assert.ok(text.includes('最终生效dopBin、timeoutMs · rev-aaaa'), `读面应保留检查重建的那一代：${page.rowDetail('tools')}`);
  assert.ok(!text.includes('rev-bbbb'), '更早发出的刷新回包不得把读面退回旧代');
});

test('P2 来源同步：检查成功即更新汇总与来源快照，不需要再点一次刷新', async (t) => {
  // 复核意见 5822026563 ②：装好 dop 后点检查，响应 ready:true，汇总仍写「dop 未找到」。
  const page = await mount(t, {
    responses: [
      ok(iamBody()),
      ok(devopsSnapshot({ ready: false })),
      ok(giteeBody()),
      ok(devopsSnapshot({ ready: true, revision: 'rev-cccccccc33333333' })),
    ],
  });
  assert.match(page.rowState('tools'), /^未配置 · dop 未找到 · Gitee 已配置$/u);
  assert.ok(page.text().includes('1 项待处理 · dop 未找到'));

  await page.click('检查 DevOps');
  assert.match(page.rowState('tools'), /^已配置 · dop 已找到 · Gitee 已配置$/u, '检查响应里的来源快照必须同步到汇总');
  assert.ok(page.text().includes('✅ 可以开始'), page.text());
  assert.ok(page.text().includes('基准rev-cccc'), '结论与来源来自同一次响应');
});

test('P2 文案：检查只说重新发现配置与重建读面，不暗示执行过只读探测', () => {
  // 复核意见 5822026563 ③：按钮只走 ?refresh=1，服务端只重新发现配置、重建读面。
  const { dictionaries } = loadClient();
  const zh = dictionaries.devops.zh;
  const en = dictionaries.devops.en;

  assert.ok(!/只读试跑/u.test(zh['receipt.checkHint']), `zh.checkHint 仍暗示试跑：${zh['receipt.checkHint']}`);
  assert.ok(!/read-only trial run/iu.test(en['receipt.checkHint']), `en.checkHint 仍暗示试跑：${en['receipt.checkHint']}`);
  assert.match(zh['receipt.checkHint'], /重新发现配置/u);
  assert.match(zh['receipt.checkHint'], /不执行 CLI/u);
  assert.match(en['receipt.checkHint'], /re-discovers configuration/iu);
  assert.match(en['receipt.checkHint'], /no CLI/iu);
  assert.ok(!/只读检查/u.test(zh['readiness.next.check']), `readiness.next.check 仍暗示只读检查：${zh['readiness.next.check']}`);
  assert.ok(!/read-only check/iu.test(en['readiness.next.check']), `en readiness.next.check 仍暗示只读检查：${en['readiness.next.check']}`);
});

test('本机覆盖取服务端投影 layers.override：仅继承层命中不误报，投影缺失显示「未提供」', async (t) => {
  // 复核意见 5822026563 ④：合并后的 config 同时含企业继承层，origin=config 反推本机覆盖会误报。
  const inheritedOnly = devopsSnapshot({
    layers: { inherited: ['dopBin'], override: [], missing: [] },
    entries: { dopBin: { origin: 'config', path: 'C:/tools/dop.exe' } },
  });
  const noOverrides = giteeBody({
    entries: {
      owner: { inherited: 'corp', override: null },
      repo: { inherited: 'demo', override: null },
    },
  });
  const page = await mount(t, {
    responses: three({ devops: ok(inheritedOnly), gitee: ok(noOverrides) }),
  });
  const toolsDetail = page.rowDetail('tools');
  assert.ok(!toolsDetail.includes('本机覆盖：dopBin'), `仅继承层配置不得算本机覆盖：${toolsDetail}`);
  assert.ok(toolsDetail.includes('无本机覆盖'), toolsDetail);

  const unknown = await mount(t, {
    responses: three({ devops: ok(devopsSnapshot({ layers: undefined })), gitee: ok(noOverrides) }),
  });
  assert.ok(
    unknown.rowDetail('tools').includes('未提供'),
    `服务端没给投影时必须说「未提供」，不能按 origin 推断：${unknown.rowDetail('tools')}`,
  );

  // 配置层读不到时服务端仍会给 layers，但带 LAYERS_UNAVAILABLE：空 override 不是"没有覆盖"。
  const unavailable = await mount(t, {
    responses: three({
      devops: ok(devopsSnapshot({ layers: { inherited: [], override: [], missing: ['LAYERS_UNAVAILABLE'] } })),
      gitee: ok(noOverrides),
    }),
  });
  assert.ok(
    unavailable.rowDetail('tools').includes('未提供'),
    `投影不可用时空数组不能被读成「无本机覆盖」：${unavailable.rowDetail('tools')}`,
  );
});

test('成员行用词齐全：屏上不出现 readiness. 原样键（本机覆盖曾被漏掉）', async (t) => {
  // 回归：成员行键名改过一次，当时只改了键名、没补字典，屏上直接印出 readiness.row.device。
  const page = await mount(t, { responses: [...three(), ok(devopsSnapshot())] });
  const rendered = [page.text(), page.rowDetail('identity'), page.rowDetail('tools')].join('\n');
  assert.ok(!/readiness\.[A-Za-z]/u.test(rendered), `屏上出现未翻译的键：${rendered.match(/readiness\.[A-Za-z.]+/u)}`);
  assert.ok(page.rowDetail('tools').includes('本机覆盖'), page.rowDetail('tools'));
});
