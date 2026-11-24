/**
 * Draft Release uploader tests (CORP-DSH-PLAN-026 §4.0).
 *
 * The uploader is the only code in the repository that writes to GitHub on
 * behalf of a build. These tests pin what may reach the Release (assets of the
 * uploaded directory, nothing else), what must never happen (creating a tag,
 * touching a published Release) and where the token may travel.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { listAssets, parseArguments, ReleaseUploadError, uploadDraftRelease } from '../scripts/upload-draft-release.mjs';

// Assembled at runtime and deliberately unlike a real token format: the public
// source archive is scanned without the test-line exemption.
const TOKEN = ['synthetic', 'upload', 'token', 'value'].join('-');
const REPO = 'corp-example/heluo-forge';
const TAG = 'v1.2.3';
const SCRIPT = fileURLToPath(new URL('../scripts/upload-draft-release.mjs', import.meta.url));
const API = 'https://api.github.test';
const UPLOADS = 'https://uploads.github.test';
const uploadUrlOf = (id) => `${UPLOADS}/repos/${REPO}/releases/${id}/assets{?name,label}`;

function directory(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'forge-upload-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  return root;
}

async function rejects(promise, code, pattern) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ReleaseUploadError, `expected ReleaseUploadError, got ${error?.name}: ${error?.message}`);
    assert.equal(error.code, code);
    if (pattern instanceof RegExp) assert.match(error.message, pattern);
    else if (typeof pattern === 'function') assert.ok(pattern(error.message), `message failed its check: ${error.message}`);
    return true;
  });
}

/**
 * An in-memory GitHub: the REST surface the uploader uses, with scripted
 * faults. Each request is recorded with the bytes actually sent, so a test can
 * assert both what reached "GitHub" and what was never sent.
 */
function fakeGitHub({ releases = [], tags = [TAG], faults = {} } = {}) {
  const state = { releases: releases.map((release) => ({ assets: [], ...release })), tags: new Set(tags), nextId: 100 };
  const calls = [];
  const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const byId = (id) => state.releases.find((release) => release.id === id);

  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = init.method;
    const body = init.body === undefined ? null : Buffer.from(await new Response(init.body).arrayBuffer());
    calls.push({
      method,
      path: parsed.pathname,
      query: parsed.search,
      host: parsed.host,
      authorization: init.headers?.authorization,
      contentType: init.headers?.['content-type'],
      body,
      // Whether fetch was handed a stream body: only a buffered body makes the
      // real client send the Content-Length the upload endpoint requires.
      streamedBody: init.body instanceof ReadableStream,
    });
    const { pathname: path } = parsed;
    const upload = /^\/repos\/[^/]+\/[^/]+\/releases\/(\d+)\/assets$/u.exec(path);

    if (method === 'GET' && /\/releases$/u.test(path)) {
      return faults.lookup ? json(faults.lookup, { message: 'Forbidden' }) : json(200, state.releases);
    }
    if (method === 'GET' && /\/git\/ref\/tags\//u.test(path)) {
      const name = decodeURIComponent(path.slice(path.lastIndexOf('/') + 1));
      return state.tags.has(name) ? json(200, { ref: `refs/tags/${name}` }) : json(404, { message: 'Not Found' });
    }
    if (method === 'POST' && /\/releases$/u.test(path)) {
      if (faults.create !== undefined) {
        if (faults.racedDraft !== undefined) state.releases.push({ assets: [], ...faults.racedDraft });
        return json(faults.create, { message: faults.createMessage ?? 'Server Error' });
      }
      const request = JSON.parse(body.toString('utf8'));
      const release = {
        id: state.nextId,
        tag_name: request.tag_name,
        name: request.name,
        body: request.body,
        draft: request.draft,
        prerelease: request.prerelease,
        assets: [],
        upload_url: uploadUrlOf(state.nextId),
      };
      state.nextId += 1;
      state.releases.push(release);
      return json(201, release);
    }
    if (method === 'GET' && /\/releases\/\d+$/u.test(path)) {
      const release = byId(Number(path.slice(path.lastIndexOf('/') + 1)));
      return release === undefined ? json(404, { message: 'Not Found' }) : json(200, release);
    }
    if (method === 'DELETE' && /\/releases\/assets\/\d+$/u.test(path)) {
      const id = Number(path.slice(path.lastIndexOf('/') + 1));
      for (const release of state.releases) {
        const index = release.assets.findIndex((asset) => asset.id === id);
        if (index !== -1) {
          release.assets.splice(index, 1);
          return new Response(null, { status: 204 });
        }
      }
      return json(404, { message: 'Not Found' });
    }
    if (method === 'POST' && upload !== null) {
      if (faults.upload !== undefined) return json(faults.upload, { message: 'Bad Gateway' });
      const name = new URLSearchParams(parsed.search).get('name');
      const asset = {
        id: state.nextId,
        name: faults.rename === undefined ? name : faults.rename(name),
        size: body.length + (faults.resize ?? 0),
        state: 'uploaded',
      };
      state.nextId += 1;
      if (faults.drop !== true) byId(Number(upload[1])).assets.push(asset);
      return json(201, asset);
    }
    return json(500, { message: `unrouted ${method} ${path}` });
  };

  const of = (method, pattern) => calls.filter((call) => call.method === method && pattern.test(call.path));
  return { api: API, state, calls, fetchImpl, of };
}

