import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';

import { checkBundleClosure } from './bundle-rules.mjs';
import { isReleaseSecret } from './release-config.mjs';
import { HOST_PATH, SECRETS } from './sensitive-patterns.mjs';

const REQUIRED = [
  'README.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  '.node-version',
  '.editorconfig',
  '.gitattributes',
  '.gitignore',
  '.github/workflows/check.yml',
  'docs/README.md',
  'docs/DOCUMENT-REGISTER.md',
  'docs/templates/_template.md',
  'docs/templates/design-template.md',
  'docs/design/README.md',
  'docs/operations/README.md',
  'deploy/README.md',
  'deploy/registry/README.md',
  'deploy/clients/README.md',
  'scripts/check-docs.mjs',
  'scripts/check-repo.mjs',
  'tests',
];

export { SECRETS, HOST_PATH } from './sensitive-patterns.mjs';
const ALLOW_MARKER = 'security-scan: allow';
// Case-insensitive on purpose: `.MD`/`.JSON` are the same text carriers as their
// lowercase forms, so skipping them would silently exempt their content from the
// secret/host-path scan. The `u` flag alone made the extension list case-sensitive.
const TEXT_EXTENSIONS = /\.(?:md|mjs|cjs|js|json|yaml|yml|txt|html|css|ts|tsx|sh|toml|ini|cfg)$/iu;

// The root is a closed entry surface: the audience-split entry documents, the
// workspace configuration and the top-level areas below. Reports, audits,
// check records and scratch notes belong under docs/ where the document
// register and the link checker govern them. A new root entry is added here
// only after its audience, owner and lifecycle are decided, so an ad-hoc file
// cannot land at the root without leaving a deliberate trace in this list.
export const ROOT_FILES = new Set([
  'README.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.node-version',
  '.editorconfig',
  '.gitattributes',
  '.gitignore',
  '.gitmodules',
  '.env.example',
  '.pr_agent.toml',
  '.dsh-version',
]);

export const ROOT_DIRS = new Set([
  '.agents',
  '.github',
  '.vscode',
  '.worktrees',
  'demos',
  'deploy',
  'docs',
  'packages',
  'scripts',
  'services',
  'tests',
  'node_modules',
  'output',
  'artifacts',
  'coverage',
  'logs',
]);

function posix(path) {
  return path.split(sep).join('/');
}

function walk(root, skip = new Set(['node_modules', '.git'])) {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  visit(root);
  return files.sort();
}

export function listTracked(root) {
  try {
    const output = execFileSync('git', ['-C', root, 'ls-files', '-z'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.split('\0').filter(Boolean).sort();
  } catch {
    return walk(root).map((file) => posix(relative(root, file)));
  }
}

export function checkRootSurface(root, tracked, errors) {
  const entries = new Set(tracked);
  // Untracked-but-unignored files are what a careless write leaves behind
  // before anyone stages it; include them so a local `pnpm check:repo` reports
  // the stray file instead of waiting for CI to see the commit.
  try {
    const output = execFileSync('git', ['-C', root, 'ls-files', '--others', '--exclude-standard', '-z'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const path of output.split('\0').filter(Boolean)) entries.add(path);
  } catch {
    // No Git (source archive or fixture): tracked already came from a directory walk.
  }

  const reportedDirs = new Set();
  for (const path of [...entries].sort()) {
    // An index-only deletion is pending commit; the file is already gone.
    if (!existsSync(join(root, path))) continue;
    const [head, ...rest] = path.split('/');
    if (rest.length === 0) {
      if (!ROOT_FILES.has(head)) {
        errors.push(
          `repo: ${path} is an unapproved root file; keep the root to the entry documents in ROOT_FILES and file reports or notes under docs/`,
        );
      }
      continue;
    }
    if (ROOT_DIRS.has(head) || reportedDirs.has(head)) continue;
    reportedDirs.add(head);
    errors.push(
      `repo: ${head}/ is an unapproved top-level directory; nest new material under docs/ or an existing area, then allowlist it deliberately`,
    );
  }
}

function workflowFiles(root) {
  const dir = join(root, '.github/workflows');
  if (!existsSync(dir)) return [];
    return readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => join(dir, name));
}

// The unified build is the one workflow that writes to the repository: it
// creates the draft Release and uploads assets (CORP-DSH-PLAN-026 §4.0). Every
// other workflow stays read-only. The write grant is admitted only under the
// conditions below, each of which removes one way the grant could be misused.
export const RELEASE_BUNDLE_WORKFLOW = '.github/workflows/release-bundle.yml';
const RELEASE_TRIGGERS = ['push:', "tags: ['v*']", 'workflow_dispatch:'];
const SECRET_REFERENCE = /\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}/gu;
// A whole line that is one `NAME: ${{ secrets.NAME }}` mapping and nothing else.
const SECRET_MAPPING = /^\s*[A-Za-z_][A-Za-z0-9_]*:\s*\$\{\{\s*secrets\.[A-Za-z0-9_]+\s*\}\}\s*$/u;

const indentOf = (line) => line.length - line.trimStart().length;
const isComment = (line) => line.trim().startsWith('#');
const keyOf = (text) => /^([A-Za-z_][A-Za-z0-9_-]*):/u.exec(text)?.[1] ?? text;

/** Non-comment lines that belong to the block opened at `index`: every following line indented deeper than it. */
function nestedLines(lines, index) {
  const base = indentOf(lines[index]);
  const nested = [];
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    if (line.trim() === '' || isComment(line)) continue;
    if (indentOf(line) <= base) break;
    nested.push(line);
  }
  return nested;
}

