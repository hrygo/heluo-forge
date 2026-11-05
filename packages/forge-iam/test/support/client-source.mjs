import { readFileSync } from 'node:fs';

const CLIENT_URL = new URL('../../client.js', import.meta.url);
const TOP_LEVEL_FUNCTION = /^ {4}(?:async )?function ([A-Za-z0-9_]+)/;
const RENDER_ENTRY = /^ {4}function (render[A-Za-z0-9_]+)\(ctx\) \{/;

export function readClientSource() {
  return readFileSync(CLIENT_URL, 'utf8');
}

/**
 * Reads the panel source and reports the shape the structure guards assert on:
 * section anchors, per-function violation tallies, and render entry arity.
 * The tallies are keyed by enclosing top-level function so that inserting lines
 * never invalidates them, while moving a violation into a new function does.
 */
export function analyseClient(source) {
  const lines = source.split('\n');
  const enclosing = (index) => {
    for (let cursor = index; cursor >= 0; cursor -= 1) {
      const match = TOP_LEVEL_FUNCTION.exec(lines[cursor]);
      if (match) return match[1];
    }
    return '<top>';
  };
  // Counts occurrences (not lines) per enclosing function and ignores comments,
  // so a guard cannot be satisfied by mentioning the pattern in prose.
  const tally = (pattern) => {
    const counts = {};
    lines.forEach((line, index) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      const matches = line.match(pattern);
      if (!matches) return;
      const owner = enclosing(index);
      counts[owner] = (counts[owner] ?? 0) + matches.length;
    });
    return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  };
  const anchors = [];
  lines.forEach((line, index) => {
    const match = /^ {4}\/\/ §(\d+(?:\.\d+)?) (.+)$/.exec(line);
    if (match) anchors.push({ name: match[1], title: match[2], line: index + 1 });
  });
  // 只数调用点上「直接传给函数」的键：嵌套对象里的键属于分组内部，不算入参。
  const renderParams = {};
  lines.forEach((line, index) => {
    const entry = /render([A-Za-z0-9_]+)\(\{/.exec(line);
    if (!entry) return;
    let depth = 1;
    let quote = null;
    let buffer = '';
    const keys = [];
    const flush = () => {
      const segment = buffer.trim();
      buffer = '';
      if (!segment) return;
      const cut = segment.indexOf(':');
      const key = (cut === -1 ? segment : segment.slice(0, cut)).trim();
      if (/^[A-Za-z_$][\w$]*$/.test(key)) keys.push(key);
    };
    for (let cursor = index; cursor < lines.length; cursor += 1) {
      const text = cursor === index ? lines[cursor].slice(entry.index + entry[0].length) : lines[cursor];
      for (let at = 0; at < text.length; at += 1) {
        const ch = text[at];
        if (quote) {
          if (ch === quote && text[at - 1] !== '\\') quote = null;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
        if (ch === '{' || ch === '[' || ch === '(') depth += 1;
        else if (ch === '}' || ch === ']' || ch === ')') {
          depth -= 1;
          if (depth === 0) { flush(); cursor = lines.length; break; }
        } else if (ch === ',' && depth === 1) { flush(); continue; }
        if (depth >= 1) buffer += ch;
      }
    }
    renderParams['render' + entry[1]] = keys;
  });
  return {
    lines,
    anchors,
    violations: {
      stateReads: tally(/view\??\.state/g),
      modelStateReads: tally(/(?:modelAccess|access)\??\.state/g),
      gatewayStateReads: tally(/(?:gatewayCredential|gateway)\??\.state/g),
      storageSites: tally(/window\.localStorage/g),
      rawResultCode: tally(/result\.body\?\.error\?\.code/g),
    },
    renderParams,
  };
}
