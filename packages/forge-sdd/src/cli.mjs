#!/usr/bin/env node
/**
 * `forge-sdd` 命令行：冻结与校验交付清单。
 *
 * 退出码：0 通过；1 有阻断项；2 用法或环境问题（清单缺失、锁被占用等）。
 */
import { freeze, loadManifest, verifyManifest } from './freeze.mjs';

const USAGE = `用法：
  node src/cli.mjs freeze --root <目录> --manifest <清单路径> --unit <交付单元>
      --change <变更号> --revision <当前版本> --tested-revision <测试覆盖版本>
      [--requirement-revision <需求版本>] [--stage spec|implementation|archive]
      [--artifact <路径>[:kind]]...
  node src/cli.mjs verify --root <目录> --manifest <清单路径> [--revision <当前版本>] [--json]

说明：本地结论标注为"未经 CI 验证"，不替代 CI 权威结论；指纹只证明文件未被改动。`;

function parseArgs(argv) {
  const options = { artifacts: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`unexpected argument "${token}"`);
    const [flag, inline] = token.includes('=') ? token.slice(2).split(/=(.*)/su) : [token.slice(2), undefined];
    if (inline === undefined && (flag === 'json' || flag === 'help')) {
      options[flag] = true;
      continue;
    }
    const value = inline ?? argv[++index];
    if (value === undefined) throw new Error(`--${flag} needs a value`);
    switch (flag) {
      case 'root': options.root = value; break;
      case 'manifest': options.manifest = value; break;
      case 'unit': options.unitId = value; break;
      case 'change': options.changeId = value; break;
      case 'revision': options.revision = value; break;
      case 'tested-revision': options.testedRevision = value; break;
      case 'requirement-revision': options.requirementRevision = value; break;
      case 'stage': options.stage = value; break;
      case 'artifact': {
        const [path, kind] = value.split(/:(?!\/)/u);
        options.artifacts.push({ path, kind });
        break;
      }
      case 'json': options.json = true; break;
      case 'help': options.help = true; break;
      default: throw new Error(`unknown flag --${flag}`);
    }
  }
  return options;
}

function report(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  for (const finding of result.findings ?? []) {
    process.stdout.write(`${finding.severity} ${finding.rule}${finding.locator ? ` [${finding.locator}]` : ''}: ${finding.message}\n`);
  }
  for (const note of result.notes ?? []) process.stdout.write(`note: ${note}\n`);
  process.stdout.write(result.ok ? 'forge-sdd: 通过（本地校验，未经 CI 验证）\n' : `forge-sdd: 阻断（${result.blocking.length} 项）\n`);
}

function main(argv) {
  const [command, ...rest] = argv;
  const options = parseArgs(rest);
  if (options.help || command === undefined) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const root = options.root ?? '.';
  if (options.manifest === undefined) throw new Error('--manifest is required');
  if (command === 'freeze') {
    const requiredFlags = { unitId: '--unit', changeId: '--change', revision: '--revision', testedRevision: '--tested-revision' };
    for (const [key, flag] of Object.entries(requiredFlags)) {
      if (options[key] === undefined) throw new Error(`${flag} is required`);
    }
    const manifest = freeze({ ...options, freezePath: options.manifest, root });
    process.stdout.write(`forge-sdd: 已冻结 ${manifest.artifacts.length} 个产物到 ${options.manifest}（本地，未经 CI 验证）\n`);
    return 0;
  }
  if (command === 'verify') {
    const manifest = loadManifest(options.manifest);
    const result = verifyManifest({ manifest, root, currentRevision: options.revision });
    report(result, options.json === true);
    return result.ok ? 0 : 1;
  }
  throw new Error(`unknown command "${command}"`);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`forge-sdd: ${error.message}${error.code ? ` (${error.code})` : ''}\n`);
  if (error.details?.findings) {
    for (const finding of error.details.findings) {
      process.stderr.write(`  ${finding.severity} ${finding.rule}${finding.locator ? ` [${finding.locator}]` : ''}: ${finding.message}\n`);
    }
  }
  process.exitCode = 2;
}
