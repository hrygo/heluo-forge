#!/usr/bin/env node
/**
 * Draft Release uploader (CORP-DSH-PLAN-026 §4.0).
 *
 * Attaches the files of one directory as assets of the draft Release that
 * belongs to an existing tag. Fail-closed rules:
 *
 *   - The tag is an input, never an output: a missing tag is `TAG_MISSING`,
 *     and no tag is ever created here.
 *   - A published Release is never touched (`RELEASE_PUBLISHED`) and nothing is
 *     uploaded. A draft is reused and same-name assets are replaced, which is
 *     what a re-run on the same tag needs.
 *   - Assets are read back after the upload and compared by name and size
 *     (`ASSET_MISMATCH`): a missing, renamed or truncated asset fails the run.
 *   - The token is read from GH_TOKEN only. It is never a parameter, and it
 *     appears in no error message, receipt or log line.
 *
 * 用法：
 *   GH_TOKEN=<token> node scripts/upload-draft-release.mjs --tag <v-semver> \
 *     --directory <dir> [--repo <owner/name>] [--name <title>] [--notes <file>] [--json]
 */
import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

export const GITHUB_API = 'https://api.github.com';
/** Release assets are a flat list shown by name: ASCII letters, digits, dot, dash and underscore survive unchanged. */
export const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9.-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const PER_PAGE = 100;
const MAX_PAGES = 50;

export class ReleaseUploadError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ReleaseUploadError';
    this.code = code;
    this.details = details;
  }
}

const fail = (code, message, details) => {
  throw new ReleaseUploadError(code, message, details);
};

export function parseArguments(argv) {
  const options = { tag: undefined, directory: undefined, repo: undefined, name: undefined, notes: undefined, json: false };
  const valued = new Map([
    ['--tag', 'tag'],
    ['--directory', 'directory'],
    ['--repo', 'repo'],
    ['--name', 'name'],
    ['--notes', 'notes'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (valued.has(argument)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) fail('BAD_ARGUMENT', `${argument} requires a value`);
      options[valued.get(argument)] = value;
      index += 1;
      continue;
    }
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    // Named by flag only: a value that follows an unknown flag (a token, say)
    // must not be repeated back. A token on the command line also lands in
    // process listings and shell history, which is why there is no such flag.
    fail('BAD_ARGUMENT', `unknown argument ${argument}`);
  }
  for (const [flag, key] of [['--tag', 'tag'], ['--directory', 'directory']]) {
    if (typeof options[key] !== 'string' || options[key].trim() === '') fail('BAD_ARGUMENT', `${flag} is required`);
  }
  return options;
}

/** The flat, safely named regular files of `directory`, sorted by name. */
export function listAssets(directory) {
  let entries;
  try {
    if (!statSync(directory).isDirectory()) fail('DIRECTORY_INVALID', 'asset directory must be a directory');
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof ReleaseUploadError) throw error;
    fail('DIRECTORY_INVALID', 'asset directory cannot be read; check that it exists');
  }
  const assets = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    // Two nested files with the same name would collide on the flat asset list.
    if (entry.isDirectory()) {
      fail('DIRECTORY_NESTED', `${entry.name}/ is a directory; pack nested content into one archive before uploading`);
    }
    if (!entry.isFile()) fail('DIRECTORY_INVALID', `${entry.name} is not a regular file`);
    if (!ASSET_NAME.test(entry.name)) {
      fail('ASSET_NAME_INVALID', `${entry.name} is not a safe asset name (ASCII letters, digits, dot, dash and underscore only)`);
    }
    assets.push({ name: entry.name, path, bytes: statSync(path).size });
  }
  if (assets.length === 0) fail('DIRECTORY_EMPTY', 'asset directory contains no files; nothing to upload');
  return assets.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

