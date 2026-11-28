import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PROMPT_ACTION_KEYS } from '../src/prompt-builder.mjs';
import { WORKBENCH_TOOLS } from '../src/tools.mjs';

const PKG_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SRC_DIR = join(PKG_DIR, 'src');

function collectSrcMjsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectSrcMjsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.mjs')) out.push(full);
  }
  return out.sort();
}

function extractRelativeImports(source) {
  const specs = [];
  const importRe = /(?:^|\n)\s*import\s+(?:[\s\S]*?\s+from\s+)?['"](\.[^'"]+)['"]/gu;
  let m;
  while ((m = importRe.exec(source)) !== null) {
    specs.push(m[1]);
  }
  return specs;
}

function assertThinServiceAssembler(source) {
  assert.equal(/\blet\s+/u.test(source), false, 'src/service.mjs 不得声明可变 let 状态变量（CORP-DSH-ENG-003 P2）');
  assert.equal(/\bnew\s+(?:Map|Set|AbortController)\b/u.test(source), false, 'src/service.mjs 不得持有 Map/Set/AbortController 状态（P2）');
  assert.ok(source.includes('createSessionRuntime'), 'src/service.mjs 必须委托给 createSessionRuntime');
  assert.ok(source.includes('createOverviewDomain'), 'src/service.mjs 必须装配 createOverviewDomain');
  assert.ok(source.includes('createRequirementDomain'), 'src/service.mjs 必须装配 createRequirementDomain');
}

function assertModuleLayerBoundary(relUnix, source, { verifyTargetExists = true } = {}) {
  const specs = extractRelativeImports(source);
  const relDir = posix.dirname(relUnix);

  for (const spec of specs) {
    const resolvedUnix = posix.normalize(posix.join(relDir === '.' ? '' : relDir, spec));
    if (verifyTargetExists) {
      assert.equal(existsSync(join(SRC_DIR, resolvedUnix)), true, `${relUnix} 引用了不存在的模块: ${spec}`);
    }

    if (relUnix.startsWith('shared/')) {
      assert.equal(
        resolvedUnix.startsWith('domains/'),
        false,
        `分层违规：core 模块 ${relUnix} 禁止反向导入业务域 ${resolvedUnix}`,
      );
      const forbiddenTopLevel = ['service.mjs', 'http.mjs', 'tools.mjs', 'portal-links.mjs', 'prompt-builder.mjs', 'index.mjs'];
      assert.equal(
        forbiddenTopLevel.includes(resolvedUnix),
        false,
        `分层违规：core 模块 ${relUnix} 禁止反向导入顶层装配模块 ${resolvedUnix}`,
      );
    }

    if (relUnix.startsWith('domains/')) {
      const ownDomain = relUnix.split('/')[1];
      if (resolvedUnix.startsWith('domains/')) {
        const targetDomain = resolvedUnix.split('/')[1];
        assert.equal(
          targetDomain,
          ownDomain,
          `域间耦合违规：domains/${ownDomain} 禁止直接导入其他业务域 domains/${targetDomain}`,
        );
      } else {
        assert.equal(
          resolvedUnix.startsWith('shared/'),
          true,
          `分层违规：业务域 ${relUnix} 只允许导入本域或 shared/ 模块，禁止导入 ${resolvedUnix}`,
        );
      }
    }
  }
}

test('P2 / P9 结构守卫：src/service.mjs 为无状态薄装配器且变异破坏必败', () => {
  const serviceSource = readFileSync(join(SRC_DIR, 'service.mjs'), 'utf8');
  assertThinServiceAssembler(serviceSource);

  // 变异测试：注入任意可变状态必须失败
  assert.throws(
    () => assertThinServiceAssembler(`${serviceSource}\nlet leakedCache = null;\n`),
    /不得声明可变 let/,
  );
  assert.throws(
    () => assertThinServiceAssembler(`${serviceSource}\nconst leakedMap = new Map();\n`),
    /不得持有 Map\/Set\/AbortController/,
  );
});

test('P2 / P9 单向依赖与分域隔离守卫：core 与各 domains 零反向/横向耦合（含变异测试）', () => {
  const files = collectSrcMjsFiles(SRC_DIR);
  assert.ok(files.some((f) => relative(SRC_DIR, f).replaceAll('\\', '/') === 'shared/session-runtime.mjs'));
  assert.ok(files.some((f) => relative(SRC_DIR, f).replaceAll('\\', '/') === 'domains/overview/service.mjs'));
  assert.ok(files.some((f) => relative(SRC_DIR, f).replaceAll('\\', '/') === 'domains/requirement/service.mjs'));

  for (const fullPath of files) {
    const relUnix = relative(SRC_DIR, fullPath).replaceAll('\\', '/');
    const source = readFileSync(fullPath, 'utf8');
    assertModuleLayerBoundary(relUnix, source, { verifyTargetExists: true });
  }

  // 变异测试 1：域间横向直接导入必须失败
  assert.throws(
    () => assertModuleLayerBoundary(
      'domains/requirement/service.mjs',
      "import { createOverviewDomain } from '../overview/service.mjs';",
      { verifyTargetExists: false },
    ),
    /域间耦合违规/,
  );

  // 变异测试 2：core 反向导入业务域必须失败
  assert.throws(
    () => assertModuleLayerBoundary(
      'shared/session-runtime.mjs',
      "import { createRequirementDomain } from '../domains/requirement/service.mjs';",
      { verifyTargetExists: false },
    ),
    /分层违规/,
  );
});

test('包对外 exports 完整性与一期公开工具/提示词/前端注册契约不变守卫', () => {
  const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'));
  for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
    if (target.includes('*')) {
      const baseDir = dirname(join(PKG_DIR, target));
      assert.equal(existsSync(baseDir), true, `exports[${subpath}] 目录不存在: ${target}`);
      continue;
    }
    assert.equal(existsSync(join(PKG_DIR, target)), true, `exports[${subpath}] 目标不存在: ${target}`);
  }

  assert.deepEqual(WORKBENCH_TOOLS, [
    'forge_workbench_requirement_read',
    'forge_workbench_story_read',
    'forge_workbench_rmp_doc_search',
    'forge_workbench_rmp_outline_read',
    'forge_workbench_rmp_section_read',
    'forge_workbench_todo_summary',
  ]);

  assert.deepEqual(PROMPT_ACTION_KEYS, [
    'req.create.one_sentence',
    'req.clarify.from_doc',
    'req.card.clarify_and_split',
    'story.card.design_and_prep',
  ]);

  const clientSource = readFileSync(join(PKG_DIR, 'client.js'), 'utf8');
  assert.ok(clientSource.includes('DOMAIN_VIEW_RENDERERS'), 'client.js 缺少 DOMAIN_VIEW_RENDERERS 分域视图注册表');
});