const run = (github, dir, extra = {}) =>
  uploadDraftRelease({ tag: TAG, directory: dir, token: TOKEN, repo: REPO, fetchImpl: github.fetchImpl, apiBase: github.api, ...extra });
const writes = (github) => github.calls.filter((call) => call.method !== 'GET');

test('a new draft is created for an existing tag and every file is attached and read back', async (t) => {
  const github = fakeGitHub();
  const sums = `${'a'.repeat(64)}  heluo-forge-employee-1.2.3-assets.zip\n`;
  const dir = directory(t, { 'heluo-forge-employee-1.2.3-assets.zip': 'zip-bytes-1234', SHA256SUMS: sums });
  const result = await run(github, dir, { notes: 'source commit: 0000000000000000000000000000000000000000' });
  assert.deepEqual(result, {
    tag: TAG,
    releaseId: 100,
    draft: true,
    created: true,
    assets: [
      { name: 'SHA256SUMS', bytes: Buffer.byteLength(sums) },
      { name: 'heluo-forge-employee-1.2.3-assets.zip', bytes: 14 },
    ],
  });
  // The tag is looked up before the draft is created, and never written.
  assert.deepEqual(
    github.calls.slice(0, 3).map((call) => `${call.method} ${call.path}`),
    ['GET /repos/corp-example/heluo-forge/releases', 'GET /repos/corp-example/heluo-forge/git/ref/tags/v1.2.3', 'POST /repos/corp-example/heluo-forge/releases'],
  );
  const created = github.of('POST', /\/releases$/u);
  assert.equal(created.length, 1);
  assert.deepEqual(JSON.parse(created[0].body.toString('utf8')), {
    tag_name: TAG,
    name: TAG,
    body: 'source commit: 0000000000000000000000000000000000000000',
    draft: true,
    prerelease: false,
  });
  // Assets go to the Release's upload host, as raw bytes, in name order.
  const uploaded = github.of('POST', /\/assets$/u);
  assert.deepEqual(
    uploaded.map((call) => [call.query, call.body.toString('utf8')]),
    [['?name=SHA256SUMS', sums], ['?name=heluo-forge-employee-1.2.3-assets.zip', 'zip-bytes-1234']],
  );
  assert.ok(uploaded.every((call) => call.host === 'uploads.github.test' && call.contentType === 'application/octet-stream'));
  // Every request carries the token; no request carries it anywhere else.
  assert.ok(github.calls.every((call) => call.authorization === `Bearer ${TOKEN}`));
  assert.equal(github.calls.some((call) => `${call.path}${call.query}`.includes(TOKEN) || call.body?.includes(TOKEN)), false);
});

