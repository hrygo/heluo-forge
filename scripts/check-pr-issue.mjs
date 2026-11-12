import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export async function validateIssueReference(body, lookup) {
  const numbers = [];
  let fence = null;
  let inComment = false;
  for (const rawLine of (body ?? '').split(/\r?\n/u)) {
    // A comment marker inside a fenced example is literal text.
    if (fence) {
      const close = /^ *(`{3,}|~{3,})[ \t]*$/u.exec(rawLine);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    const opening = !inComment && /^ {0,3}(?:(?:[-+*]|[0-9]{1,9}[.)])[ \t]+)?(`{3,}|~{3,})[^\n]*$/u.exec(rawLine);
    if (opening) { fence = opening[1]; continue; }
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
    const marker = /^ {0,3}(?:(?:[-+*]|[0-9]{1,9}[.)])[ \t]+)?(`{3,}|~{3,})[^\n]*$/u.exec(line);
    if (marker) { fence = marker[1]; continue; }
    const match = /^ {0,3}(?:[-*] +)?(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?|part of)[ \t]*:?[ \t]+#([1-9]\d*)[ \t]*$/iu.exec(line);
    if (match) numbers.push(match[1]);
  }
  for (const number of new Set(numbers)) {
    const result = await lookup(number);
    if (result.ok && !result.isPullRequest) return true;
  }
  return false;
}

export async function checkPullRequest({ event, ref, repository, apiUrl, token, fetcher = fetch }) {
  const refNumber = /^refs\/pull\/([1-9]\d*)\/merge$/u.exec(ref ?? '')?.[1];
  const eventNumber = event?.number == null ? undefined : String(event.number);
  if (!refNumber || (eventNumber && eventNumber !== refNumber) || !/^[^/]+\/[^/]+$/u.test(repository ?? '') || !apiUrl || !token) {
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
  const valid = await checkPullRequest({ event, ref: process.env.GITHUB_REF, repository: process.env.GITHUB_REPOSITORY, apiUrl: process.env.GITHUB_API_URL, token: process.env.GITHUB_TOKEN });
  if (!valid) throw new Error('PR 正文须单独一行填写 Closes #编号 或 Part of #编号，关联本仓库已有 Issue。');
  console.log('PR issue reference verified.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