/** The keys of the step that owns `index`, up to a `run:` block: script text is not configuration. */
function stepKeys(lines, index) {
  const start = indentOf(lines[index]);
  let open = index;
  if (!/^\s*-/u.test(lines[index])) {
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (lines[cursor].trim() !== '' && indentOf(lines[cursor]) < start) {
        open = cursor;
        break;
      }
    }
  }
  const base = indentOf(lines[open]);
  const keys = [];
  for (let cursor = open + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    if (line.trim() === '' || isComment(line)) continue;
    if (indentOf(line) <= base) break;
    keys.push(line.trim());
    if (/^run:/u.test(line.trim())) break;
  }
  return keys;
}

/** Keys enclosing the line at `index`, nearest first, each the last line above that is indented less. */
function ancestorsOf(lines, index) {
  const keys = [];
  let base = indentOf(lines[index]);
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const line = lines[cursor];
    if (line.trim() === '' || isComment(line) || indentOf(line) >= base) continue;
    keys.push(keyOf(line.trim().replace(/^-\s*/u, '')));
    base = indentOf(line);
  }
  return keys;
}

export function checkReleaseBundleWorkflow(lines) {
  const problems = [];
  const label = RELEASE_BUNDLE_WORKFLOW.slice(RELEASE_BUNDLE_WORKFLOW.lastIndexOf('/') + 1);

  // Only a pushed v* tag or a human dispatch may start a write-privileged run:
  // a PR or branch trigger would let any pushed commit reach the grant.
  const triggerBlock = lines.findIndex((line) => /^on:\s*$/u.test(line));
  if (triggerBlock === -1) {
    problems.push(`${label} must declare an on: trigger block`);
  } else if (nestedLines(lines, triggerBlock).map((line) => line.trim()).join(' ') !== RELEASE_TRIGGERS.join(' ')) {
    problems.push(`${label} may only trigger on push of v* tags and workflow_dispatch`);
  }

  // The grant is the single top-level entry. A job-level block would re-scope
  // it per job, and one more entry would widen what the token can write.
  if (lines.some((line) => /^\s+permissions:\s*$/u.test(line))) {
    problems.push(`${label} must not declare job-level permissions; the top-level contents: write is its only grant`);
  }
  const permissionBlock = lines.findIndex((line) => /^permissions:\s*$/u.test(line));
  if (permissionBlock === -1) {
    problems.push(`${label} must declare top-level permissions`);
  } else {
    const entries = nestedLines(lines, permissionBlock).map((line) => line.trim());
    if (entries.length !== 1 || entries[0] !== 'contents: write') {
      problems.push(`${label} top-level permissions must be exactly one entry: contents: write`);
    }
  }

  // A checkout that keeps the token in the git config hands the write grant to
  // every later step, including the ones that only build.
  for (const [index, line] of lines.entries()) {
    if (!/^\s*(?:-\s*)?uses:\s*actions\/checkout@/u.test(line)) continue;
    if (!stepKeys(lines, index).includes('persist-credentials: false')) {
      problems.push(`${label} checkout at line ${index + 1} must set persist-credentials: false`);
    }
  }

  // Configuration reaches a step as an environment variable under `env:`, in
  // the configuration list, and nothing more: an expression expanded anywhere
  // else lands in the script text, the command line or the logs.
  for (const [index, line] of lines.entries()) {
    const names = [...line.matchAll(SECRET_REFERENCE)];
    if (names.length === 0) continue;
    if (SECRET_MAPPING.test(line) === false) {
      problems.push(`${label} line ${index + 1} expands a secret inline; map it through an env: entry instead`);
      continue;
    }
    if (names.some((match) => !isReleaseSecret(match[1]))) {
      problems.push(`${label} line ${index + 1} references a secret outside the configuration list`);
      continue;
    }
    const ancestors = ancestorsOf(lines, index);
    if (ancestors[0] !== 'env' || ancestors.includes('run') || ancestors.includes('with')) {
      problems.push(`${label} line ${index + 1} must map secrets through an env: block`);
    }
  }
  return problems;
}