test('assets are uploaded as buffered bodies, because a stream body carries no Content-Length', async (t) => {
  const github = fakeGitHub();
  const dir = directory(t, { 'a.zip': '01234567' });
  await run(github, dir);
  const uploaded = github.of('POST', /\/assets$/u);
  assert.equal(uploaded.length, 1);
  // The first real tag push failed with "HTTP 400 Bad Content-Length": fetch
  // sends a stream body chunked, and the upload API rejects a request whose
  // length it cannot know up front. The body must therefore be buffered.
  assert.equal(uploaded[0].streamedBody, false);
});

test('an existing draft is reused and its same-name assets are replaced', async (t) => {
  const github = fakeGitHub({
    releases: [{ id: 7, tag_name: TAG, draft: true, upload_url: uploadUrlOf(7), assets: [{ id: 1, name: 'a.zip', size: 3 }] }],
  });
  const dir = directory(t, { 'a.zip': '01234567', 'b.zip': 'other' });
  const result = await run(github, dir);
  assert.equal(result.created, false);
  assert.equal(result.releaseId, 7);
  assert.equal(github.of('POST', /\/releases$/u).length, 0);
  assert.deepEqual(github.of('DELETE', /./u).map((call) => call.path), ['/repos/corp-example/heluo-forge/releases/assets/1']);
  assert.equal(github.of('POST', /\/assets$/u).length, 2);
  assert.deepEqual(github.state.releases[0].assets.map((asset) => asset.name), ['a.zip', 'b.zip']);
});

test('a published Release is refused and nothing is uploaded or deleted', async (t) => {
  const github = fakeGitHub({
    releases: [{ id: 9, tag_name: TAG, draft: false, upload_url: uploadUrlOf(9), assets: [{ id: 3, name: 'a.zip', size: 3 }] }],
  });
  await rejects(run(github, directory(t, { 'a.zip': '01234567' })), 'RELEASE_PUBLISHED', /already published/);
  assert.equal(writes(github).length, 0);
});

test('a missing tag is reported and never created', async (t) => {
  const github = fakeGitHub({ tags: [] });
  await rejects(run(github, directory(t, { 'a.zip': '01234567' })), 'TAG_MISSING', /never creates a tag/);
  assert.equal(writes(github).length, 0);
});

test('assets that are dropped, renamed or resized after the upload fail the run', async (t) => {
  const dir = directory(t, { 'a.zip': '01234567' });
  for (const [faults, pattern] of [
    [{ drop: true }, /a\.zip: not attached after upload/],
    [{ rename: (name) => `renamed-${name}` }, /a\.zip: not attached after upload/],
    [{ resize: -1 }, /a\.zip: 7 bytes on the Release, 8 bytes uploaded/],
  ]) {
    await rejects(run(fakeGitHub({ faults }), dir), 'ASSET_MISMATCH', pattern);
  }
});

test('a missing token fails before any request', async (t) => {
  const dir = directory(t, { 'a.zip': '01234567' });
  for (const token of [undefined, '', '   ']) {
    const github = fakeGitHub();
    await rejects(run(github, dir, { token }), 'TOKEN_MISSING');
    assert.equal(github.calls.length, 0);
  }
});

