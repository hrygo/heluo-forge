import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { classifyChanges, parseRawDiff } from '../scripts/ci-classify-changes.mjs';

const script = fileURLToPath(new URL('../scripts/ci-classify-changes.mjs', import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-ci-classifier-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const template = join(root, 'empty-template');
  mkdirSync(template);
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(root, 'absent-global-config'),
    GIT_TEMPLATE_DIR: template,
    GIT_AUTHOR_NAME: 'CI Test',
    GIT_AUTHOR_EMAIL: 'ci-test',
    GIT_COMMITTER_NAME: 'CI Test',
    GIT_COMMITTER_EMAIL: 'ci-test',
  };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key];
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim();
  const write = (path, contents = '# changed\n') => {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  };
  const commitStaged = () => {
    git('commit', '--quiet', '--no-gpg-sign', '-m', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  const commit = () => {
    git('add', '-A', '--');
    return commitStaged();
  };
  git('init', '--quiet', '--initial-branch=main');
  write('docs/guide.md', '# original\n');
  write('docs/deleted.md', '# original\n');
  write('README.md');
  write('CONTRIBUTING.md');
  write('SECURITY.md');
  write('packages/example/README.md');
  write('src/app.js', 'initial\n');
  const base = commit();
  return { root, env, git, write, commit, commitStaged, base };
}

function pullRequest(base, head) {
  return { pull_request: { base: { sha: base }, head: { sha: head } } };
}

function classify(repo, base, head, extra = {}) {
  const githubSha = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd: repo.root,
    encoding: 'utf8',
  }).trim();
  return classifyChanges({
    eventName: 'pull_request',
    event: pullRequest(base, head),
    cwd: repo.root,
    githubSha,
    ...extra,
  });
}

test('allows ordinary Markdown edits and deletions in the approved locations', (t) => {
  const repo = fixture(t);
  repo.write('docs/guide.md', '# revised\n');
  repo.write('README.md', '# revised\n');
  repo.write('CONTRIBUTING.md', '# revised\n');
  repo.write('SECURITY.md', '# revised\n');
  rmSync(join(repo.root, 'docs/deleted.md'));
  const head = repo.commit();
  const result = classify(repo, repo.base, head);
  assert.equal(result.run_platforms, false);
  assert.ok(result.reason.length > 0);
});

function stageIndexFile(repo, path, oid) {
  // Git's index lets these fixtures represent Windows-incompatible names on
  // every host, without creating those names in the working tree.
  repo.git('-c', 'core.protectNTFS=false', '-c', 'core.protectHFS=false',
    'update-index', '--add', '--cacheinfo', `100644,${oid},${path}`);
}

test('new documentation paths always run platforms', async (t) => {
  const paths = [
    'docs/new.md',
    'docs/CON.md',
    'docs/COM¹.md',
    'docs/colon:name.md',
    'docs/换行\n文件.md',
    'docs/GUIDE.md',
    'docs/CON/guide.md',
    'docs/directory./guide.md',
    'docs/directory /guide.md',
    `docs/${'a'.repeat(256)}/guide.md`,
    'docs/guide.md.',
    'docs/guide.md ',
  ];
  for (const path of paths) {
    await t.test(JSON.stringify(path), (child) => {
      const repo = fixture(child);
      const oid = repo.git('rev-parse', `${repo.base}:docs/guide.md`);
      stageIndexFile(repo, path, oid);
      assert.equal(classify(repo, repo.base, repo.commitStaged()).run_platforms, true);
    });
  }
});

test('existing nonportable paths run platforms for both content edits and deletions', async (t) => {
  const paths = [
    'docs/CON.md',
    'docs/aux.example.md',
    'docs/COM¹.md',
    'docs/LpT².example.md',
    'docs/colon:name.md',
    'docs/换行\n文件.md',
    'docs/control\x7fname.md',
    'docs/asterisk*.md',
    'docs/back\\slash.md',
    'docs/CON/guide.md',
    'docs/directory./guide.md',
    'docs/directory /guide.md',
    `docs/${'a'.repeat(256)}/guide.md`,
  ];
  for (const path of paths) {
    await t.test(JSON.stringify(path), (child) => {
      const repo = fixture(child);
      const original = repo.git('rev-parse', `${repo.base}:docs/guide.md`);
      const replacement = repo.git('hash-object', '-w', '--stdin');
      stageIndexFile(repo, path, original);
      const base = repo.commitStaged();
      stageIndexFile(repo, path, replacement);
      const modified = repo.commitStaged();
      assert.equal(classify(repo, base, modified).run_platforms, true, 'modified');
      repo.git('update-index', '--force-remove', '--', path);
      const deleted = repo.commitStaged();
      assert.equal(classify(repo, modified, deleted).run_platforms, true, 'deleted');
    });
  }
});