export function checkRepo(root) {
  const errors = [];
  const counts = { required: 0, packages: 0, services: 0, workflows: 0, tracked: 0 };

  for (const path of REQUIRED) {
    counts.required += 1;
    if (!existsSync(join(root, path))) errors.push(`repo: missing ${path}`);
  }

  const pkgPath = join(root, 'package.json');
  if (existsSync(pkgPath)) {
    let pkg = null;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    } catch (error) {
      errors.push(`repo: package.json is not valid JSON (${error.message})`);
    }
    if (pkg) {
      if (pkg.private !== true) errors.push('repo: package.json must set "private": true');
      if (!/^pnpm@\d+\.\d+\.\d+$/.test(String(pkg.packageManager ?? ''))) {
        errors.push('repo: package.json must pin packageManager to an exact pnpm version');
      }
      if (!pkg.engines?.node) errors.push('repo: package.json must declare engines.node');
      if (!pkg.scripts?.check) errors.push('repo: package.json must define a check script');
      if (pkg.workspaces) errors.push('repo: list workspaces in pnpm-workspace.yaml, not package.json');
    }
  }

  const workspace = join(root, 'pnpm-workspace.yaml');
  if (existsSync(workspace)) {
    const text = readFileSync(workspace, 'utf8');
    for (const pattern of ['packages/*', 'services/*']) {
      if (!text.includes(pattern)) errors.push(`repo: pnpm-workspace.yaml is missing ${pattern}`);
    }
  }

  const nodeVersion = join(root, '.node-version');
  if (existsSync(nodeVersion) && !/^\d+\.\d+\.\d+\s*$/.test(readFileSync(nodeVersion, 'utf8'))) {
    errors.push('repo: .node-version must contain one exact version');
  }

  for (const group of ['packages', 'services']) {
    const dir = join(root, group);
    if (!existsSync(dir)) continue;
    const entries = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    for (const entry of entries) {
      const base = join(dir, entry.name);
      const readme = join(base, 'README.md');
      counts[group] += 1;
      if (!existsSync(readme)) {
        errors.push(`repo: ${group}/${entry.name} has no README.md`);
        continue;
      }
      const text = readFileSync(readme, 'utf8');
      if (!/状态：(规划|可用)/.test(text)) {
        errors.push(`repo: ${group}/${entry.name}/README.md must declare 状态：规划 or 状态：可用`);
      }
      const manifest = join(base, 'package.json');
      if (existsSync(manifest)) {
        let meta = null;
        try {
          meta = JSON.parse(readFileSync(manifest, 'utf8'));
        } catch (error) {
          errors.push(`repo: ${group}/${entry.name}/package.json is not valid JSON`);
        }
        if (meta) {
          if (!meta.engines?.dsh) errors.push(`repo: ${group}/${entry.name}/package.json must declare engines.dsh`);
          if (!meta.scripts?.test) errors.push(`repo: ${group}/${entry.name}/package.json must define a test script`);
          if (meta.private !== true) errors.push(`repo: ${group}/${entry.name}/package.json must set "private": true until publication is approved`);
          if (!/状态：可用/.test(text)) {
            errors.push(`repo: ${group}/${entry.name}/README.md must say 状态：可用 once a manifest exists`);
          }
        }
      } else if (/状态：可用/.test(text)) {
        errors.push(`repo: ${group}/${entry.name} claims 状态：可用 without package.json`);
      }
    }
  }

  const sensitiveAttestationWorkflow = '.github/workflows/sensitive-attestation.yml';
  for (const file of workflowFiles(root)) {
    counts.workflows += 1;
    const name = posix(relative(root, file));
    const text = readFileSync(file, 'utf8');
    if (text.includes('pull_request_target') && name !== sensitiveAttestationWorkflow) {
      errors.push(`repo: ${name} must not use pull_request_target`);
    }
    if (name === sensitiveAttestationWorkflow && text.includes('pull_request_target')) {
      // This exception is intentionally narrow: base-only checkout, no PR code
      // checkout/execution, no secrets. The verifier reads git objects only.
      const checkoutUses = [...text.matchAll(/^\s*-?\s*uses:\s*actions\/checkout@/gm)].length;
      if (checkoutUses !== 1) errors.push(`repo: ${name} must use exactly one actions/checkout step`);
      const refs = [...text.matchAll(/^\s*ref:\s*(.+?)\s*$/gm)].map((match) => match[1]);
      const baseRef = /^\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\}\}$/;
      if (refs.length !== 1 || !baseRef.test(refs[0])) {
        errors.push(`repo: ${name} must checkout only the pull_request base sha`);
      }
      // Permit the event SHA only as a fixed environment value for comparing
      // against the fetched object; never permit it as a checkout ref.
      const withoutExpectedSha = text.replace(/^\s*EXPECTED_HEAD_SHA:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\}\}\s*$/gm, '');
      if (/github\.head_ref|pull_request\.head\.(?:sha|ref)|refs\/pull\//.test(withoutExpectedSha)) {
        errors.push(`repo: ${name} must not reference the pull_request head`);
      }
      if (/git\s+(?:checkout|switch|worktree)\b/.test(text)) {
        errors.push(`repo: ${name} must not check out code at runtime`);
      }
      if (/secrets\./.test(text)) errors.push(`repo: ${name} must not read secrets`);
    }
    if (name === RELEASE_BUNDLE_WORKFLOW) {
      errors.push(...checkReleaseBundleWorkflow(text.replace(/\r$/gm, '').split('\n')));
    } else {
      if (!/^permissions:\s*$/m.test(text) || !/^\s+contents:\s*read\s*$/m.test(text)) {
        errors.push(`repo: ${name} must declare permissions with contents: read`);
      }
      if (/^\s+contents:\s*write\s*$/m.test(text)) {
        errors.push(`repo: ${name} must not declare contents: write; only ${RELEASE_BUNDLE_WORKFLOW} may`);
      }
    }
    for (const match of text.matchAll(/^[ \t]*(?:-[ \t]*)?uses:[ \t]*([^\r\n]*)$/gm)) {
      const reference = match[1].replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
      if (reference.startsWith('./')) continue;
      if (reference.startsWith('docker://')) {
        if (!/^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/.test(reference)) {
          errors.push(`repo: ${name} Docker image ${reference} is not pinned to a full sha256 digest`);
        }
      } else if (!/@[0-9a-f]{40}$/.test(reference)) {
        errors.push(`repo: ${name} action ${reference} is not pinned to a full commit SHA`);
      }
    }
  }

  const tracked = listTracked(root);
  counts.tracked = tracked.length;
  checkRootSurface(root, tracked, errors);
  for (const path of tracked) {
    if (path.startsWith('node_modules/') || path.includes('/node_modules/')) {
      errors.push(`repo: tracked dependency directory ${path}`);
    }
    const full = join(root, path);
    if (!existsSync(full) || !statSync(full).isFile()) continue;
    const size = statSync(full).size;
    if (size > 5 * 1024 * 1024) errors.push(`repo: ${path} exceeds 5 MiB`);
    if (!TEXT_EXTENSIONS.test(path)) continue;
    const text = readFileSync(full, 'utf8');
    text.split('\n').forEach((line, index) => {
      if (line.includes(ALLOW_MARKER)) return;
      if (HOST_PATH.test(line)) {
        errors.push(`repo: ${path}:${index + 1} contains a host-specific absolute path`);
      }
      for (const [pattern, label] of SECRETS) {
        if (pattern.test(line)) {
          errors.push(`repo: ${path}:${index + 1} contains a possible ${label} (value not printed)`);
        }
      }
    });
  }

  checkBundleClosure(root, errors);

  const assets = join(root, 'docs/assets');
  if (existsSync(assets)) {
    for (const name of readdirSync(assets).filter((file) => file.endsWith('.html'))) {
      const full = join(assets, name);
      const text = readFileSync(full, 'utf8');
      const label = `docs/assets/${name}`;
      if (/\/Users\/|\/home\//.test(text)) errors.push(`repo: ${label} embeds a host-specific path`);
      if (/<script[^>]+\ssrc=/i.test(text)) errors.push(`repo: ${label} must stay self-contained (no external script)`);
      for (const match of text.matchAll(/href="([^"]+)"/g)) {
        const href = match[1];
        if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) continue;
        if (!existsSync(resolve(dirname(full), href.split('#')[0]))) {
          errors.push(`repo: ${label} link ${href} does not resolve`);
        }
      }
    }
  }

  const ignore = join(root, '.gitignore');
  if (existsSync(ignore)) {
    const text = readFileSync(ignore, 'utf8');
    for (const entry of ['node_modules/', 'coverage/', '.DS_Store']) {
      if (!text.includes(entry)) errors.push(`repo: .gitignore should cover ${entry}`);
    }
  }

  return { errors, counts };
}
