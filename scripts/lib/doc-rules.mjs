import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const CONTROLLED = /^docs\/(architecture|requirements|plans|contracts|collaboration|engineering)\/[^/]+\.md$/;
const DESIGN_OR_OPERATIONS = /^docs\/(design|operations)\/.+\.md$/;
const REGISTER_PATH = 'docs/DOCUMENT-REGISTER.md';
const RESERVATION_HEADING = '### 1.3 无独立正文的保留编号';
const DOC_ID = /^CORP-DSH-[A-Z]+-\d{3}[A-Z]?$/u;
const INDEX_DOCS = new Set([
  'docs/README.md',
  REGISTER_PATH,
  'docs/design/README.md',
  'docs/operations/README.md',
]);
const META_KEYS = ['文档编号', '文档名称', '版本', '文档状态', '密级', '编制', '审核', '批准', '最后更新', '门禁'];
const CONFIRMATION_KEYS = ['确认人', '确认日期', '确认事项', '适用范围'];
const CONFIRMATION_BLANK = new Set(['', '—', '-', '待定', '待确认', '未确认', '无']);
const PENDING = /^待定(?:（[^）]*）)?$/u;
const EFFECTIVE = /^生效(?:（[^）]*）)?$/u;
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

function metadataTable(lines, allowUnheaded) {
  const firstSection = lines.findIndex((line) => /^#{2,6}\s/u.test(line));
  const hasHeading = lines[firstSection] === '## 文档信息';
  if (!hasHeading && !allowUnheaded) return [];
  const start = hasHeading ? firstSection + 1 : 0;
  const rows = [];
  for (const line of lines.slice(start)) {
    if (/^#{2,6}\s/u.test(line)) break;
    const cells = parseRow(line);
    if (cells) rows.push(cells);
    else if (rows.length) break;
  }
  return rows;
}

// 只认真实存在的日历日，避免 2026-13-45 这类正则通过但并非日期的值。
function isRealIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
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
  const entries = new Map();
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

    if (lines.some((line) => /^##\s*修订记录\s*$/.test(line))) {
      errors.push(`${path}: revision history is forbidden; git holds the history`);
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

    if (!path.startsWith('docs/')) continue;
    const controlled = CONTROLLED.test(path);
    const template = path.startsWith('docs/templates/');
    const verification = path.startsWith('docs/design/verification/');
    const required = controlled || INDEX_DOCS.has(path) || (DESIGN_OR_OPERATIONS.test(path) && !verification);
    const fields = metadataTable(lines, required || template || verification);
    const declaresId = fields.some(([key]) => key === '文档编号');
    if (verification) {
      if (declaresId) errors.push(`${path}: verification record must not declare a document ID`);
      continue;
    }
    const catalogued = required || (!template && declaresId);
    if (!catalogued && !template) continue;

    const metadata = new Map();
    for (const [key, value] of fields) {
      if (metadata.has(key)) errors.push(`${path}: duplicate metadata ${key}`);
      metadata.set(key, value);
    }
    for (const key of META_KEYS) {
      if (!metadata.get(key)) errors.push(`${path}: missing metadata ${key}`);
    }
    if (catalogued && metadata.get('文档编号')) {
      addCatalogEntry(entries, {
        id: metadata.get('文档编号'),
        name: metadata.get('文档名称'),
        path,
        version: metadata.get('版本'),
        status: metadata.get('文档状态'),
        owner: metadata.get('负责') ?? '—',
        gate: metadata.get('交付门禁') ?? metadata.get('门禁'),
      }, path, errors);
    }
    if (catalogued && !INDEX_DOCS.has(path)) {
      counts.controlled += 1;
      checkApprovals(path, metadata, errors);
    }
    if (controlled) {
      if (!text.includes('编制依据')) errors.push(`${path}: missing 编制依据`);
      if (!text.includes('关联文档')) errors.push(`${path}: missing 关联文档`);
    }
  }

  collectReservations(texts.get(REGISTER_PATH), entries, errors);
  errors.push(...checkLetters(root, texts));
  errors.push(...checkSequences(root, texts, errors));

  const catalog = [...entries.keys()].sort().map((id) => entries.get(id).entry);
  return { errors, counts, catalog };
}

// 受控正文默认由 agent 起草，审核／批准保持“待定”。用户已确认需求时允许记录真实确认，
// 但必须同时留下有效的确认人、日期、事项与适用范围（不能是待定、破折号或空），且文档为生效状态（文档总览 §6.1）。
function checkApprovals(path, metadata, errors) {
  const approvals = ['审核', '批准'].map((key) => metadata.get(key));
  const pending = approvals.every((value) => PENDING.test(value ?? ''));
  const effective = EFFECTIVE.test(metadata.get('文档状态') ?? '');
  if (pending && !effective) return;
  if (!effective) {
    errors.push(`${path}: non-待定 审核/批准 requires 文档状态 生效`);
  }
  const reason = pending ? '文档状态 生效' : 'non-待定 审核/批准';
  for (const key of CONFIRMATION_KEYS) {
    if (CONFIRMATION_BLANK.has(metadata.get(key) ?? '')) {
      errors.push(`${path}: ${reason} requires ${key}`);
    }
  }
  const confirmedAt = metadata.get('确认日期') ?? '';
  if (!CONFIRMATION_BLANK.has(confirmedAt) && !isRealIsoDate(confirmedAt)) {
    errors.push(`${path}: 确认日期 must be a real YYYY-MM-DD date`);
  }
}

function addCatalogEntry(entries, entry, location, errors) {
  if (!DOC_ID.test(entry.id)) {
    errors.push(`${location}: invalid document ID ${entry.id}`);
    return;
  }
  const previous = entries.get(entry.id);
  if (previous) {
    errors.push(`catalog: duplicate ID ${entry.id}: ${previous.location} and ${location}`);
    return;
  }
  entries.set(entry.id, { entry, location });
}

function collectReservations(register, entries, errors) {
  if (!register) {
    errors.push(`${REGISTER_PATH}: missing`);
    return;
  }
  let inReservations = false;
  let foundReservations = false;
  unfenced(register).forEach((line, index) => {
    if (/^#{1,6}\s/u.test(line)) {
      inReservations = line.trimEnd() === RESERVATION_HEADING;
      if (inReservations) foundReservations = true;
      return;
    }
    const location = `${REGISTER_PATH}:${index + 1}`;
    const cells = parseRow(line);
    if (!cells) {
      const incomplete = /^\s*\|?\s*(CORP-[^|\s]+)\s*\|/u.exec(line);
      if (incomplete) {
        const kind = inReservations ? 'invalid reservation' : 'manual catalog row';
        errors.push(`${location}: ${kind} ${incomplete[1]}`);
      }
      return;
    }
    const [id, name, status, owner, gate] = cells;
    if (!inReservations) {
      if (/^CORP-/u.test(id)) errors.push(`${location}: manual catalog row ${id}`);
      return;
    }
    if (id === '编号' || /^:?-{3,}:?$/u.test(id)) return;
    if (cells.length !== 5 || !cells.every(Boolean) || (status !== '待启动' && status !== '已废止')) {
      errors.push(`${location}: invalid reservation ${id}`);
      return;
    }
    addCatalogEntry(entries, { id, name, path: null, version: null, status, owner, gate }, location, errors);
  });
  if (!foundReservations) errors.push(`${REGISTER_PATH}: missing reservation section`);
}

function checkLetters(root, texts) {
  const errors = [];
  const path = 'docs/collaboration/team-confirmation-letters.md';
  const letters = texts.get(path);
  if (!letters) return [`${path}: missing`];
  const expected = { IAM: 18, GW: 8, DEVOPS: [1, 2, 3, 6], GITEE: 5, IT: 7, SEC: 7, PMO: 7 };
  const allowed = (value) => (Array.isArray(value) ? value : Array.from({ length: value }, (_, i) => i + 1));
  const totalQuestions = Object.values(expected).reduce((sum, value) => sum + allowed(value).length, 0);
  const ids = [...letters.matchAll(/^\| (CONF-([A-Z]+)-(\d{2})) \|/gm)].map((match) => ({
    id: match[1],
    domain: match[2],
    number: Number(match[3]),
  }));
  if (ids.length !== totalQuestions || new Set(ids.map((item) => item.id)).size !== totalQuestions) {
    errors.push(`${path}: expected ${totalQuestions} unique question rows, found ${ids.length}`);
  }
  for (const [domain, total] of Object.entries(expected)) {
    const numbers = ids.filter((item) => item.domain === domain).map((item) => item.number).sort((a, b) => a - b);
    if (numbers.join(',') !== allowed(total).join(',')) {
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
    [requirements, 'M', [1, 2, 3, 5, 6], 'requirements metrics'],
    [plan, 'A', 14, 'plan acceptance'],
  ]) {
    if (!text) continue;
    const numbers = [...text.matchAll(new RegExp(`^\\| ${prefix}(\\d+) \\|`, 'gm'))].map((match) => Number(match[1]));
    const expected = Array.isArray(total) ? total : Array.from({ length: total }, (_, i) => i + 1);
    if (numbers.join(',') !== expected.join(',')) errors.push(`${label}: invalid ${prefix} sequence`);
  }
  return [];
}