test('existing portable Unicode documentation can be edited without running platforms', (t) => {
  const repo = fixture(t);
  const path = 'docs/架构/设计.md';
  const original = repo.git('rev-parse', `${repo.base}:docs/guide.md`);
  stageIndexFile(repo, path, original);
  const base = repo.commitStaged();
  const replacement = repo.git('hash-object', '-w', '--stdin');
  stageIndexFile(repo, path, replacement);
  assert.equal(classify(repo, base, repo.commitStaged()).run_platforms, false);
});

test('runs platforms for any change outside the exact documentation allowlist', async (t) => {
  const paths = [
    'AGENTS.md',
    'other.md',
    'packages/example/README.md',
    'src/app.js',
    'docs/image.svg',
    'docs/index.html',
    'docs/upper.MD',
    'docs-other/guide.md',
    '.github/workflows/check.yml',
    'README.md.js',
  ];
  for (const path of paths) {
    await t.test(path, (child) => {
      const repo = fixture(child);
      repo.write('docs/guide.md', '# documentation change\n');
      repo.write(path, 'other change\n');
      const result = classify(repo, repo.base, repo.commit());
      assert.equal(result.run_platforms, true);
      assert.ok(result.reason.length > 0);
    });
  }
});

test('checks both sides of renames, including disallowed deleted source paths', async (t) => {
  for (const [from, to, expected] of [
    ['packages/example/README.md', 'docs/moved.md', true],
    ['docs/guide.md', 'packages/example/moved.md', true],
    ['docs/guide.md', 'docs/renamed.md', true],
  ]) {
    await t.test(`${from} -> ${to}`, (child) => {
      const repo = fixture(child);
      mkdirSync(dirname(join(repo.root, to)), { recursive: true });
      renameSync(join(repo.root, from), join(repo.root, to));
      assert.equal(classify(repo, repo.base, repo.commit()).run_platforms, expected);
    });
  }
});

test('a renamed source containing Unicode and a newline cannot be hidden', (t) => {
  const repo = fixture(t);
  const source = 'packages/example/旧\n文件.md';
  repo.write(source, '# unchanged contents\n');
  const base = repo.commit();
  renameSync(join(repo.root, source), join(repo.root, 'docs/moved.md'));
  const head = repo.commit();
  const raw = execFileSync('git', ['diff', '--raw', '-z', '--no-abbrev', '--no-renames', base, head, '--'], {
    cwd: repo.root,
    env: repo.env,
    encoding: 'buffer',
  });
  assert.deepEqual(new Set(parseRawDiff(raw).map(({ path, status }) => `${status}:${path}`)),
    new Set([`D:${source}`, 'A:docs/moved.md']));
  assert.equal(classify(repo, base, head).run_platforms, true);
});

