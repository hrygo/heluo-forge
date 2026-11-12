import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

function indentationWidth(prefix) {
  return [...prefix].reduce((width, char) => width + (char === '\t' ? 4 - width % 4 : 1), 0);
}

function openingFence(line) {
  const match = /^( {0,3}(?:(?:[-+*]|[0-9]{1,9}[.)])[ \t]+)?)(`{3,}|~{3,})[^\n]*$/u.exec(line);
  if (!match) return null;
  const listIndent = /[^ ]/u.test(match[1]) ? indentationWidth(match[1]) : 0;
  return { marker: match[2], listIndent };
}

export async function validateIssueReference(body, lookup) {
  const numbers = [];
  let fence = null;
  let inComment = false;
  for (const rawLine of (body ?? '').split(/\r?\n/u)) {
    // A comment marker inside a fenced example is literal text. A list item
    // ends its contained fence when a nonblank line leaves the list.
    if (fence) {
      const indent = indentationWidth(/^[ \t]*/u.exec(rawLine)[0]);
      if (fence.listIndent && rawLine.trim() && indent < fence.listIndent) {
        fence = null;
      } else {
        const close = /^[ \t]*(`{3,}|~{3,})[ \t]*$/u.exec(rawLine);
        if (close && indent - fence.listIndent <= 3 && close[1][0] === fence.marker[0] && close[1].length >= fence.marker.length) fence = null;
        continue;
      }
    }
    const opening = !inComment && openingFence(rawLine);
    if (opening) { fence = opening; continue; }
    let line = '';
    let remaining = rawLine;
    while (remaining) {
      if (inComment) {
        const end = remaining.indexOf('-->');
        if (end < 0) break;
        inComment = false;
        remaining = remaining.slice(end + 3);
      } else {
        const start = remaining.indexOf('<!--');
        if (start < 0) { line += remaining; break; }
        line += remaining.slice(0, start);
        remaining = remaining.slice(start + 4);
        inComment = true;
      }
    }
    const marker = openingFence(line);
    if (marker) { fence = marker; continue; }
    const match = /^ {0,3}(?:[-*] +)?(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?|part of)[ \t]*:?[ \t]+#([1-9]\d*)[ \t]*$/iu.exec(line);
    if (match) numbers.push(match[1]);
  }
  for (const number of new Set(numbers)) {
    const result = await lookup(number);
    if (result.ok && !result.isPullRequest) return true;
  }
  return false;
}

export async function checkPullRequest({ event, eventName = 'pull_request', ref, repository, apiUrl, token, fetcher = fetch }) {
  const eventNumbers = [event?.number, event?.pull_request?.number].filter((number) => number != null).map(String);
  const refNumber = eventName === 'pull_request' ? /^refs\/pull\/([1-9]\d*)\/merge$/u.exec(ref ?? '')?.[1]
    : eventName === 'pull_request_target' && /^refs\/heads\/.+$/u.test(ref ?? '') ? eventNumbers[0] : undefined;
  if (!refNumber || !/^[1-9]\d*$/u.test(refNumber) || eventNumbers.some((number) => number !== refNumber) || !/^[^/]+\/[^/]+$/u.test(repository ?? '') || !apiUrl || !token) {
    throw new Error('Missing or inconsistent GitHub PR context');
  }
  const get = async (path) => fetcher(`${apiUrl}/repos/${repository}/${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
  });
  const pr = await get(`pulls/${refNumber}`);
  if (!pr.ok) throw new Error(`GitHub PR lookup failed: HTTP ${pr.status}`);
  const data = await pr.json();
  return validateIssueReference(data.body, async (number) => {
    const response = await get(`issues/${number}`);
    if (response.status === 404) return { ok: false };
    if (!response.ok) throw new Error(`GitHub issue lookup failed: HTTP ${response.status}`);
    const issue = await response.json();
    return { ok: true, isPullRequest: Boolean(issue.pull_request) };
  });
}

async function main() {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const valid = await checkPullRequest({ event, eventName: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF, repository: process.env.GITHUB_REPOSITORY, apiUrl: process.env.GITHUB_API_URL, token: process.env.GITHUB_TOKEN });
  if (!valid) throw new Error('PR 正文须单独一行填写 Closes #编号 或 Part of #编号，关联本仓库已有 Issue。');
  console.log('PR issue reference verified.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
