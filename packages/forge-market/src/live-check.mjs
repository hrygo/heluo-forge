import { downloadArchive } from './install.mjs';
import { checkArchivePaths, digestOf } from './installer.mjs';
import { extractTarball } from './tarball.mjs';
import { validatePlugin } from './validate.mjs';

// 真实仓库的验收检查：不进 CI（无网络与凭据），供上线前人工执行。
// 只读：拉一次归档，按包格式规则判定，不改任何仓库或 profile。
export function archiveUrlFor(repo, tag) {
  return `${String(repo).replace(/\/$/, '')}/archive/refs/tags/${tag}.tar.gz`;
}

export async function checkRemote({ repo, tag, digest, fetchImpl, allowedHosts = [] }) {
  const steps = [];
  const record = (step, ok, detail) => steps.push({ step, ok, detail });

  if (!repo || !tag) return { ok: false, steps: [{ step: 'input', ok: false, detail: 'repo and tag are required' }] };

  let host;
  try {
    host = new URL(repo).host;
  } catch {
    return { ok: false, steps: [{ step: 'repo', ok: false, detail: 'not a url' }] };
  }
  if (allowedHosts.length && !allowedHosts.includes(host)) {
    return { ok: false, steps: [{ step: 'repo', ok: false, detail: `host ${host} is not allowed` }] };
  }
  record('repo', true, host);

  const url = archiveUrlFor(repo, tag);
  record('archive-url', true, url);

  const fetched = await downloadArchive(url, { fetchImpl });
  if (!fetched.ok) {
    record('download', false, fetched.reason);
    return { ok: false, steps };
  }
  record('download', true, `${fetched.bytes.length} bytes`);

  const actual = digestOf(fetched.bytes);
  record('digest', true, actual);
  if (digest && actual !== digest) {
    record('digest-match', false, `expected ${digest}`);
    return { ok: false, steps, digest: actual };
  }

  const extracted = extractTarball(fetched.bytes);
  if (!extracted.ok) {
    record('extract', false, extracted.reason);
    return { ok: false, steps, digest: actual };
  }
  record('extract', true, `${extracted.files.length} files`);

  const paths = extracted.files.map((file) => file.path);
  const safe = checkArchivePaths(paths);
  record('paths', safe.ok, safe.ok ? `${paths.length} paths` : safe.detail);
  if (!safe.ok) return { ok: false, steps, digest: actual };

  const byPath = new Map(extracted.files.map((file) => [file.path, file]));
  const manifestFile = byPath.get('package.json');
  let manifest = null;
  if (manifestFile) {
    try {
      manifest = JSON.parse(manifestFile.bytes.toString('utf8'));
    } catch {
      manifest = null;
    }
  }
  const readme = byPath.get('README.md')?.bytes.toString('utf8') ?? '';
  const patch = byPath.get('cordis.patch.yml')?.bytes.toString('utf8') ?? '';

  const verdict = validatePlugin(
    { files: paths, manifest: manifest ?? {}, readme, patch, tag },
    { allowedScopes: ['@heluo'] },
  );
  record('validate', verdict.ok, verdict.ok ? 'pass' : verdict.errors);
  return { ok: verdict.ok, steps, digest: actual, errors: verdict.errors };
}