test('rejects non-regular files and changes in file mode or type', async (t) => {
  const cases = [
    ['executable addition', (repo) => {
      repo.write('docs/executable.md');
      repo.git('add', '--', 'docs/executable.md');
      repo.git('update-index', '--chmod=+x', '--', 'docs/executable.md');
    }],
    ['executable mode change', (repo) => {
      repo.git('update-index', '--chmod=+x', '--', 'docs/guide.md');
    }],
    ['symlink addition', (repo) => {
      const oid = repo.git('hash-object', '-w', '--stdin');
      repo.git('update-index', '--add', '--cacheinfo', `120000,${oid},docs/link.md`);
    }],
    ['regular file replaced by symlink', (repo) => {
      const oid = repo.git('hash-object', '-w', '--stdin');
      repo.git('update-index', '--cacheinfo', `120000,${oid},docs/guide.md`);
    }],
    ['gitlink addition', (repo) => {
      repo.git('update-index', '--add', '--cacheinfo', `160000,${repo.base},docs/module.md`);
    }],
  ];
  for (const [name, stage] of cases) {
    await t.test(name, (child) => {
      const repo = fixture(child);
      stage(repo);
      assert.equal(classify(repo, repo.base, repo.commitStaged()).run_platforms, true);
    });
  }
  await t.test('symlink deletion', (child) => {
    const repo = fixture(child);
    const oid = repo.git('hash-object', '-w', '--stdin');
    repo.git('update-index', '--add', '--cacheinfo', `120000,${oid},docs/link.md`);
    const base = repo.commitStaged();
    repo.git('update-index', '--force-remove', '--', 'docs/link.md');
    assert.equal(classify(repo, base, repo.commitStaged()).run_platforms, true);
  });
  await t.test('gitlink modification even when Git configuration hides submodules', (child) => {
    const repo = fixture(child);
    repo.git('update-index', '--add', '--cacheinfo', `160000,${repo.base},docs/module.md`);
    const base = repo.commitStaged();
    repo.git('update-index', '--cacheinfo', `160000,${base},docs/module.md`);
    const head = repo.commitStaged();
    repo.git('config', 'diff.ignoreSubmodules', 'all');
    assert.equal(classify(repo, base, head).run_platforms, true);
  });
});

test('PR compares the complete branch diff, not only its last commit', (t) => {
  const repo = fixture(t);
  repo.write('src/app.js', 'changed in an earlier PR commit\n');
  repo.commit();
  repo.write('docs/guide.md', '# changed in final PR commit\n');
  const head = repo.commit();
  assert.equal(classify(repo, repo.base, head).run_platforms, true);
});

test('PR runs platforms when the base branch has advanced beyond the merge base', (t) => {
  const repo = fixture(t);
  repo.git('switch', '--quiet', '-c', 'feature');
  repo.write('docs/guide.md', '# feature docs\n');
  const head = repo.commit();
  repo.git('switch', '--quiet', 'main');
  repo.write('src/app.js', 'new main change not present on feature\n');
  const base = repo.commit();
  repo.git('switch', '--quiet', 'feature');
  assert.equal(classify(repo, base, head).run_platforms, true);
});

test('a stale documentation event cannot skip platform checks for a newer code checkout', (t) => {
  const repo = fixture(t);
  repo.write('docs/guide.md', '# documentation change\n');
  const eventHead = repo.commit();
  repo.write('src/app.js', 'later code change\n');
  const checkout = repo.commit();
  assert.equal(classify(repo, repo.base, eventHead, { githubSha: checkout }).run_platforms, true);
});

test('PR requires the full GitHub SHA to identify the actual checkout commit', (t) => {
  const repo = fixture(t);
  repo.write('docs/guide.md', '# documentation change\n');
  const eventHead = repo.commit();
  repo.git('commit', '--quiet', '--no-gpg-sign', '--allow-empty', '-m', 'same tree');
  const checkout = repo.git('rev-parse', 'HEAD');
  for (const githubSha of [undefined, null, '', '0'.repeat(40), checkout.slice(0, 12), `${checkout}^`, repo.base, eventHead, 'f'.repeat(40)]) {
    assert.equal(classify(repo, repo.base, eventHead, { githubSha }).run_platforms, true, String(githubSha));
  }
  assert.equal(classify(repo, repo.base, eventHead, { githubSha: checkout }).run_platforms, false);
});

test('accepts a GitHub merge commit when its checkout tree matches the PR head tree', (t) => {
  const repo = fixture(t);
  repo.write('docs/guide.md', '# documentation change\n');
  const head = repo.commit();
  const tree = repo.git('rev-parse', `${head}^{tree}`);
  const merge = execFileSync('git', ['commit-tree', tree, '-p', repo.base, '-p', head], {
    cwd: repo.root,
    env: repo.env,
    encoding: 'utf8',
    input: 'synthetic merge\n',
  }).trim();
  repo.git('switch', '--quiet', '--detach', merge);
  assert.notEqual(merge, head);
  assert.equal(classify(repo, repo.base, head, { githubSha: merge }).run_platforms, false);
});

