import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { checkDocs, slugify, unfenced } from '../scripts/lib/doc-rules.mjs';

const META = (id, version = 'V0.1', status = '草案') => `# 测试文档

## 文档信息

| 项 | 内容 |
|---|---|
| 文档编号 | ${id} |
| 文档名称 | 测试文档 |
| 版本 | ${version} |
| 文档状态 | ${status} |
| 密级 | 内部 |
| 编制 | 平台组（代拟） |
| 审核 | 待定 |
| 批准 | 待定 |
| 最后更新 | 2026-10-20 |
| 门禁 | G0 |

`;

function write(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function questions(domain, numbers) {
  const list = Array.isArray(numbers) ? numbers : Array.from({ length: numbers }, (_, index) => index + 1);
  return list
    .map((number) => `| CONF-${domain}-${String(number).padStart(2, '0')} | 问题 ${number} |`)
    .join('\n');
}

export function buildValidDocs(root) {
  write(root, 'README.md', '# 项目入口\n\n| 项 | 内容 |\n|---|---|\n| 版本 | V1.0 |\n');
  write(root, 'AGENTS.md', '# 协作规范\n\n见 [入口](<README.md>)。\n');
  write(
    root,
    'docs/README.md',
    META('CORP-DSH-DOC-001', 'V1.0', '生效') +
      '\n## 1. 说明\n\n| 编号 | 文档 |\n|---|---|\n| CORP-DSH-ARCH-001 | 架构 |\n',
  );
  write(
    root,
    'docs/DOCUMENT-REGISTER.md',
    META('CORP-DSH-DOC-000', 'V1.0', '生效') +
      `
## 1. 清单

### 1.3 无独立正文的保留编号

| 编号 | 名称 | 状态 | 负责 | 门禁或去向 |
|---|---|---|---|---|
| CORP-DSH-OLD-001 | 旧方案 | 已废止 | 平台组 | 已由架构正文取代 |
| CORP-DSH-PLAN-002 | 待建计划 | 待启动 | 交付团队 | G1 |
`,
  );
  write(
    root,
    'docs/architecture/platform-architecture.md',
    META('CORP-DSH-ARCH-001') +
      `
> 编制依据：本地核对。
>
> 关联文档：[需求](<../requirements/requirements-baseline.md>)。

## 1. 结论

### 7.1 身份与令牌

文本。

## 2. 软件包组合

见 [接口](<../contracts/gateway-contract.md#41-身份>)。
`,
  );
  write(
    root,
    'docs/contracts/gateway-contract.md',
    META('CORP-DSH-GW-001') +
      `
> 编制依据：本地核对。
>
> 关联文档：[架构](<../architecture/platform-architecture.md>)。

## 4. 契约

### 4.1 身份

表格测试。

## 5. 失败模式
`,
  );
  write(
    root,
    'docs/requirements/requirements-baseline.md',
    META('CORP-DSH-REQ-001') +
      `
> 编制依据：本地核对。
>
> 关联文档：[架构](<../architecture/platform-architecture.md>)。

## 6. 需求

| 编号 | 需求 |
|---|---|
${Array.from({ length: 23 }, (_, i) => `| REQ-${String(i + 1).padStart(2, '0')} | 需求 ${i + 1} |`).join('\n')}

## 7. 指标

| 编号 | 指标 |
|---|---|
${[1, 2, 3, 5, 6].map((n) => `| M${n} | 指标 ${n} |`).join('\n')}
`,
  );
  write(
    root,
    'docs/plans/rollout-plan.md',
    META('CORP-DSH-PLAN-001') +
      `
> 编制依据：本地核对。
>
> 关联文档：[架构](<../architecture/platform-architecture.md>)。

## 7. 验收

| 编号 | 验收 |
|---|---|
${Array.from({ length: 14 }, (_, i) => `| A${i + 1} | 验收 ${i + 1} |`).join('\n')}
`,
  );
  write(
    root,
    'docs/collaboration/team-confirmation-letters.md',
    META('CORP-DSH-LET-001') +
      `
> 编制依据：本地核对。
>
> 关联文档：[架构](<../architecture/platform-architecture.md>)。

## 4. 契约

${questions('IAM', 18)}

${questions('GW', 8)}

${questions('DEVOPS', [1, 2, 3, 6])}

${questions('GITEE', 5)}

${questions('IT', 7)}

${questions('SEC', 7)}

${questions('PMO', 7)}

### 4.2 IAM 团队

正文一。

### 4.3 网关团队

正文二。

### 4.4 DevOps 团队

正文三。

### 4.5 Gitee 团队

正文四。

### 4.6 IT 团队

正文五。

### 4.7 安全团队

正文六。

### 4.8 PMO 团队

正文七。

## 5. 回函
`,
  );
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'heluo-forge-docs-'));
  buildValidDocs(root);
  return root;
}

