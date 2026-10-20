import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const CONTROLLED = /^docs\/(architecture|requirements|plans|contracts|collaboration|engineering)\/[^/]+\.md$/;
const INDEX_DOCS = new Set([
  'docs/README.md',
  'docs/DOCUMENT-REGISTER.md',
  'docs/design/README.md',
  'docs/operations/README.md',
]);
const META_KEYS = ['文档编号', '文档名称', '版本', '文档状态', '密级', '编制', '审核', '批准', '最后更新', '门禁'];
const STALE_PHRASES = ['docs/subdocs/', '跨团队询问函暂未纳入本仓库'];

/** Lines with fenced code blanked out, so tables and links inside code are ignored. */
export function unfenced(text) {
  const lines = [];
  let fence = null;
  for (const line of text.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (marker) {
      const char = marker[1][0];
      if (fence === null) fence = char;
      else if (fence === char) fence = null;
      lines.push('');
      continue;
    }
    lines.push(fence ? '' : line);
  }
  return lines;
}

function toPosix(path) {
  return path.split(sep).join('/');
}

function listFiles(root) {
  const result = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) result.push(full);
    }
  };
  for (const name of ['README.md', 'AGENTS.md']) {
    const full = join(root, name);
    if (existsSync(full)) result.push(full);
  }
  const docs = join(root, 'docs');
  if (existsSync(docs)) walk(docs);
  return result.filter((file) => file.endsWith('.md')).sort();
}

export function slugify(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

function collectSlugs(file) {
  const slugs = new Set();
  const counts = new Map();
  for (const line of unfenced(readFileSync(file, 'utf8'))) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (!heading) continue;
    const base = slugify(heading[1]);
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    slugs.add(seen === 0 ? base : `${base}-${seen}`);
  }
  return slugs;
}

function metadata(text, key) {
  for (const line of unfenced(text)) {
    const cells = parseRow(line);
    if (cells && cells[0] === key) return cells[1];
  }
  return null;
}

function parseRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  return trimmed
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
}

const LINK = /!?\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)\s*\)/g;

function checkFragment(file, fragment, errors, label, counts) {
  const text = readFileSync(file, 'utf8');
  counts.fragments += 1;
  const lineAnchor = /^L(\d+)(?:-L(\d+))?$/.exec(fragment);
  if (lineAnchor) {
    const total = text.split('\n').length;
    const last = Number(lineAnchor[2] ?? lineAnchor[1]);
    if (last > total || Number(lineAnchor[1]) < 1) {
      errors.push(`${label}: fragment #${fragment} exceeds ${total} lines`);
    }
    return;
  }
  if (!collectSlugs(file).has(decodeURIComponent(fragment))) {
    errors.push(`${label}: fragment #${fragment} matches no heading`);
  }
}

export function checkDocs(root, options = {}) {
  const errors = [];
  const counts = { files: 0, tables: 0, links: 0, fragments: 0, controlled: 0 };
  const files = listFiles(root);
  if (files.length === 0) errors.push('docs: no Markdown files found');

  const texts = new Map();
  for (const file of files) {
    const relativePath = toPosix(relative(root, file));
    texts.set(relativePath, readFileSync(file, 'utf8'));
  }

  for (const [path, text] of texts) {
    const lines = unfenced(text);
    counts.files += 1;

    if (lines.filter((line) => /^#\s+/.test(line)).length !== 1) {
      errors.push(`${path}: expected exactly one H1`);
    }

    let width = null;
    lines.forEach((line, index) => {
      if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
        const cells = parseRow(line);
        if (!cells) return;
        if (width === null) {
          width = cells.length;
          counts.tables += 1;
        } else if (width !== cells.length) {
          errors.push(`${path}:${index + 1}: table has ${cells.length} columns, expected ${width}`);
        }
      } else {
        width = null;
      }
      if (line !== line.trimEnd()) errors.push(`${path}:${index + 1}: trailing whitespace`);
    });

    for (const match of lines.join('\n').matchAll(LINK)) {
      const raw = match[1];
      const target = raw.startsWith('<') ? raw.slice(1, -1) : raw;
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      if (target.includes('/Users/') || target.includes('/home/')) { // security-scan: allow
        errors.push(`${path}: host-specific link ${target}`);
      }
      const [pathPart, fragment] = target.split('#');
      const label = `${path}: link ${target}`;
      if (!pathPart) {
        if (fragment) checkFragment(join(root, path), fragment, errors, label, counts);
        continue;
      }
      counts.links += 1;
      const resolved = resolve(dirname(join(root, path)), pathPart);
      if (!existsSync(resolved)) {
        errors.push(`${label}: target does not exist`);
        continue;
      }
      if (fragment) {
        const stats = statSync(resolved);
        if (stats.isFile() && resolved.endsWith('.md')) {
          checkFragment(resolved, fragment, errors, label, counts);
        } else {
          errors.push(`${label}: fragment on a non-Markdown target`);
        }
      }
    }

    for (const phrase of STALE_PHRASES) {
      if (text.includes(phrase)) errors.push(`${path}: stale phrase ${phrase}`);
    }
    if (text.includes('/Users/') || text.includes('/home/')) { // security-scan: allow
      errors.push(`${path}: host-specific absolute path`);
    }

    const controlled = CONTROLLED.test(path);
    const index = INDEX_DOCS.has(path);
    if (!controlled && !index && !path.startsWith('docs/templates/')) continue;

    for (const key of META_KEYS) {
      if (metadata(text, key) === null) errors.push(`${path}: missing metadata ${key}`);
    }
    const version = metadata(text, '版本');
    if (version) {
      const versions = [];
      for (const line of unfenced(text)) {
        const cells = parseRow(line);
        if (cells && /^V\d+\.\d+(\.\d+)?$/.test(cells[0] ?? '')) versions.push(cells[0]);
      }
      if (!versions.includes(version)) errors.push(`${path}: no revision row for ${version}`);
      if (new Set(versions).size !== versions.length) errors.push(`${path}: duplicate revision version`);
    }

    if (controlled) {
      counts.controlled += 1;
      for (const key of ['审核', '批准']) {
        if (metadata(text, key) !== '待定') errors.push(`${path}: ${key} must stay 待定 for agent drafts`);
      }
      if (!text.includes('编制依据')) errors.push(`${path}: missing 编制依据`);
      if (!text.includes('关联文档')) errors.push(`${path}: missing 关联文档`);
    }
  }

  errors.push(...checkRegister(root, texts));
  errors.push(...checkLetters(root, texts));
  errors.push(...checkSequences(root, texts, errors));

  return { errors, counts };
}

