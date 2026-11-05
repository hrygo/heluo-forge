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
  const tally = (pattern) => {
    const counts = {};
    lines.forEach((line, index) => {
      if (!pattern.test(line) || /typeof /.test(line)) return;
      const owner = enclosing(index);
      counts[owner] = (counts[owner] ?? 0) + 1;
    });
    return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  };
  const anchors = [];
  lines.forEach((line, index) => {
    const match = /^ {4}\/\/ §(\d+(?:\.\d+)?) (.+)$/.exec(line);
    if (match) anchors.push({ name: match[1], title: match[2], line: index + 1 });
  });
  const renderParams = {};
  lines.forEach((line, index) => {
    const entry = /render([A-Za-z0-9_]+)\(\{/.exec(line);
    if (!entry) return;
    const keys = [];
    for (let cursor = index; cursor < Math.min(lines.length, index + 30); cursor += 1) {
      const text = lines[cursor];
      const body = cursor === index ? text.slice(entry.index + entry[0].length) : text;
      const closed = body.includes('})');
      const chunk = closed ? body.slice(0, body.lastIndexOf('})')) : body;
      keys.push(...chunk.split(',').map(key => key.trim()).filter(key => /^[A-Za-z_$][\w$]*$/.test(key)));
      if (closed) break;
    }
    renderParams['render' + entry[1]] = keys;
  });
  return {
    lines,
    anchors,
    violations: {
      stateComparisons: tally(/view\??\.state ===/),
      storageSites: tally(/window\.localStorage/),
      rawErrorUnwrap: tally(/errorNotice\(result\.body\?\.error\?\.code/),
    },
    renderParams,
  };
}
