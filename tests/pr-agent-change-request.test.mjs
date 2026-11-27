import assert from 'node:assert/strict';
import { test } from 'node:test';

import { handleChangeRequests, parseChangeRequest } from '../scripts/pr-agent-change-request.mjs';

const repository = 'corp/example';
const prNumber = 42;
const pull = `/pulls/${prNumber}`;
const reviewList = `${pull}/reviews?per_page=100&page=1`;
const author = { id: 107, login: 'maintainer', type: 'User' };
const bot = { id: 108, login: 'github-actions[bot]', type: 'Bot' };
const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const target = 'release/candidate=1';
const body = `/request-changes P1 ${head} ${base} ${target}`;
const legacy = `<!-- heluo-forge-pr-agent-priority-rc:v1 ${head} ${base} -->`;

function fakeGitHub() {
  const event = {
    action: 'created',
    repository: { full_name: repository },
    issue: { number: prNumber, pull_request: {} },
    sender: { ...author },
    comment: { id: 109, body, user: { ...author } },
  };
  const state = {
    event,
    comment: { ...event.comment, issue_url: `https://api.github.test/repos/${repository}/issues/${prNumber}` },
    permission: 'write',
    pr: {
      number: prNumber,
      state: 'open',
      draft: false,
      head: { sha: head, repo: { full_name: repository } },
      base: { ref: target, repo: { full_name: repository } },
    },
    base,
    reviews: [],
    writes: [],
    gets: [],
  };
  const github = {
    repository,
    serverUrl: 'https://github.test',
    async get(path) {
      state.gets.push(path);
      const injected = state.beforeGet?.(path);
      if (injected !== undefined) return injected;
      if (path === pull) return structuredClone(state.pr);
      if (path === `/issues/comments/${event.comment.id}`) return structuredClone(state.comment);
      if (path === `/collaborators/${author.login}/permission`) return { permission: state.permission, user: structuredClone(author) };
      if (path.startsWith('/git/ref/heads/')) {
        assert.equal(path, '/git/ref/heads/release%2Fcandidate%3D1');
        return { ref: `refs/heads/${target}`, object: { type: 'commit', sha: state.base } };
      }
      const page = /^\/pulls\/42\/reviews\?per_page=100&page=(\d+)$/u.exec(path);
      if (page) return structuredClone(state.reviews.slice(100 * (Number(page[1]) - 1), 100 * Number(page[1])));
      const review = /^\/pulls\/42\/reviews\/(\d+)$/u.exec(path);
      if (review) return structuredClone(state.reviews.find(({ id }) => id === Number(review[1])));
      assert.fail(`Unexpected GET ${path}`);
    },
    async post(path, data) {
      state.writes.push({ method: 'POST', path, data });
      assert.equal(path, `${pull}/reviews`);
      assert.equal(data.event, 'REQUEST_CHANGES');
      assert.equal(data.commit_id, head);
      if (state.failBeforeWrite) throw new Error('POST unavailable');
      const review = { id: 300 + state.reviews.length, body: data.body, commit_id: data.commit_id, state: 'CHANGES_REQUESTED', user: bot };
      state.reviews.push(review);
      state.afterPost?.(review);
      return structuredClone(review);
    },
    async put(path, data) {
      state.writes.push({ method: 'PUT', path, data });
      const review = /^\/pulls\/42\/reviews\/(\d+)(\/dismissals)?$/u.exec(path);
      assert.ok(review, `Unexpected PUT ${path}`);
      const item = state.reviews.find(({ id }) => id === Number(review[1]));
      assert.ok(item, `Unknown review ID ${review[1]}`);
      if (review[2]) {
        assert.equal(data.event, 'DISMISS');
        if (state.denyDismissal) throw new Error('Dismissal denied');
        item.state = 'DISMISSED';
      } else {
        if (state.failBodyUpdate) throw new Error('Body update unavailable');
        item.body = data.body;
      }
      state.afterPut?.(path, item);
      return structuredClone(item);
    },
  };
  const run = (args = {}) => handleChangeRequests({
    github,
    prNumber,
    event,
    command: parseChangeRequest(event.comment.body),
    ...args,
  });
  return { run, state };
}

test('recognizes one complete explicit command with two lower-case commit hashes and a target branch', () => {
  assert.deepEqual(parseChangeRequest(` \n${body}\r\n`), { priority: 'P1', head, base, baseRef: target });
  assert.deepEqual(parseChangeRequest(body.replace('P1', 'P0')), { priority: 'P0', head, base, baseRef: target });
  for (const invalid of [null, 'no command', `/review ${body}`, body.replace('P1', 'P2'),
    body.replace(head, head.toUpperCase()), body.replace(' P1 ', ' P1\n'),
    body.slice(0, -target.length).trimEnd(), `${body} extra`, `${body}\n${body}`]) {
    assert.equal(parseChangeRequest(invalid), undefined);
  }
});