function mutate(root, path, replace, replacement) {
  const file = join(root, path);
  const text = readFileSync(file, 'utf8');
  assert.ok(text.includes(replace), `fixture is missing ${replace}`);
  writeFileSync(file, text.replace(replace, replacement));
}

// 把一份受控正文改成“用户已确认”的形态：生效状态 + 审核／批准 + 四项确认记录。
function confirmRollout(root, date = '2026-11-03') {
  const path = 'docs/plans/rollout-plan.md';
  mutate(root, path, '| 文档状态 | 草案 |', '| 文档状态 | 生效 |');
  mutate(
    root,
    path,
    '| 审核 | 待定 |\n| 批准 | 待定 |',
    `| 审核 | 项目负责人（当前用户，${date}） |\n| 批准 | 项目负责人（当前用户，${date}） |\n| 确认人 | 项目负责人（当前用户） |\n| 确认日期 | ${date} |\n| 确认事项 | 验收口径 |\n| 适用范围 | 本文正文 |`,
  );
}

test('valid documentation tree passes', () => {
  const root = fixture();
  try {
    const { errors, counts } = checkDocs(root);
    assert.deepEqual(errors, []);
    assert.ok(counts.files >= 7);
    assert.ok(counts.links >= 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('broken relative link is reported', () => {
  const root = fixture();
  try {
    mutate(root, 'docs/architecture/platform-architecture.md', '(<../contracts/gateway-contract.md#41-身份>)', '(<../contracts/missing.md>)');
    const { errors } = checkDocs(root);
    assert.ok(errors.some((error) => error.includes('target does not exist')), errors.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unknown heading fragment is reported', () => {
  const root = fixture();
  try {
    mutate(root, 'docs/architecture/platform-architecture.md', '#41-身份', '#99-不存在');
    const { errors } = checkDocs(root);
    assert.ok(errors.some((error) => error.includes('matches no heading')), errors.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('line fragment beyond the file length is reported', () => {
  const root = fixture();
  try {
    mutate(root, 'docs/architecture/platform-architecture.md', '#41-身份', '#L9000');
    const { errors } = checkDocs(root);
    assert.ok(errors.some((error) => error.includes('exceeds')), errors.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ragged table is reported', () => {
  const root = fixture();
  try {
    mutate(
      root,
      'docs/contracts/gateway-contract.md',
      '## 5. 失败模式',
      '| 列一 | 列二 |\n|---|---|\n| 缺一列 |\n\n## 5. 失败模式',
    );
    const { errors } = checkDocs(root);
    assert.ok(errors.some((error) => error.includes('columns')), errors.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('two H1 headings are reported', () => {
  const root = fixture();
  try {
    mutate(root, 'docs/plans/rollout-plan.md', '## 7. 验收', '# 第二个标题\n\n## 7. 验收');
    const { errors } = checkDocs(root);
    assert.ok(errors.some((error) => error.includes('exactly one H1')), errors.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('new documents and version changes need no matching register edit', () => {
  const root = fixture();
  try {
    const register = join(root, 'docs/DOCUMENT-REGISTER.md');
    const before = readFileSync(register, 'utf8');
    mutate(root, 'docs/plans/rollout-plan.md', '| 版本 | V0.1 |', '| 版本 | V0.2 |');
    write(
      root,
      'docs/design/plugins/extra.md',
      META('CORP-DSH-DESIGN-999').replace('| 门禁 | G0 |', '| 门禁 | G0 |\n| 负责 | 交付团队 |\n| 交付门禁 | G2 |'),
    );
    write(root, 'docs/design/verification/extra.md', '# 验证记录\n\n> 合成验证。\n');
    const { errors, catalog } = checkDocs(root);
    assert.deepEqual(errors, []);
    assert.equal(readFileSync(register, 'utf8'), before);
    assert.equal(catalog.find((entry) => entry.id === 'CORP-DSH-PLAN-001').version, 'V0.2');
    const added = catalog.find((entry) => entry.id === 'CORP-DSH-DESIGN-999');
    assert.equal(added.path, 'docs/design/plugins/extra.md');
    assert.equal(added.owner, '交付团队');
    assert.equal(added.gate, 'G2');
    assert.ok(!catalog.some((entry) => entry.path === 'docs/design/verification/extra.md'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('duplicate IDs across independent documents report both locations', () => {
  const root = fixture();
  try {
    write(root, 'docs/operations/another.md', META('CORP-DSH-PLAN-001'));
    const { errors } = checkDocs(root);
    const duplicate = errors.find((error) => error.includes('duplicate ID CORP-DSH-PLAN-001'));
    assert.ok(duplicate, errors.join('\n'));
    assert.match(duplicate, /docs\/operations\/another\.md/);
    assert.match(duplicate, /docs\/plans\/rollout-plan\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('nested documents cannot omit identity or get it from a body example', () => {
  const root = fixture();
  try {
    const path = 'docs/operations/uat/another.md';
    write(root, path, META('CORP-DSH-UAT-999').replace('| 文档编号 | CORP-DSH-UAT-999 |\n', '') +
      '## 示例\n\n| 字段 | 值 |\n|---|---|\n| 文档编号 | CORP-DSH-UAT-999 |\n');
    const { errors } = checkDocs(root);
    assert.ok(errors.includes(`${path}: missing metadata 文档编号`), errors.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('canonical metadata enrolls documents from other nested documentation directories', () => {
  const root = fixture();
  try {
    const path = 'docs/engineering/checks/reference.md';
    write(root, path, META('CORP-DSH-ENG-999'));
    write(root, 'docs/engineering/checks/example.md', '# 示例\n\n## 示例内容\n\n| 字段 | 值 |\n|---|---|\n| 文档编号 | CORP-DSH-ENG-999 |\n');
    const { errors, catalog } = checkDocs(root);
    assert.deepEqual(errors, []);
    assert.deepEqual(catalog.filter((entry) => entry.id === 'CORP-DSH-ENG-999').map((entry) => entry.path), [path]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verification records cannot silently hide a document ID from the catalog', () => {
  const root = fixture();
  try {
    const path = 'docs/design/verification/another.md';
    write(root, path, META('CORP-DSH-DESIGN-999'));
    const { errors } = checkDocs(root);
    assert.ok(errors.includes(`${path}: verification record must not declare a document ID`), errors.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('retired and pending IDs cannot be reused while reserved', () => {
  const root = fixture();
  try {
    for (const id of ['CORP-DSH-OLD-001', 'CORP-DSH-PLAN-002']) {
      write(root, `docs/design/${id}.md`, META(id));
    }
    const { errors } = checkDocs(root);
    for (const id of ['CORP-DSH-OLD-001', 'CORP-DSH-PLAN-002']) {
      const duplicate = errors.find((error) => error.includes(`duplicate ID ${id}`));
      assert.ok(duplicate, errors.join('\n'));
      assert.ok(duplicate.includes('docs/DOCUMENT-REGISTER.md:'), duplicate);
      assert.ok(duplicate.includes(`docs/design/${id}.md`), duplicate);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a pending ID moves to its document with no copied row', () => {
  const root = fixture();
  try {
    mutate(root, 'docs/DOCUMENT-REGISTER.md', '| CORP-DSH-PLAN-002 | 待建计划 | 待启动 | 交付团队 | G1 |\n', '');
    write(root, 'docs/design/created.md', META('CORP-DSH-PLAN-002'));
    const { errors, catalog } = checkDocs(root);
    assert.deepEqual(errors, []);
    assert.deepEqual(catalog.filter((entry) => entry.id === 'CORP-DSH-PLAN-002').map((entry) => entry.path), ['docs/design/created.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy linked register rows and invalid reservation states are rejected', () => {
  const root = fixture();
  try {
    mutate(root, 'docs/DOCUMENT-REGISTER.md', '### 1.3 无独立正文的保留编号',
      '| CORP-DSH-PLAN-001 | 计划 | [plans/rollout-plan.md](<plans/rollout-plan.md>) | V0.1 | 草案 | 平台组 | G0 |\n\n### 1.3 无独立正文的保留编号');
    mutate(root, 'docs/DOCUMENT-REGISTER.md', '| 待建计划 | 待启动 |', '| 待建计划 | 草案 |');
    const { errors } = checkDocs(root);
    assert.ok(errors.some((error) => error.includes('manual catalog row')), errors.join('\n'));
    assert.ok(errors.some((error) => error.includes('invalid reservation CORP-DSH-PLAN-002')), errors.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('retired IDs cannot disappear through a reservation row without outer pipes', () => {
  const root = fixture();
  try {
    mutate(root, 'docs/DOCUMENT-REGISTER.md', '| CORP-DSH-OLD-001 | 旧方案 | 已废止 | 平台组 | 已由架构正文取代 |',
      'CORP-DSH-OLD-001 | 旧方案 | 已废止 | 平台组 | 已由架构正文取代');
    write(root, 'docs/design/reused.md', META('CORP-DSH-OLD-001'));
    const { errors } = checkDocs(root);
    assert.ok(errors.some((error) => error.includes('invalid reservation CORP-DSH-OLD-001')), errors.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('designs and runbooks apply the same approval metadata checks as other bodies', () => {
  const root = fixture();
  try {
    const paths = ['docs/design/plugins/example.md', 'docs/operations/example.md'];
    paths.forEach((path, index) => {
      write(root, path, META(`CORP-DSH-UAT-99${index}`).replace('| 审核 | 待定 |', '| 审核 | 项目负责人 |'));
    });
    const { errors } = checkDocs(root);
    for (const path of paths) {
      assert.ok(errors.includes(`${path}: non-待定 审核/批准 requires 文档状态 生效`), errors.join('\n'));
      assert.ok(errors.includes(`${path}: non-待定 审核/批准 requires 确认人`), errors.join('\n'));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('effective status requires confirmation even when audit and approval fields are pending', () => {
  const root = fixture();
  try {
    const path = 'docs/plans/rollout-plan.md';
    mutate(root, path, '| 文档状态 | 草案 |', '| 文档状态 | 生效 |');
    const unchecked = checkDocs(root).errors;
    assert.ok(unchecked.includes(`${path}: 文档状态 生效 requires 确认人`), unchecked.join('\n'));
    mutate(root, path, '| 门禁 | G0 |', '| 门禁 | G0 |\n| 确认人 | 项目负责人 |\n| 确认日期 | 2026-11-19 |\n| 确认事项 | 适用范围 |\n| 适用范围 | 正文的需求边界 |');
    assert.deepEqual(checkDocs(root).errors, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stale subdocument path and host paths are reported', () => {
  const root = fixture();
  try {
    mutate(root, 'docs/README.md', '## 1. 说明', '## 1. 说明\n\n旧位置 docs/subdocs/README.md');
    mutate(root, 'docs/README.md', '| 版本 | V1.0 |', '| 版本 | V1.0 |\n| 路径 | /Users/example/repo |'); // security-scan: allow
    const { errors } = checkDocs(root);
    assert.ok(errors.some((error) => error.includes('stale phrase')), errors.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('internal identifier leaked into a letter is reported', () => {
  const root = fixture();
  try {
    mutate(root, 'docs/collaboration/team-confirmation-letters.md', '正文一。', '正文一，参见 G1 门禁。');
    const { errors } = checkDocs(root);
    assert.ok(errors.some((error) => error.includes('internal identifier leaked')), errors.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('revision history tables are rejected', () => {
  const root = fixture();
  try {
    mutate(
      root,
      'docs/architecture/platform-architecture.md',
      '## 2. 软件包组合',
      '## 修订记录\n\n| 版本 | 日期 | 修订人 | 修订说明 |\n|---|---|---|---|\n| V0.1 | 2026-10-20 | 平台组 | 初稿 |\n\n## 2. 软件包组合',
    );
    const { errors } = checkDocs(root);
    assert.ok(errors.some((error) => error.includes('revision history is forbidden')), errors.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('question count drift is reported', () => {
  const root = fixture();
  try {
    mutate(root, 'docs/collaboration/team-confirmation-letters.md', '| CONF-IAM-07 | 问题 7 |', '');
    const { errors } = checkDocs(root);
    assert.ok(errors.some((error) => error.includes('56 unique question rows')), errors.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fenced content is ignored by table and link rules', () => {
  const root = fixture();
  try {
    mutate(
      root,
      'docs/contracts/gateway-contract.md',
      '### 4.1 身份',
      '### 4.1 身份\n\n```text\n| a | b |\n| --- |\n[broken](<missing.md>)\n```',
    );
    const { errors } = checkDocs(root);
    assert.deepEqual(errors, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('slugify mirrors GitHub heading anchors for CJK headings', () => {
  assert.equal(slugify('7.1 身份与令牌'), '71-身份与令牌');
  assert.equal(slugify('6. 软件包组合'), '6-软件包组合');
  assert.equal(slugify('Use `pnpm` for CI'), 'use-pnpm-for-ci');
  assert.deepEqual(unfenced('| a |\n```\n| b |\n```\n| c |'), ['| a |', '', '', '', '| c |']);
});

test('a user-confirmed document may record approval with its confirmation facts', () => {
  const root = fixture();
  try {
    confirmRollout(root);
    const { errors } = checkDocs(root);
    assert.deepEqual(errors, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('non-pending approval without the confirmation facts is reported', () => {
  const root = fixture();
  try {
    mutate(
      root,
      'docs/plans/rollout-plan.md',
      '| 审核 | 待定 |',
      '| 审核 | 项目负责人（当前用户，2026-11-03） |',
    );
    const { errors } = checkDocs(root);
    assert.ok(
      errors.some((error) => error.includes('non-待定 审核/批准 requires 文档状态 生效')),
      errors.join('\n'),
    );
    for (const key of ['确认人', '确认日期', '确认事项', '适用范围']) {
      assert.ok(errors.some((error) => error.includes(`requires ${key}`)), errors.join('\n'));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('confirmation date must be a real ISO date', () => {
  for (const date of ['2026/11/03', '2026-02-30', '2026-13-01']) {
    const root = fixture();
    try {
      confirmRollout(root, date);
      const { errors } = checkDocs(root);
      assert.ok(
        errors.some((error) => error.includes('确认日期 must be a real YYYY-MM-DD date')),
        `${date}: ${errors.join('\n')}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('placeholder confirmation values are rejected', () => {
  for (const [key, original, placeholder] of [
    ['确认人', '项目负责人（当前用户）', '待定'],
    ['确认事项', '验收口径', '—'],
    ['适用范围', '本文正文', '无'],
  ]) {
    const root = fixture();
    try {
      confirmRollout(root);
      mutate(root, 'docs/plans/rollout-plan.md', `| ${key} | ${original} |`, `| ${key} | ${placeholder} |`);
      const { errors } = checkDocs(root);
      assert.ok(
        errors.some((error) => error.includes(`requires ${key}`)),
        `${key}: ${errors.join('\n')}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('confirmation facts must live in the document-info table', () => {
  const root = fixture();
  try {
    confirmRollout(root);
    const path = 'docs/plans/rollout-plan.md';
    const facts = '| 确认人 | 项目负责人（当前用户） |\n| 确认日期 | 2026-11-03 |\n| 确认事项 | 验收口径 |\n| 适用范围 | 本文正文 |';
    mutate(root, path, facts, '');
    writeFileSync(
      join(root, path),
      `${readFileSync(join(root, path), 'utf8')}\n正文表格：\n\n| 项 | 内容 |\n|---|---|\n${facts}\n`,
    );
    const { errors } = checkDocs(root);
    for (const key of ['确认人', '确认日期', '确认事项', '适用范围']) {
      assert.ok(errors.some((error) => error.includes(`requires ${key}`)), `${key}: ${errors.join('\n')}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('annotated pending values stay accepted', () => {
  const root = fixture();
  try {
    confirmRollout(root);
    const path = 'docs/plans/rollout-plan.md';
    mutate(root, path, '| 审核 | 项目负责人（当前用户，2026-11-03） |', '| 审核 | 待定（技术章节） |');
    const { errors } = checkDocs(root);
    assert.deepEqual(errors, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('both approvals annotated as pending need no confirmation facts', () => {
  const root = fixture();
  try {
    const path = 'docs/plans/rollout-plan.md';
    mutate(root, path, '| 审核 | 待定 |\n| 批准 | 待定 |', '| 审核 | 待定（技术章节） |\n| 批准 | 待定（范围待定） |');
    const { errors } = checkDocs(root);
    assert.deepEqual(errors, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
