import { extname } from 'node:path';
import { createAttestation, formatTrailer } from './lib.mjs';
import { gitRaw } from './team-guard.mjs';
import { decodeText, isIgnored, scanBuffer, scanText } from './team-scan.mjs';

const TEXT_LIMIT = 10 * 1024 * 1024;
const XLSX_LIMIT = 20 * 1024 * 1024;
const spreadsheets = new Set(['.xlsx', '.xlsm', '.xltx']);

export function addedLines(patch) {
  const lines = [];
  let hunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@ ')) { hunk = true; continue; }
    if (!hunk) continue;
    if (line.startsWith('+')) lines.push(line.slice(1));
    else if (!line.startsWith('-') && !line.startsWith(' ') && !line.startsWith('\\')) hunk = false;
  }
  return lines;
}

function decode(buffer, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`undecodable ${label}`);
  }
}

/**
 * Scan the change a commit introduces: the paths, whole workbooks and added
 * lines between `parentTree` and `tree`. Throws `blocked` instead of returning
 * findings so no caller can sign after a partial scan. Shared by the commit
 * hook and the post-rewrite re-signer so the policy cannot drift.
 */
export function scanChange({ cwd, parentTree, tree, rules }) {
  const pathsRaw = gitRaw(cwd, ['diff', '--ignore-submodules=none', '--name-only', '--no-renames', '--diff-filter=ACMRT', '-z', parentTree, tree, '--']);
  const files = decode(pathsRaw, 'path list').split('\0').filter(Boolean);
  for (const file of files) {
    if (isIgnored(file, rules)) continue;
    if (scanText(file, rules).length) throw new Error('blocked');
    const entries = decode(gitRaw(cwd, ['ls-tree', '-r', '-z', '--full-tree', tree, '--', `:(literal)${file}`]), 'tree entry').split('\0').filter(Boolean);
    const entry = entries.length === 1 && /^(100644|100755) blob ([0-9a-f]+)\t([\s\S]+)$/.exec(entries[0]);
    if (!entry || entry[3] !== file) throw new Error('unsupported tree entry');
    const blob = entry[2];
    const xlsx = spreadsheets.has(extname(file).toLowerCase());
    const limit = xlsx ? XLSX_LIMIT : TEXT_LIMIT;
    const size = Number(gitRaw(cwd, ['cat-file', '-s', blob]).toString('utf8').trim());
    if (!Number.isSafeInteger(size) || size < 0 || size > limit) throw new Error('blocked');
    const buffer = gitRaw(cwd, ['cat-file', 'blob', blob], { maxBuffer: limit + 1024 });
    if (buffer.length !== size) throw new Error('blocked');
    if (xlsx) {
      const result = scanBuffer(buffer, file, rules);
      if (result.kind !== 'xlsx' || result.findings.length) throw new Error('blocked');
      continue;
    }
    const text = decodeText(buffer);
    if (text === null) throw new Error('blocked');
    if (process.env.DSH_HOOK_FULL === '1' || (buffer.length >= 2 && ((buffer[0] === 255 && buffer[1] === 254) || (buffer[0] === 254 && buffer[1] === 255)))) {
      if (scanText(text, rules).length) throw new Error('blocked');
    } else {
      const patch = gitRaw(cwd, ['diff', '--no-renames', '--unified=0', '--no-color', '--no-ext-diff', '--no-textconv', '--text', parentTree, tree, '--', `:(literal)${file}`]);
      if (addedLines(decode(patch, 'patch')).some(line => scanText(line, rules).length)) throw new Error('blocked');
    }
  }
}

/** Build the v2 trailer body for one scan result. */
export function signMessage({ body, tree, parentTree, key }) {
  const { fields } = createAttestation({
    body,
    tree,
    parenttree: parentTree,
    keyId: key.keyId,
    privateKey: key.privateKey,
  });
  return formatTrailer(body, fields);
}
