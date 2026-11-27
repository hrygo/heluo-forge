import { createHash } from 'node:crypto';

const markerPattern = /(?:^|\n)(<!-- heluo-forge-pr-agent-comment:v1 [a-f0-9]{64} -->)$/u;

export function getReviewCommentMarker(body) {
  return typeof body === 'string' ? markerPattern.exec(body.trimEnd())?.[1] : undefined;
}

export function parseReviewPatch(patch) {
  const hunks = [];
  if (typeof patch !== 'string') return { hunks, complete: false, hasNoNewlineMarker: false };
  let complete = true;
  let hasNoNewlineMarker = false;
  for (const hunk of patch.split(/(?<=\n)(?=@@ )/u)) {
    const [header, ...rows] = hunk.split('\n');
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?\r?$/u.exec(header);
    if (!match) {
      complete = false;
      continue;
    }
    const [, oldStart, oldCount = '1', newStart, newCount = '1'] = match;
    const left = { start: Number(oldStart), end: Number(oldStart) + Number(oldCount), lines: [] };
    const right = { start: Number(newStart), end: Number(newStart) + Number(newCount), lines: [] };
    const sides = [left, right];
    if (sides.some(({ start, end }) => !Number.isSafeInteger(end) || (start === 0 && end > start))) {
      complete = false;
      continue;
    }

    if (rows.at(-1) === '') rows.pop();
    let oldLine = left.start;
    let newLine = right.start;
    let valid = true;
    for (const row of rows) {
      switch (row[0]) {
        case ' ':
          oldLine++;
          newLine++;
          break;
        case '-':
          left.lines.push({ number: oldLine++, text: row.slice(1) });
          break;
        case '+':
          right.lines.push({ number: newLine++, text: row.slice(1) });
          break;
        case '\\':
          valid = row === '\\ No newline at end of file' || row === '\\ No newline at end of file\r';
          hasNoNewlineMarker ||= valid;
          break;
        default:
          valid = false;
      }
      if (!valid || oldLine > left.end || newLine > right.end) break;
    }
    // The GitHub patch can be truncated. Require a complete hunk before using its coordinates.
    if (valid && oldLine === left.end && newLine === right.end) hunks.push({ LEFT: left, RIGHT: right });
    else complete = false;
  }
  return { hunks, complete, hasNoNewlineMarker };
}

function indexChangedPaths(files) {
  const paths = new Map();
  function add(path, file, onlySide) {
    if (!paths.has(path)) paths.set(path, []);
    paths.get(path).push({ file, onlySide });
  }
  for (const file of files) {
    if (typeof file?.filename !== 'string' || !file.filename) continue;
    let onlySide;
    if (file.status === 'added') onlySide = 'RIGHT';
    if (file.status === 'removed') onlySide = 'LEFT';
    add(file.filename, file, onlySide);
    if (file.status === 'renamed' && typeof file.previous_filename === 'string' &&
        file.previous_filename && file.previous_filename !== file.filename) {
      add(file.previous_filename, file, 'LEFT');
    }
  }
  return paths;
}

function parseFinding(issue) {
  if (typeof issue?.issue_header !== 'string' || typeof issue.issue_content !== 'string' ||
      typeof issue.relevant_file !== 'string' || !issue.relevant_file.trim()) return undefined;
  const content = issue.issue_content.trim();
  const heading = /^(?:(\[P[0-3]\])[ \t]+)?(?:\[(LEFT|RIGHT)(?: (\d+)-(\d+))?\][ \t]+)?(.+)$/u.exec(issue.issue_header.trim());
  if (!content || !heading) return undefined;
  const [, priority, side, leftStart, leftEnd, title] = heading;
  if (/^\[(?:P[0-3]|LEFT|RIGHT)(?:\s|\])/iu.test(title)) return undefined;
  // PR-Agent's summary only knows RIGHT. LEFT uses the issue title for coordinates.
  if (leftStart && (side !== 'LEFT' || issue.start_line !== 0 || issue.end_line !== 0)) return undefined;
  const start = leftStart ? Number(leftStart) : issue.start_line;
  const end = leftEnd ? Number(leftEnd) : issue.end_line;
  if (!Number.isSafeInteger(start) || start <= 0 || !Number.isSafeInteger(end) || end < start) return undefined;
  return { heading: priority ? `${priority} ${title}` : title, content, side, start, end };
}

export function buildReviewComments({ issues, files, head }) {
  if (!Array.isArray(issues) || !Array.isArray(files) || typeof head !== 'string' || !head) return [];
  const paths = indexChangedPaths(files);
  const parsedPatches = new Map();
  const comments = new Map();
  for (const issue of issues) {
    const finding = parseFinding(issue);
    if (!finding) continue;
    const { heading, content, side: requestedSide, start, end } = finding;
    const matches = paths.get(issue.relevant_file) ?? paths.get(issue.relevant_file.trim()) ?? [];
    const candidates = matches.filter(({ onlySide }) => !requestedSide || !onlySide || onlySide === requestedSide);
    if (candidates.length !== 1) continue;
    const [{ file, onlySide }] = candidates;
    const side = requestedSide ?? onlySide;
    if (!side) continue;

    if (!parsedPatches.has(file)) parsedPatches.set(file, parseReviewPatch(file.patch).hunks);
    const hunk = parsedPatches.get(file).find(({ [side]: range }) =>
      start >= range.start && end < range.end);
    const line = hunk?.[side].lines.find(({ number }) => number >= start && number <= end)?.number;
    if (line === undefined) continue;

    const path = file.filename;
    const hash = createHash('sha256').update(JSON.stringify([head, path, side, line, heading, content])).digest('hex');
    const marker = `<!-- heluo-forge-pr-agent-comment:v1 ${hash} -->`;
    const body = `**${heading}**\n\n${content}\n\n${marker}`;
    comments.set(marker, { path, line, side, body });
  }
  return [...comments.values()];
}