/** `upload_url` is a URI template: `{?name,label}` becomes the query that names the asset. */
function uploadUrl(template, name) {
  if (typeof template !== 'string' || !template.endsWith('{?name,label}')) {
    fail('RELEASE_INVALID', 'the Release carries no upload URL template');
  }
  return `${template.slice(0, -'{?name,label}'.length)}?name=${encodeURIComponent(name)}`;
}

/** Only the error class of a failed request: a network error's text can echo request details. */
function failureClass(error) {
  return error?.cause?.code ?? error?.code ?? error?.name ?? 'UNKNOWN';
}

function describe(data) {
  const message = typeof data?.message === 'string' ? data.message : 'no error message';
  const details = Array.isArray(data?.errors) ? data.errors.map((item) => item.code ?? item.message).filter(Boolean) : [];
  return details.length === 0 ? message : `${message} (${details.join(', ')})`;
}

function githubClient({ token, fetchImpl, apiBase, repo }) {
  // Error text is built from response fields; should a body echo the token
  // back, it is removed before the text can reach a message.
  const describe_ = (data) => describe(data).split(token).join('[redacted]');
  const headersOf = (extra) => ({
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'heluo-forge-release-bundle',
    'x-github-api-version': '2022-11-28',
    ...extra,
  });

  async function call(method, url, { body, headers } = {}) {
    let response;
    let text;
    try {
      response = await fetchImpl(url, { method, headers: headersOf(headers), body, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) });
      text = await response.text();
    } catch (error) {
      const endpoint = `${method} ${new URL(url).pathname}`;
      fail('GITHUB_UNREACHABLE', `${endpoint} failed before a response arrived (${failureClass(error)})`);
    }
    let data = null;
    if (text !== '') {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    return { status: response.status, data };
  }

  const expect = (result, status, code, what) => {
    if (result.status !== status) fail(code, `${what}: HTTP ${result.status} ${describe_(result.data)}`);
    return result.data;
  };
  const api = (path) => `${apiBase}/repos/${repo}${path}`;

  /** The Release of `tag`, or null. The list is the source that includes drafts. */
  async function findRelease(tag) {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const result = await call('GET', api(`/releases?per_page=${PER_PAGE}&page=${page}`));
      const list = expect(result, 200, 'RELEASE_LOOKUP_FAILED', `listing the Releases of ${repo}`);
      const match = list.find((item) => item.tag_name === tag);
      if (match !== undefined) return match;
      if (list.length < PER_PAGE) return null;
    }
    return null;
  }

  async function requireTag(tag) {
    const result = await call('GET', api(`/git/ref/tags/${encodeURIComponent(tag)}`));
    if (result.status === 404) fail('TAG_MISSING', `tag ${tag} does not exist; this uploader never creates a tag`);
    expect(result, 200, 'TAG_LOOKUP_FAILED', `looking up tag ${tag}`);
  }

  /** The draft of `tag` and whether this call created it. */
  async function createDraft({ tag, name, notes }) {
    const result = await call('POST', api('/releases'), {
      body: JSON.stringify({ tag_name: tag, name, body: notes, draft: true, prerelease: false }),
      headers: { 'content-type': 'application/json' },
    });
    if (result.status === 201) return { release: result.data, created: true };
    // Another job of the same run may have created the draft first. Adopt it:
    // losing a race is not a reason to fail a matrix leg.
    const raced = await findRelease(tag);
    if (raced !== null) return { release: raced, created: false };
    fail('RELEASE_CREATE_FAILED', `creating the draft Release for ${tag}: HTTP ${result.status} ${describe_(result.data)}`);
  }

  async function replaceAsset(release, asset) {
    for (const stale of release.assets.filter((item) => item.name === asset.name)) {
      const removed = await call('DELETE', api(`/releases/assets/${stale.id}`));
      expect(removed, 204, 'ASSET_REPLACE_FAILED', `replacing ${asset.name}`);
    }
    const uploaded = await call('POST', uploadUrl(release.upload_url, asset.name), {
      body: Readable.toWeb(createReadStream(asset.path)),
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(uploaded, 201, 'ASSET_UPLOAD_FAILED', `uploading ${asset.name}`);
  }

  async function getRelease(id) {
    const result = await call('GET', api(`/releases/${id}`));
    return expect(result, 200, 'RELEASE_LOOKUP_FAILED', `reading back Release ${id}`);
  }

  return { findRelease, requireTag, createDraft, replaceAsset, getRelease };
}

/**
 * Attach every file of `directory` to the draft Release of `tag`.
 *
 * @param {{tag: string, directory: string, token: string, repo: string,
 *   name?: string, notes?: string, fetchImpl?: typeof fetch, apiBase?: string}} input
 *   `fetchImpl` and `apiBase` are injection points for tests.
 */
export async function uploadDraftRelease(input) {
  if (typeof input.tag !== 'string' || !TAG.test(input.tag)) {
    fail('TAG_INVALID', 'tag must be v<semver>, for example v1.2.3');
  }
  if (typeof input.repo !== 'string' || !REPOSITORY.test(input.repo)) {
    fail('BAD_ARGUMENT', 'repo must be given as owner/name (--repo or GITHUB_REPOSITORY)');
  }
  // Both checks precede every request: nothing is sent for an unusable input.
  if (typeof input.token !== 'string' || input.token.trim() === '') {
    fail('TOKEN_MISSING', 'GH_TOKEN is not set; the upload needs a token with contents: write');
  }
  const assets = listAssets(input.directory);
  const github = githubClient({
    token: input.token,
    fetchImpl: input.fetchImpl ?? globalThis.fetch,
    apiBase: (input.apiBase ?? GITHUB_API).replace(/\/+$/u, ''),
    repo: input.repo,
  });

  let release = await github.findRelease(input.tag);
  let created = false;
  if (release === null) {
    await github.requireTag(input.tag);
    ({ release, created } = await github.createDraft({ tag: input.tag, name: input.name ?? input.tag, notes: input.notes ?? '' }));
  }
  if (release.draft !== true) {
    fail('RELEASE_PUBLISHED', `Release ${input.tag} is already published; this uploader only replaces the assets of a draft`);
  }

  for (const asset of assets) {
    await github.replaceAsset(release, asset);
  }

  // Read the Release back: what counts is what is attached now, not what the
  // upload answered. A renamed or dropped asset would otherwise ship silently.
  const after = await github.getRelease(release.id);
  const problems = [];
  for (const asset of assets) {
    const attached = after.assets.filter((item) => item.name === asset.name);
    if (attached.length === 0) problems.push(`${asset.name}: not attached after upload`);
    else if (attached.length > 1) problems.push(`${asset.name}: attached ${attached.length} times`);
    else if (attached[0].size !== asset.bytes) {
      problems.push(`${asset.name}: ${attached[0].size} bytes on the Release, ${asset.bytes} bytes uploaded`);
    }
  }
  if (problems.length > 0) {
    fail('ASSET_MISMATCH', `Release assets do not match the uploaded files:\n- ${problems.join('\n- ')}`);
  }

  return {
    tag: input.tag,
    releaseId: release.id,
    draft: true,
    created,
    assets: assets.map(({ name, bytes }) => ({ name, bytes })),
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await uploadDraftRelease({
    tag: options.tag,
    directory: options.directory,
    repo: options.repo ?? process.env.GITHUB_REPOSITORY,
    name: options.name,
    notes: options.notes === undefined ? '' : readFileSync(resolve(options.notes), 'utf8'),
    // The only place the token is read. It is passed in memory and never logged.
    token: process.env.GH_TOKEN,
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `${result.created ? 'created draft' : 'reused draft'} ${result.tag} (release ${result.releaseId}): ` +
        `${result.assets.map((asset) => asset.name).join(', ')}\n`,
    );
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof ReleaseUploadError ? error.code : 'FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
