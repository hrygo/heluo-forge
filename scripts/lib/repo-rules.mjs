import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';

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

const SECRETS = [
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, 'private key block'],
  [/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/, 'GitHub token'],
  [/\bsk-[A-Za-z0-9_-]{24,}\b/, 'API secret key'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/, 'cloud access key'],
  [/https?:\/\/[^\s/@:]+:[^\s/@]+@/, 'URL with embedded password'],
];

const TEXT_EXTENSIONS = /\.(md|mjs|cjs|js|json|ya?ml|txt|html|css|ts|tsx|sh|toml|ini|cfg)$/i;

const HOST_PATH = /(^|[^A-Za-z0-9])(?:\/Users\/|\/home\/|[A-Za-z]:\\\\Users\\\\)/;
const ALLOW_MARKER = 'security-scan: allow';

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

function workflowFiles(root) {
  const dir = join(root, '.github/workflows');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => join(dir, name));
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

  for (const file of workflowFiles(root)) {
    counts.workflows += 1;
    const name = posix(relative(root, file));
    const text = readFileSync(file, 'utf8');
    if (text.includes('pull_request_target')) errors.push(`repo: ${name} must not use pull_request_target`);
    if (!/^permissions:\s*$/m.test(text) || !/^\s+contents:\s*read\s*$/m.test(text)) {
      errors.push(`repo: ${name} must declare permissions with contents: read`);
    }
    for (const match of text.matchAll(/^[ \t]*(?:-[ \t]*)?uses:[ \t]*([^\r\n]*)$/gm)) {
      const reference = match[1].replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
      if (reference.startsWith('./')) continue;
      if (!/@[0-9a-f]{40}$/.test(reference)) errors.push(`repo: ${name} action ${reference} is not pinned to a full commit SHA`);
    }
  }

  const tracked = listTracked(root);
  counts.tracked = tracked.length;
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
