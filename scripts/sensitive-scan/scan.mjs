#!/usr/bin/env node
import { loadRules, rulesDigest, scanStaged, defaultRulesPath } from './lib.mjs';

function usage() {
  return `usage: node scripts/sensitive-scan/scan.mjs [--rules <path>] [--json]

Scans only staged files in the current repository. Rules stay local; this
command never sends file contents or rule patterns to a remote service.`;
}

function parseArgs(argv) {
  const args = { rules: defaultRulesPath(), json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--rules') {
      args.rules = argv[++index];
    } else if (value === '--json') {
      args.json = true;
    } else if (value === '--help' || value === '-h') {
      args.help = true;
    } else {
      throw new Error(`unknown argument: ${value}`);
    }
  }
  return args;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }
  if (!args.rules) throw new Error('no rules path configured');
  const rules = loadRules(args.rules);
  const digest = rulesDigest(args.rules);
  const result = scanStaged({ rules });
  const output = {
    scanner: 'heluo-sensitive-scan@1.0.0',
    rulesDigest: digest,
    scanned: result.scanned,
    total: result.total,
    skipped: result.skipped,
    findings: result.findings,
  };
  if (args.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`rules: ${digest}`);
    console.log(`files: ${result.scanned}/${result.total} scanned, ${result.skipped.length} skipped`);
    for (const finding of result.findings) {
      console.log(`${finding.path}:${finding.line} ${finding.ruleId} (${finding.severity})`);
    }
    if (result.findings.length === 0) console.log('sensitive-scan: clean');
  }
  process.exit(result.findings.length === 0 ? 0 : 2);
} catch (error) {
  console.error(`sensitive-scan: ${error.message}`);
  process.exit(1);
}
