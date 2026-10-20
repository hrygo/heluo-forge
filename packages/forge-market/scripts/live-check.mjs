#!/usr/bin/env node
import { checkRemote } from '../src/live-check.mjs';

const args = process.argv.slice(2);
const get = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};

const repo = get('--repo');
const tag = get('--tag');
const digest = get('--digest');
if (!repo || !tag) {
  console.error('usage: node scripts/live-check.mjs --repo <url> --tag <vX.Y.Z> [--digest sha256:...]');
  process.exit(2);
}

const report = await checkRemote({ repo, tag, digest });
for (const step of report.steps) {
  console.log(`${step.ok ? 'ok  ' : 'FAIL'} ${step.step}: ${typeof step.detail === 'string' ? step.detail : JSON.stringify(step.detail)}`);
}
console.log(report.ok ? 'PASS' : 'FAIL');
process.exit(report.ok ? 0 : 1);