test('an empty, nested, unsafely named or unreadable directory is refused before any request', async (t) => {
  const github = fakeGitHub();
  const empty = directory(t, {});
  const nested = directory(t, { 'a.zip': '01234567' });
  mkdirSync(join(nested, 'sub'));
  writeFileSync(join(nested, 'sub', 'x.zip'), 'x');
  const unsafe = directory(t, { 'a b.zip': '01234567' });
  await rejects(run(github, empty), 'DIRECTORY_EMPTY');
  await rejects(run(github, nested), 'DIRECTORY_NESTED', /sub\//);
  await rejects(run(github, unsafe), 'ASSET_NAME_INVALID');
  await rejects(run(github, join(empty, 'missing')), 'DIRECTORY_INVALID');
  assert.equal(github.calls.length, 0);
  assert.deepEqual(listAssets(directory(t, { 'b.zip': '12', 'a.zip': '1', 'A-1_2.3.zip': '123' })).map((asset) => asset.name), [
    'A-1_2.3.zip',
    'a.zip',
    'b.zip',
  ]);
});

test('a failed creation fails the run without uploading; losing a creation race adopts the other draft', async (t) => {
  const dir = directory(t, { 'a.zip': '01234567' });
  const failing = fakeGitHub({ faults: { create: 500 } });
  await rejects(run(failing, dir), 'RELEASE_CREATE_FAILED', /HTTP 500/);
  assert.equal(failing.of('POST', /\/assets$/u).length, 0);

  const raced = fakeGitHub({
    faults: { create: 422, racedDraft: { id: 55, tag_name: TAG, draft: true, upload_url: uploadUrlOf(55) } },
  });
  const result = await run(raced, dir);
  assert.equal(result.created, false);
  assert.equal(result.releaseId, 55);
  assert.deepEqual(raced.state.releases[0].assets.map((asset) => asset.name), ['a.zip']);
});

test('failed requests are reported by class', async (t) => {
  const dir = directory(t, { 'a.zip': '01234567' });
  await rejects(run(fakeGitHub({ faults: { lookup: 403 } }), dir), 'RELEASE_LOOKUP_FAILED', /HTTP 403/);
  await rejects(run(fakeGitHub({ faults: { create: 401 } }), dir), 'RELEASE_CREATE_FAILED', /HTTP 401/);
  await rejects(run(fakeGitHub({ faults: { upload: 502 } }), dir), 'ASSET_UPLOAD_FAILED', /uploading a\.zip: HTTP 502/);

  const offline = fakeGitHub();
  offline.fetchImpl = async () => {
    const error = new Error('connect ECONNREFUSED 127.0.0.1:443');
    error.cause = { code: 'ECONNREFUSED' };
    throw error;
  };
  await rejects(run(offline, dir), 'GITHUB_UNREACHABLE', /GET \/repos\/corp-example\/heluo-forge\/releases failed before a response arrived \(ECONNREFUSED\)/);
});

test('the token stays out of arguments, errors and the receipt', async (t) => {
  const dir = directory(t, { 'a.zip': '01234567' });
  // Not an argument: the flag is refused by name and its value is not repeated.
  assert.throws(
    () => parseArguments(['--tag', TAG, '--directory', 'd', '--token', TOKEN]),
    (error) => error.code === 'BAD_ARGUMENT' && error.message === 'unknown argument --token',
  );
  // Not in a network failure, even when the lower layer's text carries it.
  const leaky = fakeGitHub();
  leaky.fetchImpl = async () => {
    const error = new Error(`request failed for Bearer ${TOKEN}`);
    error.cause = { code: 'ECONNRESET' };
    throw error;
  };
  await rejects(run(leaky, dir), 'GITHUB_UNREACHABLE', (message) => !message.includes(TOKEN) && message.includes('ECONNRESET'));
  // Not in an HTTP failure, even when the response body echoes it.
  const echoing = fakeGitHub({ faults: { create: 401, createMessage: `Bad credentials: ${TOKEN}` } });
  await rejects(run(echoing, dir), 'RELEASE_CREATE_FAILED', (message) => !message.includes(TOKEN) && message.includes('[redacted]'));
  // Not in the receipt.
  const result = await run(fakeGitHub(), dir);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('CLI reads the token from GH_TOKEN only', async (t) => {
  const dir = directory(t, { 'a.zip': '01234567' });
  const env = { ...process.env, GH_TOKEN: '', GITHUB_REPOSITORY: '' };
  const refused = spawnSync(process.execPath, [SCRIPT, '--tag', TAG, '--directory', dir, '--repo', REPO, '--token', TOKEN], { encoding: 'utf8', env });
  assert.equal(refused.status, 1);
  assert.equal(refused.stderr, 'BAD_ARGUMENT: unknown argument --token\n');
  const missing = spawnSync(process.execPath, [SCRIPT, '--tag', TAG, '--directory', dir, '--repo', REPO], { encoding: 'utf8', env });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /^TOKEN_MISSING: GH_TOKEN is not set/);
  assert.equal(missing.stdout, '');
});
