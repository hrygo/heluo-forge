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

## 修订记录

| 版本 | 日期 | 修订人 | 修订说明 |
|---|---|---|---|
| ${version} | 2026-10-20 | 平台组 | 初稿 |
`;

function write(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function questions(domain, count) {
  return Array.from(
    { length: count },
    (_, index) => `| CONF-${domain}-${String(index + 1).padStart(2, '0')} | 问题 ${index + 1} |`,
  ).join('\n');
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

| 编号 | 名称 | 路径 | 版本 | 状态 | 负责 | 门禁 |
|---|---|---|---|---|---|---|
| CORP-DSH-DOC-000 | 清单 | [DOCUMENT-REGISTER.md](<DOCUMENT-REGISTER.md>) | V1.0 | 生效 | 平台组 | — |
| CORP-DSH-DOC-001 | 索引 | [README.md](<README.md>) | V1.0 | 生效 | 平台组 | — |
| CORP-DSH-ARCH-001 | 架构 | [architecture/platform-architecture.md](<architecture/platform-architecture.md>) | V0.1 | 草案 | 平台组 | G0 |
| CORP-DSH-GW-001 | 网关 | [contracts/gateway-contract.md](<contracts/gateway-contract.md>) | V0.1 | 草案 | 网关团队 | G0 |
| CORP-DSH-REQ-001 | 需求 | [requirements/requirements-baseline.md](<requirements/requirements-baseline.md>) | V0.1 | 草案 | 平台组 | G0 |
| CORP-DSH-PLAN-001 | 计划 | [plans/rollout-plan.md](<plans/rollout-plan.md>) | V0.1 | 草案 | 平台组 | G0 |
| CORP-DSH-LET-001 | 询问函 | [collaboration/team-confirmation-letters.md](<collaboration/team-confirmation-letters.md>) | V0.1 | 草案 | 平台组 | G0 |
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
${Array.from({ length: 6 }, (_, i) => `| M${i + 1} | 指标 ${i + 1} |`).join('\n')}
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

${questions('IAM', 7)}

${questions('GW', 8)}

${questions('DEVOPS', 6)}

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
  const root = mkdtempSync(join(tmpdir(), 'corp-dsh-docs-'));
  buildValidDocs(root);
  return root;
}

function mutate(root, path, replace, replacement) {
  const file = join(root, path);
  const text = readFileSync(file, 'utf8');
  assert.ok(text.includes(replace), `fixture is missing ${replace}`);
  writeFileSync(file, text.replace(replace, replacement));
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
    mutate(root, 'docs/contracts/gateway-contract.md', '| 版本 | 日期 | 修订人 | 修订说明 |', '| 版本 | 日期 | 修订人 |');
    mutate(root, 'docs/contracts/gateway-contract.md', '|---|---|---|---|', '|---|---|---|');
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

test('controlled document without registration is reported', () => {
  const root = fixture();
  try {
    write(
      root,
      'docs/engineering/extra.md',
      META('CORP-DSH-ENG-999') + '\n> 编制依据：x。\n>\n> 关联文档：[架构](<../architecture/platform-architecture.md>)。\n',
    );
    const { errors } = checkDocs(root);
    assert.ok(errors.some((error) => error.includes('is not registered')), errors.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing revision row for the declared version is reported', () => {
  const root = fixture();
  try {
    mutate(root, 'docs/contracts/gateway-contract.md', '| V0.1 | 2026-10-20 | 平台组 | 初稿 |', '| V0.0 | 2026-10-20 | 平台组 | 初稿 |');
    const { errors } = checkDocs(root);
    assert.ok(errors.some((error) => error.includes('no revision row')), errors.join('\n'));
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

test('question count drift is reported', () => {
  const root = fixture();
  try {
    mutate(root, 'docs/collaboration/team-confirmation-letters.md', '| CONF-IAM-07 | 问题 7 |', '');
    const { errors } = checkDocs(root);
    assert.ok(errors.some((error) => error.includes('47 unique question rows')), errors.join('\n'));
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