test('an explicit maintainer command creates one review at the exact head and settles its pending banner', async () => {
  const { run, state } = fakeGitHub();
  await run();
  const [review] = state.reviews;
  assert.equal(review.commit_id, head);
  assert.equal(review.state, 'CHANGES_REQUESTED');
  assert.match(review.body, /\*\*P1\*\*/u);
  assert.match(review.body, /https:\/\/github\.test\/corp\/example\/pull\/42#issuecomment-109/u);
  assert.doesNotMatch(review.body, /尚待确认/u);
  assert.match(state.writes[0].data.body, /尚待确认/u);
  assert.equal(state.writes[1].path, `${pull}/reviews/${review.id}`);
  await run();
  assert.equal(state.writes.length, 2);
});

test('a failed post-publication revision read stays pending and the same command rerun settles it before deduplication', async () => {
  const { run, state } = fakeGitHub();
  state.afterPost = () => {
    state.beforeGet = (path) => {
      if (path === pull) throw new Error('PR revision read timed out');
    };
  };
  await assert.rejects(run(), /could not verify/iu);
  const [review] = state.reviews;
  assert.match(review.body, /尚待确认/u);
  assert.equal(review.state, 'CHANGES_REQUESTED');
  assert.equal(state.writes.length, 1);

  state.beforeGet = undefined;
  await run();
  assert.doesNotMatch(review.body, /尚待确认/u);
  assert.equal(state.writes.filter(({ method }) => method === 'POST').length, 1);
});

test('a new pull request revision triggers stale cleanup without any command and leaves older reviews alone', async () => {
  for (const change of [
    (state) => { state.pr.head.sha = 'c'.repeat(40); },
    (state) => { state.base = 'c'.repeat(40); },
    (state) => { state.pr.base.ref = 'another-target'; },
  ]) {
    const { run, state } = fakeGitHub();
    const historical = { id: 81, body: legacy, commit_id: head, state: 'CHANGES_REQUESTED', user: bot };
    // Leave unrelated old reviews in history when the pending publication is recovered.
    state.afterPost = (review) => {
      state.reviews.unshift(
        historical,
        { ...review, id: 82, user: author },
        { ...review, id: 83, commit_id: 'd'.repeat(40) },
      );
      state.beforeGet = (path) => {
        if (path === pull) throw new Error('PR revision read timed out');
      };
    };
    await assert.rejects(run(), /could not verify/iu);
    const pending = state.reviews.at(-1);
    state.beforeGet = undefined;
    change(state);
    await run({ command: undefined, event: undefined });
    assert.equal(pending.state, 'DISMISSED');
    assert.equal(historical.state, 'CHANGES_REQUESTED');
    assert.equal(state.reviews[1].state, 'CHANGES_REQUESTED');
    assert.equal(state.reviews[2].state, 'CHANGES_REQUESTED');
    assert.deepEqual(state.writes.map(({ path }) => path), [`${pull}/reviews`, `${pull}/reviews/${pending.id}/dismissals`]);
  }
});

test('a human command cannot publish for a stale head or base, draft, closed PR or fork', async () => {
  for (const mutate of [
    (state) => { state.pr.head.sha = 'c'.repeat(40); },
    (state) => { state.base = 'c'.repeat(40); },
    (state) => { state.pr.base.ref = 'release'; },
    (state) => { state.pr.draft = true; },
    (state) => { state.pr.state = 'closed'; },
    (state) => { state.pr.head.repo = { full_name: 'outside/fork' }; },
    (state) => { state.pr.base.repo = { full_name: 'outside/fork' }; },
  ]) {
    const { run, state } = fakeGitHub();
    mutate(state);
    await run();
    assert.deepEqual(state.writes, []);
  }
});

test('model output, edited or tampered commands, bots, and readers cannot create a change request', async () => {
  for (const mutate of [
    (state) => { state.event.action = 'edited'; },
    (state) => { state.event.repository.full_name = 'other/repo'; },
    (state) => { state.event.issue.number = 167; },
    (state) => { delete state.event.issue.pull_request; },
    (state) => { state.event.sender.id = 11; },
    (state) => { state.event.sender.type = 'Bot'; },
    (state) => { state.event.comment.user.type = 'Bot'; },
    (state) => { state.comment = { ...state.comment, body: `edited ${body}` }; },
    (state) => { state.comment = { ...state.comment, user: { ...author, id: 1 } }; },
    (state) => { state.comment = { ...state.comment, issue_url: 'https://api.github.test/repos/corp/example/issues/43' }; },
    (state) => { state.permission = 'triage'; },
    (state) => { state.permission = 'read'; },
  ]) {
    const { run, state } = fakeGitHub();
    mutate(state);
    await run();
    assert.deepEqual(state.writes, []);
  }
  const { run, state } = fakeGitHub();
  await run({ command: undefined, event: { review_result: { merge_recommendation: 'changes_required' } } });
  await run({ command: { ...parseChangeRequest(body), priority: 'P0' } });
  assert.deepEqual(state.writes, []);
});

test('authorization and base reads fail closed when GitHub cannot verify them', async () => {
  for (const endpoint of ['/collaborators/', '/issues/comments/', '/git/ref/heads/']) {
    const { run, state } = fakeGitHub();
    state.beforeGet = (path) => {
      if (path.startsWith(endpoint)) throw new Error('GitHub verification unavailable');
    };
    await assert.rejects(run(), /verification unavailable/u);
    assert.deepEqual(state.writes, []);
  }
});

test('a lost POST response recovers only the newly submitted review by its exact receipt', async () => {
  const { run, state } = fakeGitHub();
  state.afterPost = (review) => {
    state.reviews.unshift({ ...review, id: 20, user: author });
    throw new Error('lost response');
  };
  await run();
  assert.equal(state.writes.filter(({ method }) => method === 'POST').length, 1);
  assert.match(state.reviews[0].body, /尚待确认/u);
  assert.doesNotMatch(state.reviews[1].body, /尚待确认/u);
});

test('an uncertain POST without an exact receipt performs no second POST', async () => {
  const { run, state } = fakeGitHub();
  state.failBeforeWrite = true;
  await assert.rejects(run(), /could not establish/iu);
  assert.equal(state.writes.length, 1);
  assert.equal(state.gets.filter((path) => path === reviewList).length, 2);
});

test('a lost POST response followed by a failed list read retains the native receipt for a later run', async () => {
  const { run, state } = fakeGitHub();
  state.afterPost = () => {
    state.beforeGet = (path) => {
      if (path === reviewList) throw new Error('Review history temporarily unavailable');
    };
    throw new Error('lost response');
  };
  await assert.rejects(run(), /could not establish/iu);
  assert.match(state.reviews[0].body, /尚待确认/u);
  state.beforeGet = undefined;
  await run({ command: undefined });
  assert.doesNotMatch(state.reviews[0].body, /尚待确认/u);
  assert.equal(state.writes.filter(({ method }) => method === 'POST').length, 1);
});

test('retargeting during the ref read dismisses only the new review, even if the ref read fails', async () => {
  const { run, state } = fakeGitHub();
  state.afterPost = () => {
    state.beforeGet = (path) => {
      if (path.startsWith('/git/ref/heads/')) {
        state.pr.base.ref = 'another-target';
        throw new Error('old ref disappeared');
      }
    };
  };
  await run();
  const [review] = state.reviews;
  assert.equal(review.state, 'DISMISSED');
  assert.equal(state.writes[1].path, `${pull}/reviews/${review.id}/dismissals`);
});

test('denied dismissal marks the exact stale review and names the required maintainer action', async () => {
  const { run, state } = fakeGitHub();
  state.denyDismissal = true;
  state.afterPost = () => { state.pr.head.sha = 'c'.repeat(40); };
  await assert.rejects(run(), /requires maintainer dismissal/iu);
  const [review] = state.reviews;
  assert.equal(review.state, 'CHANGES_REQUESTED');
  assert.match(review.body, /已过期.*维护者.*解除/u);
  assert.doesNotMatch(review.body, /尚待确认/u);
  await run({ command: undefined });
  assert.equal(state.writes.length, 3);
});

test('an interrupted body update keeps the receipt available for a later recovery-only run', async () => {
  const { run, state } = fakeGitHub();
  state.failBodyUpdate = true;
  await assert.rejects(run(), /could not settle/iu);
  assert.match(state.reviews[0].body, /尚待确认/u);
  state.failBodyUpdate = false;
  await run({ command: undefined });
  assert.doesNotMatch(state.reviews[0].body, /尚待确认/u);
  assert.equal(state.writes.filter(({ method }) => method === 'POST').length, 1);
});

test('a legacy settled or dismissed bot review still deduplicates across review-list pages', async () => {
  for (const rowState of ['CHANGES_REQUESTED', 'DISMISSED']) {
    const { run, state } = fakeGitHub();
    const old = { id: 80, body: `旧请求\n\n${legacy}\n`, commit_id: head, state: rowState, user: bot };
    state.reviews.push(...Array.from({ length: 100 }, (_, index) => ({ ...old, id: index + 500, user: author })), old);
    await run();
    assert.ok(state.gets.includes(`${pull}/reviews?per_page=100&page=2`));
    assert.deepEqual(state.writes, []);
  }
});