test('Git failures while checking checkout identity or tree force a full run', (t) => {
  const repo = fixture(t);
  repo.write('docs/guide.md', '# documentation change\n');
  const head = repo.commit();
  for (const failedRevision of ['HEAD^{commit}', 'HEAD^{tree}', `${head}^{tree}`]) {
    const gitRunner = (args, cwd) => {
      if (args.includes(failedRevision)) throw new Error('Git verification failed');
      return execFileSync('git', args, { cwd, encoding: 'buffer' });
    };
    assert.equal(classify(repo, repo.base, head, { gitRunner }).run_platforms, true, failedRevision);
  }
});

test('empty, invalid or unavailable revisions always run platforms', (t) => {
  const repo = fixture(t);
  const zeros = '0'.repeat(40);
  const missing = 'f'.repeat(40);
  for (const [base, head] of [
    [repo.base, repo.base],
    [undefined, repo.base],
    [repo.base, undefined],
    [zeros, repo.base],
    [repo.base, zeros],
    [missing, repo.base],
    [repo.base, missing],
    [repo.base.slice(0, 12), repo.base],
    [`${repo.base}^`, repo.base],
  ]) {
    assert.equal(classify(repo, base, head).run_platforms, true, `${base} ${head}`);
  }
  for (const event of [null, {}, { pull_request: {} }, { pull_request: { base: {}, head: null } }]) {
    assert.equal(classifyChanges({ eventName: 'pull_request', event, cwd: repo.root }).run_platforms, true);
  }
  assert.equal(classify(repo, repo.base, repo.base, { cwd: join(repo.root, 'missing') }).run_platforms, true);
});

test('unrelated histories have no usable merge base and run platforms', (t) => {
  const repo = fixture(t);
  repo.git('switch', '--quiet', '--orphan', 'unrelated');
  repo.write('docs/new.md');
  const head = repo.commit();
  assert.equal(classify(repo, repo.base, head).run_platforms, true);
});

test('shallow history is not treated as a complete PR comparison', (t) => {
  const source = fixture(t);
  const clone = mkdtempSync(join(tmpdir(), 'forge-ci-shallow-'));
  t.after(() => rmSync(clone, { recursive: true, force: true }));
  execFileSync('git', ['clone', '--quiet', '--depth=1', pathToFileURL(source.root).href, clone], { env: source.env });
  const git = (...args) => execFileSync('git', args, { cwd: clone, env: source.env, encoding: 'utf8' }).trim();
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(clone, 'docs/guide.md'), '# changed\n');
  git('add', '--', 'docs/guide.md');
  git('commit', '--quiet', '--no-gpg-sign', '-m', 'docs');
  assert.equal(git('rev-parse', '--is-shallow-repository'), 'true');
  assert.equal(classify({ root: clone }, base, git('rev-parse', 'HEAD')).run_platforms, true);
});

test('malformed raw Git output and failed Git queries fall back to all platforms', (t) => {
  const repo = fixture(t);
  repo.write('docs/guide.md', '# changed\n');
  const head = repo.commit();
  for (const malformed of [
    Buffer.from('garbage\0'),
    Buffer.from(':100644 100644 abc def M\0docs/guide.md\0'),
    Buffer.from(`:100644 100644 ${repo.base} ${head} M\0docs/guide.md`),
    Buffer.from(`:100644 100644 ${repo.base} ${head} Z\0docs/guide.md\0`),
    Buffer.from(`:100644 100644 ${repo.base} ${head} M\0docs/../outside.md\0`),
    Buffer.concat([Buffer.from(`:100644 100644 ${repo.base} ${head} M\0docs/`), Buffer.from([0xff]), Buffer.from('.md\0')]),
  ]) {
    assert.throws(() => parseRawDiff(malformed));
    const gitRunner = (args, cwd) => args.includes('--raw')
      ? malformed
      : execFileSync('git', args, { cwd, encoding: 'buffer' });
    assert.equal(classify(repo, repo.base, head, { gitRunner }).run_platforms, true);
  }
  const gitRunner = () => { throw new Error('git failed'); };
  assert.equal(classify(repo, repo.base, head, { gitRunner }).run_platforms, true);
  const ambiguousMergeBase = (args, cwd) => args.includes('merge-base')
    ? Buffer.from(`${repo.base}\n${head}\n`)
    : execFileSync('git', args, { cwd, encoding: 'buffer' });
  assert.equal(classify(repo, repo.base, head, { gitRunner: ambiguousMergeBase }).run_platforms, true);
});

