import { pathToFileURL } from 'node:url';

export const MANAGED = Object.freeze(['review: awaiting review', 'review: changes requested', 'review: awaiting re-review', 'review: approved']);

export function desiredLabel(pr) {
  if (!['OPEN', 'CLOSED', 'MERGED'].includes(pr.state) || typeof pr.isDraft !== 'boolean') throw new Error('Invalid PR state');
  if (pr.state !== 'OPEN' || pr.isDraft) return null;
  switch (pr.reviewDecision) {
    case null:
    case 'REVIEW_REQUIRED': return MANAGED[0];
    case 'CHANGES_REQUESTED': return MANAGED[1];
    case 'APPROVED': return MANAGED[3];
    default: throw new Error('Unknown review decision');
  }
}

export async function reconcile(api, pr) {
  const desired = desiredLabel(pr);
  if (!Array.isArray(pr.labels)) throw new Error('Invalid labels');
  const current = new Set(pr.labels.map(label => label.name));
  let changed = false;
  for (const label of MANAGED) if (current.has(label) && label !== desired) { await api.remove(pr.number, label); changed = true; }
  if (desired && !current.has(desired)) { await api.add(pr.number, desired); changed = true; }
  return changed;
}

export async function syncAll(api) {
  let cursor = null;
  const seen = new Set();
  const failures = [];
  do {
    const page = await api.list(cursor);
    if (!Array.isArray(page.prs) || (page.next !== null && (typeof page.next !== 'string' || !page.next || seen.has(page.next)))) throw new Error('Invalid cursor or PR list');
    if (page.next !== null) seen.add(page.next);
    for (const number of page.prs) {
      try {
        let stable = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (!await reconcile(api, await api.read(number))) { stable = true; break; }
        }
        if (!stable) throw new Error('state did not stabilize');
      } catch (error) {
        failures.push(number);
        console.error(`PR ${number}: ${error.message}`);
      }
    }
    cursor = page.next;
  } while (cursor !== null);
  if (failures.length) throw new Error(`Failed to synchronize ${failures.length} PR(s): ${failures.join(', ')}`);
}

export function githubApi({ token, repository, apiUrl = 'https://api.github.com', fetchImpl = fetch }) {
  if (!token || !/^[^/\s]+\/[^/\s]+$/.test(repository ?? '')) throw new Error('Missing GitHub configuration');
  const [owner, name] = repository.split('/');
  async function request(path, options = {}) {
    const response = await fetchImpl(`${apiUrl}${path}`, { ...options, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  }
  async function graphql(query, variables) {
    const result = await request('/graphql', { method: 'POST', body: JSON.stringify({ query, variables: { owner, name, ...variables } }) });
    if (result.errors?.length || !result.data?.repository) throw new Error('GitHub GraphQL query failed');
    return result.data.repository;
  }
  return {
    async list(cursor) {
      const repo = await graphql('query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){pullRequests(first:100,states:OPEN,after:$cursor){nodes{number} pageInfo{hasNextPage endCursor}}}}', { cursor });
      const page = repo.pullRequests;
      if (!page || typeof page.pageInfo?.hasNextPage !== 'boolean' || !Array.isArray(page.nodes)) throw new Error('Invalid PR page');
      if (page.pageInfo.hasNextPage && (typeof page.pageInfo.endCursor !== 'string' || !page.pageInfo.endCursor)) throw new Error('Invalid PR page cursor');
      return { prs: page.nodes.map(pr => pr.number), next: page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null };
    },
    async read(number) {
      if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid PR number');
      const repo = await graphql('query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){number state isDraft reviewDecision labels(first:100){nodes{name} pageInfo{hasNextPage}}}}}', { number });
      const pr = repo.pullRequest;
      if (!pr || pr.number !== number || pr.labels?.pageInfo?.hasNextPage !== false || !Array.isArray(pr.labels.nodes)) throw new Error('Invalid or incomplete PR data');
      return { ...pr, labels: pr.labels.nodes };
    },
    async add(number, label) { await request(`/repos/${repository}/issues/${number}/labels`, { method: 'POST', body: JSON.stringify({ labels: [label] }) }); },
    async remove(number, label) { await request(`/repos/${repository}/issues/${number}/labels/${encodeURIComponent(label)}`, { method: 'DELETE' }); },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await syncAll(githubApi({ token: process.env.GITHUB_TOKEN, repository: process.env.GITHUB_REPOSITORY, apiUrl: process.env.GITHUB_API_URL }));
    console.log('PR review labels synchronized');
  } catch (error) {
    console.error(`PR review label synchronization failed: ${error.message}`);
    process.exitCode = 1;
  }
}