function checkRegister(root, texts) {
  const errors = [];
  const registerPath = 'docs/DOCUMENT-REGISTER.md';
  const register = texts.get(registerPath);
  if (!register) return ['docs/DOCUMENT-REGISTER.md: missing'];

  const registered = new Map();
  for (const line of unfenced(register)) {
    const cells = parseRow(line);
    if (!cells || cells.length !== 7 || !/^CORP-/.test(cells[0])) continue;
    const [id, , link, version, status] = cells;
    if (registered.has(id)) errors.push(`register: duplicate ID ${id}`);
    registered.set(id, cells);
    const target = /\]\(<?([^)>]+)>?\)/.exec(link);
    if (!target) continue;
    const path = toPosix(join('docs', target[1]));
    if (!existsSync(join(root, path))) {
      errors.push(`register: ${id} path does not exist: ${path}`);
      continue;
    }
    const text = texts.get(path) ?? readFileSync(join(root, path), 'utf8');
    const actual = {
      文档编号: metadata(text, '文档编号'),
      版本: metadata(text, '版本'),
      文档状态: metadata(text, '文档状态'),
    };
    if (actual.文档编号 !== id) errors.push(`register: ${path} declares ${actual.文档编号}, registered as ${id}`);
    if (actual.版本 !== version) errors.push(`register: ${path} version ${actual.版本} != ${version}`);
    if (actual.文档状态 !== status) errors.push(`register: ${path} status ${actual.文档状态} != ${status}`);
  }

  for (const [path, text] of texts) {
    if (!CONTROLLED.test(path)) continue;
    const id = metadata(text, '文档编号');
    if (!id || !registered.has(id)) errors.push(`${path}: controlled document ${id ?? '(no ID)'} is not registered`);
  }
  return errors;
}

function checkLetters(root, texts) {
  const errors = [];
  const path = 'docs/collaboration/team-confirmation-letters.md';
  const letters = texts.get(path);
  if (!letters) return [`${path}: missing`];
  const expected = { IAM: 7, GW: 8, DEVOPS: 6, GITEE: 5, IT: 7, SEC: 7, PMO: 7 };
  const ids = [...letters.matchAll(/^\| (CONF-([A-Z]+)-(\d{2})) \|/gm)].map((match) => ({
    id: match[1],
    domain: match[2],
    number: Number(match[3]),
  }));
  if (ids.length !== 47 || new Set(ids.map((item) => item.id)).size !== 47) {
    errors.push(`${path}: expected 47 unique question rows, found ${ids.length}`);
  }
  for (const [domain, total] of Object.entries(expected)) {
    const numbers = ids.filter((item) => item.domain === domain).map((item) => item.number).sort((a, b) => a - b);
    if (numbers.join(',') !== Array.from({ length: total }, (_, i) => i + 1).join(',')) {
      errors.push(`${path}: invalid ${domain} question sequence`);
    }
  }
  const headings = [...letters.matchAll(/^### 4\.([2-8]) .*$/gm)];
  if (headings.length !== 7) errors.push(`${path}: expected seven forwardable letters`);
  headings.forEach((heading, index) => {
    const start = heading.index + heading[0].length;
    const end = index + 1 < headings.length ? headings[index + 1].index : letters.indexOf('## 5.');
    const body = letters.slice(start, end);
    if (/G[0-3]|CORP-DSH-|REQ-\d|A1[0-4]|C[1-4]|M[1-6]/.test(body)) {
      errors.push(`${path}: internal identifier leaked into letter 4.${heading[1]}`);
    }
    if (/\]\(<?(?:\.\.\/|gateway-contract|team-confirmation|_template)/.test(body)) {
      errors.push(`${path}: repository link leaked into letter 4.${heading[1]}`);
    }
  });
  return errors;
}

function checkSequences(root, texts, errors) {
  const requirements = texts.get('docs/requirements/requirements-baseline.md');
  const plan = texts.get('docs/plans/rollout-plan.md');
  if (!requirements) errors.push('docs/requirements/requirements-baseline.md: missing');
  if (!plan) errors.push('docs/plans/rollout-plan.md: missing');
  for (const [text, prefix, total, label] of [
    [requirements, 'REQ-', 23, 'requirements'],
    [requirements, 'M', 6, 'requirements metrics'],
    [plan, 'A', 14, 'plan acceptance'],
  ]) {
    if (!text) continue;
    const numbers = [...text.matchAll(new RegExp(`^\\| ${prefix}(\\d+) \\|`, 'gm'))].map((match) => Number(match[1]));
    const expected = Array.from({ length: total }, (_, i) => i + 1);
    if (numbers.join(',') !== expected.join(',')) errors.push(`${label}: invalid ${prefix} sequence`);
  }
  return [];
}