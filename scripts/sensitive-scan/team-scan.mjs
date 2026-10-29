import { readFileSync } from 'node:fs';
import { crc32, inflateRawSync } from 'node:zlib';

const MAX_TEXT_BYTES = 10 * 1024 * 1024;
const MAX_XLSX_BYTES = 20 * 1024 * 1024;
const XLSX_EXTENSIONS = new Set(['.xlsx', '.xlsm', '.xltx']);

export function loadRules(path) {
  const rules = JSON.parse(readFile(path));
  if (!rules || typeof rules !== 'object') throw new Error('规则文件不是对象');
  if (!rules.literals || typeof rules.literals !== 'object') throw new Error('规则缺少 literals');
  if (!rules.patterns || typeof rules.patterns !== 'object') throw new Error('规则缺少 patterns');
  return {
    literals: rules.literals,
    patterns: rules.patterns,
    allow: Array.isArray(rules.allow) ? rules.allow : [],
    ignorePaths: Array.isArray(rules.ignorePaths) ? rules.ignorePaths : [],
  };
}


function readFile(path) {
  return readFileSync(path, 'utf8');
}

export function isIgnored(filePath, rules) {
  const normalized = filePath.split('\\').join('/');
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  return rules.ignorePaths.some((pattern) => basename === pattern || matchGlob(normalized, pattern));
}

