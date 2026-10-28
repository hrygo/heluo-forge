#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import {
  cleanMessage,
  createAttestation,
  defaultKeyPath,
  defaultRulesPath,
  formatTrailer,
  gitOutput,
  loadKeyPair,
  loadRules,
  repoRoot,
  rulesDigest,
  scanStaged,
  scanText,
  stripTrailer,
} from './lib.mjs';

try {
  const messageFile = process.argv[2];
  if (!messageFile) throw new Error('usage: commit-msg.mjs <commit-message-file>');

  const cwd = repoRoot();
  const rulesPath = defaultRulesPath();
  const keyPath = defaultKeyPath();
  const rules = loadRules(rulesPath);
  const digest = rulesDigest(rulesPath);
  const key = loadKeyPair(keyPath);
  const original = readFileSync(messageFile, 'utf8');
  const body = cleanMessage(stripTrailer(original));
  if (!body.trim()) throw new Error('empty commit message');

  const messageFindings = scanText(body, rules);
  if (messageFindings.length > 0) {
    console.error('sensitive-scan: blocked; the commit message contains a finding');
    for (const finding of messageFindings) {
      console.error(`commit-message:${finding.line} ${finding.ruleId} (${finding.severity})`);
    }
    process.exit(1);
  }

  const result = scanStaged({ cwd, rules });
  if (result.findings.length > 0) {
    console.error('sensitive-scan: blocked; no attestation was written');
    for (const finding of result.findings) {
      console.error(`${finding.path}:${finding.line} ${finding.ruleId} (${finding.severity})`);
    }
    console.error('remove the finding or update the local rules only after review');
    process.exit(1);
  }

  const blocking = result.skipped.filter((item) => item.reason !== 'excluded');
  if (blocking.length > 0) {
    console.error('sensitive-scan: blocked; some staged files were not scanned');
    for (const item of blocking) {
      const detail = item.size ? ` (${item.size} bytes)` : '';
      console.error(`${item.path}: ${item.reason}${detail}`);
    }
    console.error('exclude a binary/large path explicitly in the approved rules, or make it scannable');
    process.exit(1);
  }

  const tree = gitOutput(['write-tree'], { cwd }).trim();
  const { fields } = createAttestation({
    body,
    tree,
    rules: digest,
    keyId: key.keyId,
    privateKey: key.privateKey,
  });
  writeFileSync(messageFile, formatTrailer(body, fields), 'utf8');
  console.error(`sensitive-scan: clean; signed ${result.scanned}/${result.total} staged files; ${result.skipped.length} explicitly excluded`);
} catch (error) {
  console.error(`sensitive-scan: ${error.message}`);
  process.exit(1);
}
