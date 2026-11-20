import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const workflow = await readFile(new URL('../.github/workflows/ocr-pr-review.yml', import.meta.url), 'utf8');
const helper = fileURLToPath(new URL('../.github/workflows/ocr-pr.mjs', import.meta.url));
const head = 'a'.repeat(40);
const marker = '<!-- ocr-pr-review -->';
const llm = { OCR_LLM_URL: 'https://llm.corp.example/api', OCR_LLM_TOKEN: 'fixture-token', OCR_LLM_MODEL: 'fixture-model' };

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'forge-ocr-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('OCR requires all three review settings before starting work', async (t) => {
  const output = join(await temporaryDirectory(t), 'output');
  const step = /- name: Check configuration\n(?:(?!\n      - )[\s\S])*?\n        run: \|\n((?: {10}[^\n]*\n)+)/u.exec(workflow);
  assert.ok(step);
  const script = step[1].replace(/^ {10}/gmu, '');
  for (const missing of [undefined, ...Object.keys(llm)]) {
    const env = { PATH: process.env.PATH, GITHUB_OUTPUT: output, ...llm };
    if (missing) delete env[missing];
    await writeFile(output, '');
    await run('bash', ['-e', '-c', script], { env });
    assert.equal((await readFile(output, 'utf8')).includes('ready=true\n'), !missing, missing);
  }
});

test('only same-repository PRs can reach the review and only the publish job gets write permission', () => {
  const [review, publish] = workflow.split(/^  publish:\s*$/mu);
  assert.match(review, /vars\.OCR_ENABLED != 'false' && github\.event\.pull_request\.head\.repo\.full_name == github\.repository/u);
  assert.doesNotMatch(review, /pull-requests:\s*write/u);
  assert.match(review, /if: steps\.cfg\.outputs\.ready == 'true'\s+uses: actions\/checkout@[a-f0-9]{40}/u);
  assert.match(review, /git show "\$OCR_BASE_SHA:\.github\/workflows\/ocr-pr\.mjs"/u);
  assert.match(publish, /pull-requests:\s*write/u);
  assert.match(publish, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/u);
  assert.doesNotMatch(publish, /secrets\.OCR_LLM_|npm install|pull_request\.head\.sha\s*\}\}\s*\n\s*persist-credentials:/u);
});

test('OCR passes exclude globs with spaces as a single argument and previews omit review flags', async () => {
  const excludes = 'docs with spaces/**,**/*.golden.js';
  const args = async (mode, setting) => {
    const { stdout } = await run(process.execPath, [helper, 'args', '--mode', mode, '--null'], {
      env: { OCR_OUTPUT_LANGUAGE: '', OCR_EXCLUDES: setting },
    });
    return stdout ? stdout.slice(0, -1).split('\0') : [];
  };
  assert.deepEqual(await args('preview', excludes), ['--exclude', excludes]);
  assert.deepEqual(await args('review', excludes), ['--exclude', excludes, '--effort', 'low', '--max-tokens-budget', '2000000']);
  assert.deepEqual(await args('preview', '__NONE__'), []);
});

test('OCR redacts the configured endpoint and token from report strings before publication', async (t) => {
  const dir = await temporaryDirectory(t);
  const raw = join(dir, 'raw.json');
  const safe = join(dir, 'result.json');
  await writeFile(raw, JSON.stringify({ status: 'partial', warnings: [{ message: `${llm.OCR_LLM_URL} rejected ${llm.OCR_LLM_TOKEN}` }] }));
  await run(process.execPath, [helper, 'sanitize-report', raw, safe], { env: llm });
  assert.deepEqual(JSON.parse(await readFile(safe, 'utf8')), {
    status: 'partial', warnings: [{ message: '[redacted] rejected [redacted]' }],
  });
});

async function comment(t, { comments = [], currentHead = head } = {}) {
  const result = join(await temporaryDirectory(t), 'result.json');
  await writeFile(result, JSON.stringify({ status: 'success', comments: [], summary: { files_reviewed: 1 } }));
  const api = `
    globalThis.fetch = async (url, { method = 'GET', body, headers }) => {
      if (headers.Authorization !== 'Bearer fixture-token') throw new Error('Missing mock token');
      const path = new URL(url).pathname;
      console.error(JSON.stringify({ method, path, body: body && JSON.parse(body) }));
      if (path.endsWith('/pulls/42')) return Response.json({ state: 'open', head: { sha: ${JSON.stringify(currentHead)} } });
      if (method === 'GET' && path.endsWith('/issues/42/comments')) return Response.json(${JSON.stringify(comments)});
      if (method === 'DELETE') return new Response(null, { status: 204 });
      return Response.json({ html_url: 'https://corp.example/comment' });
    };`;
  const { stderr } = await run(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(api)}`, helper, 'comment',
    '--result', result, '--repo', 'corp/example', '--pr', '42', '--sha', head,
  ], { env: { GH_TOKEN: 'fixture-token' } });
  return stderr.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('OCR creates a bot comment once and updates it in place on reruns', async (t) => {
  const user = { login: 'github-actions[bot]' };
  const unrelated = { id: 2, user, body: `Another workflow quoted ${marker}` };
  const first = (await comment(t, { comments: [unrelated] })).filter(({ method }) => method !== 'GET');
  assert.deepEqual(first.map(({ method, path }) => [method, path]), [['POST', '/repos/corp/example/issues/42/comments']]);
  assert.ok(first[0].body.body.startsWith(`${marker}\n`));

  const owned = { id: 7, user, body: `${marker}\nPrevious review` };
  const next = (await comment(t, { comments: [unrelated, owned] })).filter(({ method }) => method !== 'GET');
  assert.deepEqual(next.map(({ method, path }) => [method, path]), [['PATCH', '/repos/corp/example/issues/comments/7']]);
});

test('an obsolete OCR review cannot replace the comment for a newer head', async (t) => {
  const requests = await comment(t, { currentHead: 'b'.repeat(40) });
  assert.ok(requests.some(({ path }) => path.endsWith('/pulls/42')));
  assert.ok(requests.every(({ method }) => method === 'GET'));
});
