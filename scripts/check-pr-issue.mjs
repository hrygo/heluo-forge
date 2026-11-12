import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export async function validateIssueReference(body, lookup) {
  const visible = (body ?? '').replace(/<!--[\s\S]*?(?:-->|$)/gu, '');
  const numbers = [];
  let fence = null;
  for (const line of visible.split(/\r?\n/u)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && /^\s*$/u.test(marker[2])) fence = null;
      continue;
    }
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
