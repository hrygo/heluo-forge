#!/usr/bin/env node
/**
 * #13 AC8 组合层核验：企业包禁用官方四行后，其余行是否**仍然存在且启用**。
 *
 * 背景：设计索引 §2.2 的 forge-enterprise 行把"禁用四行后 shell/settings/onboarding/
 * 模型选择是否完整"列为未验。企业组合包对配置是**整体替换**，因此"只关掉该关的"必须
 * 被断言——否则一次替换就可能顺手关掉无关行，而既有探针只检查了四个官方行。
 *
 * 判据（`--dump-config` 的组合层事实，不启动界面）：
 *   1. 四个官方行：存在于该 profile 的必须落 `disabled: true`；不存在的记录为 Loader 警告。
 *   2. **幸存行**：基线 dump 里出现的界面/设置/模型选择相关行，在打完补丁后必须仍然存在
 *      且没有被 `disabled: true`——这是"整体替换没有误伤"的证据。
 *
 * 用法：node scripts/probe/four-row-blanking-probe.mjs
 * 环境：DSH_BIN（默认 dsh）、BLANKING_PROFILES（默认 web,desktop，逗号分隔）
 * 退出码：0 全部满足；1 有断言不成立；2 环境不具备。
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dsh = process.env.DSH_BIN ?? 'dsh';
const bundlePatch = resolve(here, '../../packages/forge-enterprise/cordis.patch.yml');
const officialRows = ['deepseek-account', 'ui-settings-account', 'llm-deepseek-account', 'llm-deepseek'];
// 官方行之外、必须活下来的行：界面外壳与设置、模型选择、以及被禁用的账户 UI 之外的基础行。
const survivorPatterns = [
  /^ui-/u,
  /^settings/u,
  /^shell-env$/u,
  /^agent-default-model$/u,
  /^subagent/u,
];

const version = spawnSync(dsh, ['--version'], { encoding: 'utf8' });
if (version.error !== undefined) {
  console.error(`probe: 无法执行 ${dsh}（${version.error.message}）`);
  process.exit(2);
}
const harness = String(version.stdout ?? '').trim();

const profiles = (process.env.BLANKING_PROFILES ?? 'web,desktop').split(',').map((entry) => entry.trim()).filter(Boolean);
const results = [];
const skipped = [];
let failed = 0;

for (const profile of profiles) {
  const base = dump(profile, []);
  if (base === null) {
    // NOT RUN ≠ 通过：单独记账，不计入断言失败，也绝不写成已核验。
    skipped.push({ profile, reason: '该 profile 在本机不可 dump（由应用独占管理）' });
    continue;
  }
  const patched = dump(profile, ['--patch', bundlePatch]);
  if (patched === null) {
    results.push({ profile, ok: false, note: '打补丁后 dump 失败' });
    failed += 1;
    continue;
  }
  const baseRows = rowsOf(base);
  const patchedRows = rowsOf(patched);

  const officials = officialRows.map((id) => ({
    id,
    inProfile: baseRows.has(id),
    disabled: patchedRows.get(id) === true,
  }));
  const officialsOk = officials.every((entry) => (entry.inProfile ? entry.disabled : true));

  // 四个官方行本身就在 `ui-`/`settings` 形态里，但它们**应当**被关掉，不算误伤。
  const survivors = [...baseRows.keys()].filter(
    (id) => !officialRows.includes(id) && survivorPatterns.some((pattern) => pattern.test(id)),
  );
  const casualties = survivors.filter((id) => patchedRows.has(id) === false || patchedRows.get(id) === true);
  const survivorsOk = casualties.length === 0;

  // 补丁后新出现的行（官方行之外）单独列出：它们是企业包新增的能力，不是误伤。
  const added = [...patchedRows.keys()].filter((id) => !baseRows.has(id));

  const activationWarnings = warningsOf(patched).filter((line) => /did not activate|startup failed/iu.test(line));

  const ok = officialsOk && survivorsOk && activationWarnings.length === 0;
  if (!ok) failed += 1;
  results.push({
    profile,
    ok,
    officials,
    survivorCount: survivors.length,
    casualties,
    addedRows: added,
    activationWarnings: activationWarnings.slice(0, 3),
    note: ok
      ? '四行落 disabled；界面/设置/模型选择相关行全部保留且启用；无激活告警'
      : '存在不成立的断言（见 officials / casualties / activationWarnings）',
  });
}

console.log(
  JSON.stringify({ probe: 'four-row-blanking', harness, profiles, ok: failed === 0, failed, skipped, results }, null, 2),
);
process.exit(failed === 0 ? 0 : 1);

function dump(profile, extra) {
  const run = spawnSync(dsh, ['--profile', profile, ...extra, '--dump-config'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (run.error !== undefined || typeof run.stdout !== 'string' || run.stdout.trim().length === 0) return null;
  return `${run.stdout}\n${run.stderr ?? ''}`;
}

/** 取每行 id 与其 `disabled:` 取值；只看顶层 `- id:` 行下的第一层。 */
function rowsOf(text) {
  const rows = new Map();
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^- id: (.+)$/u.exec(lines[index]);
    if (match === null) continue;
    const id = match[1].trim();
    let disabled = false;
    for (let probe = index + 1; probe < lines.length && !/^- id: /u.test(lines[probe]); probe += 1) {
      if (/^\s+disabled: true\s*$/u.test(lines[probe])) disabled = true;
    }
    rows.set(id, disabled);
  }
  return rows;
}

function warningsOf(text) {
  return text.split('\n').filter((line) => /^dsh: (warning|error)/u.test(line));
}