function matchGlob(path, glob) {
  if (glob === path) return true;
  if (glob.endsWith('/**')) {
    const prefix = glob.slice(0, -3);
    if (path === prefix || path.startsWith(`${prefix}/`)) return true;
  }
  if (glob.startsWith('**/')) {
    const rest = glob.slice(3);
    if (matchGlob(path, rest)) return true;
    const idx = path.indexOf('/');
    if (idx >= 0 && matchGlob(path.slice(idx + 1), rest)) return true;
  }
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`).test(path);
}

export function scanText(text, rules, context = {}) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  const allow = new Set(rules.allow);

  for (const [category, terms] of Object.entries(rules.literals)) {
    for (const term of terms) {
      if (!term || allow.has(term)) continue;
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex];
        for (const match of literalMatches(line, term)) {
          findings.push(
            makeFinding(category, term, match.value, lineIndex + 1, match.column, context),
          );
        }
      }
    }
  }

  for (const [category, pattern] of Object.entries(rules.patterns)) {
    let regex;
    try {
      regex = new RegExp(pattern, 'gi');
    } catch (error) {
      throw new Error(`规则 ${category} 不是有效正则：${error.message}`);
    }
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      for (const match of line.matchAll(regex)) {
        const value = match[0];
        if (!value || allow.has(value)) continue;
        const displayCategory = category === 'unit_alias' || category === 'unit_domain' || category === 'unit_branch' ? 'unit' : category;
        findings.push(
          makeFinding(displayCategory, category, value, lineIndex + 1, (match.index ?? 0) + 1, context),
        );
      }
    }
  }

  return dedupe(findings);
}

function literalMatches(line, term) {
  if (!/[A-Za-z]/.test(term)) {
    const result = [];
    let from = 0;
    while (from <= line.length) {
      const index = line.indexOf(term, from);
      if (index < 0) break;
      result.push({ value: term, column: index + 1 });
      from = index + term.length;
    }
    return result;
  }
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'gi');
  return [...line.matchAll(regex)].map((match) => ({
    value: match[0],
    column: (match.index ?? 0) + 1,
  }));
}

function makeFinding(category, rule, match, line, column, context) {
  return {
    category,
    rule,
    match,
    display: displayValue(category, match),
    line,
    column,
    start: column,
    end: column + match.length,
    part: context.part ?? null,
  };
}

function displayValue(category, value) {
  if (category === 'secret') return redact(value, 4, 4);
  if (category === 'email') {
    const [local, domain] = value.split('@');
    return `${local.slice(0, 2)}***@${domain}`;
  }
  if (category === 'phone') return `***${value.slice(-4)}`;
  if (category === 'abs_path') return value.replace(/(\/Users\/|\/home\/|[A-Za-z]:\\\\Users\\\\)([^/\\]+)/, '$1***');
  return value;
}

function redact(value, head, tail) {
  if (value.length <= head + tail) return '*'.repeat(value.length);
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function dedupe(findings) {
  const priority = {
    unit: 0,
    person: 1,
    industry: 2,
    brand: 3,
    secret: 4,
    email: 5,
    phone: 6,
    private_ipv4: 7,
    internal_host: 8,
    abs_path: 9,
    unit_alias: 10,
  };
  const sorted = [...findings].sort(
    (a, b) =>
      a.line - b.line ||
      a.column - b.column ||
      (b.end - b.start) - (a.end - a.start) ||
      (priority[a.category] ?? 99) - (priority[b.category] ?? 99),
  );
  const kept = [];
  for (const finding of sorted) {
    const covered = kept.some(
      (other) =>
        other.part === finding.part &&
        other.line === finding.line &&
        other.start <= finding.start &&
        other.end >= finding.end,
    );
    if (!covered) kept.push(finding);
  }
  return kept;
}

export function scanBuffer(buffer, filePath, rules) {
  const lower = filePath.toLowerCase();
  const ext = lower.slice(lower.lastIndexOf('.'));
  if (XLSX_EXTENSIONS.has(ext)) {
    if (buffer.length > MAX_XLSX_BYTES) {
      return { kind: 'xlsx-too-large', findings: [], skippedReason: 'xlsx 超过 20 MB' };
    }
    const parts = readXlsxParts(buffer);
    const findings = parts.flatMap((part) =>
      scanText(part.text, rules, { part: part.name }),
    );
    return { kind: 'xlsx', findings, parts: parts.length };
  }

  if (buffer.length > MAX_TEXT_BYTES) {
    return { kind: 'text-too-large', findings: [], skippedReason: '文本超过 10 MB' };
  }

  const text = decodeText(buffer);
  if (text === null) return { kind: 'binary', findings: [] };
  return { kind: 'text', findings: scanText(text, rules, {}) };
}

export function decodeText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  if (buffer.includes(0)) return null;
  const text = buffer.toString('utf8');
  return text.includes('\uFFFD') ? null : text;
}

export function readXlsxParts(buffer) {
  const entries = readZipEntries(buffer);
  const parts = [];
  for (const entry of entries) {
    if (!/\.(?:xml|rels)$/i.test(entry.name)) throw new Error('unsupported workbook part');
    const xml = decodeXmlPart(entry.data);
    const text = `${entry.name}\n${xmlToText(xml)}`;
    parts.push({ name: entry.name, text });
  }
  return parts;
}

function decodeXmlPart(data) {
  let encoding = 'utf-8';
  if (data[0] === 0xff && data[1] === 0xfe) encoding = 'utf-16le';
  else if (data[0] === 0xfe && data[1] === 0xff) encoding = 'utf-16be';
  else if (data[0] === 0x3c && data[1] === 0 && data[2] === 0x3f && data[3] === 0) encoding = 'utf-16le';
  else if (data[0] === 0 && data[1] === 0x3c && data[2] === 0 && data[3] === 0x3f) encoding = 'utf-16be';
  const xml = new TextDecoder(encoding, { fatal: true }).decode(data);
  if (!xml.trimStart().startsWith('<') || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(xml) || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('unsupported XML content');
  const declaration = /^\s*<\?xml\s+[^?]*\bencoding\s*=\s*(['"])([^'"]+)\1/i.exec(xml);
  if (declaration) {
    const declared = declaration[2].toLowerCase();
    if (declared !== encoding && !(declared === 'utf-16' && encoding.startsWith('utf-16'))) throw new Error('unsupported XML encoding');
  }
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(xml)) throw new Error('unsupported XML entity');
  return xml;
}

function xmlToText(xml) {
  const separated = decodeXml(xml.replace(/<[^>]+>/g, '\n'));
  const joined = decodeXml(xml.replace(/<[^>]+>/g, ''));
  const attributes = [...xml.matchAll(/\b[\w:.-]+\s*=\s*(['"])(.*?)\1/gs)]
    .map((match) => decodeXml(match[2]))
    .join('\n');
  return `${xml}\n${separated}\n${joined}\n${attributes}`;
}

function decodeXml(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function readZipEntries(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new Error('不是有效 ZIP/xlsx：找不到中央目录');
  const count = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  if (buffer.readUInt16LE(eocd + 4) || buffer.readUInt16LE(eocd + 6) ||
      buffer.readUInt16LE(eocd + 8) !== count || count === 0xffff ||
      centralOffset + centralSize !== eocd || eocd + 22 + buffer.readUInt16LE(eocd + 20) !== buffer.length) {
    throw new Error('unsupported ZIP directory');
  }
  const entries = [];
  const names = new Set();
  let offset = centralOffset;
  let expanded = 0;
  const maxExpanded = 100 * 1024 * 1024;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > eocd || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('invalid ZIP directory');
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const checksum = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > eocd || !nameLength || flags & 1 || (method !== 0 && method !== 8)) throw new Error('unsupported ZIP entry');
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    offset = end;
    if (localOffset + 30 > centralOffset || buffer.readUInt32LE(localOffset) !== 0x04034b50 ||
        buffer.readUInt16LE(localOffset + 6) !== flags || buffer.readUInt16LE(localOffset + 8) !== method) throw new Error('invalid ZIP entry');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > centralOffset ||
        !buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(Buffer.from(name))) throw new Error('invalid ZIP entry');
    expanded += size;
    if (expanded > maxExpanded) throw new Error('ZIP expansion limit');
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    const data = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: maxExpanded });
    if (data.length !== size || crc32(data) !== checksum || names.has(name)) throw new Error('invalid ZIP data');
    names.add(name);
    if (name.endsWith('/')) {
      if (data.length) throw new Error('unsupported ZIP directory data');
    } else entries.push({ name, data });
  }
  if (offset !== eocd || !entries.some(entry => entry.name === 'xl/workbook.xml')) throw new Error('invalid workbook');
  return entries;
}

function findEndOfCentralDirectory(buffer) {
  const min = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= min; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}