test('push and every other event run platforms, regardless of their payload', (t) => {
  const repo = fixture(t);
  repo.write('docs/guide.md');
  const head = repo.commit();
  for (const eventName of ['push', 'merge_group', 'workflow_dispatch', 'unknown', '', undefined]) {
    const event = { ref: 'refs/heads/main', before: repo.base, after: head };
    assert.equal(classifyChanges({ eventName, event, cwd: repo.root }).run_platforms, true, eventName);
  }
});

test('CLI appends its boolean output and reports a reason', (t) => {
  const repo = fixture(t);
  repo.write('docs/guide.md', '# changed\n');
  const head = repo.commit();
  const eventPath = join(repo.root, 'event.json');
  const outputPath = join(repo.root, 'output.txt');
  writeFileSync(eventPath, JSON.stringify(pullRequest(repo.base, head)));
  writeFileSync(outputPath, 'already=present\n');
  const result = spawnSync(process.execPath, [script], {
    cwd: repo.root,
    env: { ...repo.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath, GITHUB_SHA: head },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(outputPath, 'utf8'), 'already=present\nrun_platforms=false\n');
  assert.match(result.stdout, /documentation-only changes/u);
});

test('CLI runs all platforms when GITHUB_SHA is missing or mismatched', async (t) => {
  for (const githubSha of [undefined, '0'.repeat(40), 'f'.repeat(40)]) {
    await t.test(githubSha ?? 'missing', (child) => {
      const repo = fixture(child);
      repo.write('docs/guide.md', '# changed\n');
      const head = repo.commit();
      const eventPath = join(repo.root, 'event.json');
      const outputPath = join(repo.root, 'output.txt');
      writeFileSync(eventPath, JSON.stringify(pullRequest(repo.base, head)));
      const env = { ...repo.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath };
      if (githubSha === undefined) delete env.GITHUB_SHA;
      else env.GITHUB_SHA = githubSha;
      const result = spawnSync(process.execPath, [script], { cwd: repo.root, env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(outputPath, 'utf8'), 'run_platforms=true\n');
    });
  }
});

test('CLI runs all platforms for push without requiring an event payload', (t) => {
  const repo = fixture(t);
  const outputPath = join(repo.root, 'output.txt');
  const env = { ...repo.env, GITHUB_EVENT_NAME: 'push', GITHUB_OUTPUT: outputPath };
  delete env.GITHUB_EVENT_PATH;
  const result = spawnSync(process.execPath, [script], { cwd: repo.root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(outputPath, 'utf8'), 'run_platforms=true\n');
  assert.match(result.stdout, /full platform checks/u);
});

test('CLI falls back to full checks for missing or invalid event JSON', async (t) => {
  for (const invalid of [undefined, '{invalid json']) {
    await t.test(invalid === undefined ? 'missing' : 'invalid JSON', (child) => {
      const repo = fixture(child);
      const eventPath = join(repo.root, 'event.json');
      const outputPath = join(repo.root, 'output.txt');
      if (invalid !== undefined) writeFileSync(eventPath, invalid);
      const result = spawnSync(process.execPath, [script], {
        cwd: repo.root,
        env: { ...repo.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath },
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(outputPath, 'utf8'), 'run_platforms=true\n');
    });
  }
});

test('CLI fails when GITHUB_OUTPUT is absent or cannot be written', async (t) => {
  for (const output of [undefined, 'missing/output.txt']) {
    await t.test(output ?? 'absent', (child) => {
      const repo = fixture(child);
      const env = { ...repo.env, GITHUB_EVENT_NAME: 'push' };
      if (output === undefined) delete env.GITHUB_OUTPUT;
      else env.GITHUB_OUTPUT = join(repo.root, output);
      const result = spawnSync(process.execPath, [script], { cwd: repo.root, env, encoding: 'utf8' });
      assert.notEqual(result.status, 0);
    });
  }
});
