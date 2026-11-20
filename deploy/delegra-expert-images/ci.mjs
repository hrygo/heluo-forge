import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const capabilities = JSON.parse(readFileSync(new URL('./capabilities.json', import.meta.url)));
const scenes = Object.keys(capabilities.scenes);
const comparisons = ['codex-min-native', 'codex-java-21-native'];
const batches = {
  reference: ['codex-min', 'codex-java-21'],
  'java-legacy': ['codex-java-8', 'codex-java-11'],
  'java-current': ['codex-java-17', 'codex-java-25'],
  development: ['codex-python', 'codex-node', 'codex-go'],
  data: ['codex-sql', 'codex-dotnet-10'],
  testing: ['codex-test-api', 'codex-test-load'],
  browser: ['codex-test-web'],
  operations: ['codex-ops-diag', 'codex-ops-k8s', 'codex-ops-iac'],
  office: ['codex-office-zh'],
};
const stableTag = /^refs\/tags\/expert-images-(v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;
const sha256 = /^sha256:[0-9a-f]{64}$/;
const smoke = fileURLToPath(new URL('../../tests/runner-e2e/expert-runtime-images-smoke.mjs', import.meta.url));

export function releaseVersion({ event, ref, deleted, fork }) {
  if (!['push', 'workflow_dispatch'].includes(event) || deleted || fork || !ref.startsWith('refs/tags/')) return '';
  const match = stableTag.exec(ref);
  assert(match && match[1].length <= 128, 'Use a stable version tag expert-images-vMAJOR.MINOR.PATCH');
  return match[1];
}

export function buildMatrix(publish) {
  assert.deepEqual(Object.values(batches).flat().sort(), scenes.toSorted(), 'CI batches must cover the shipping targets');
  const configuration = publish ? batches : { ...batches, comparison: comparisons };
  return { include: Object.entries(configuration).map(([batch, targets]) => ({ batch, targets })) };
}

export function bakeOverrides(targets, { ghcr, source, commit, version, saveCache }) {
  const allowed = version ? scenes : [...scenes, ...comparisons];
  for (const target of targets) assert(allowed.includes(target), 'Invalid target ' + target);
  return targets.flatMap((target) => {
    const cache = 'type=gha,scope=expert-' + target;
    const settings = [target + '.cache-from=' + cache];
    if (saveCache && !version) {
      settings.push(target + '.cache-to=' + cache + ',mode=min,ignore-error=true');
    }
    if (version) {
      settings.push(
        target + '.tags=' + ghcr + '/' + target,
        target + '.labels.org.opencontainers.image.source=' + source,
        target + '.labels.org.opencontainers.image.revision=' + commit,
        target + '.labels.org.opencontainers.image.version=' + version,
        target + '.output=type=image,push=true,push-by-digest=true,oci-mediatypes=true',
      );
    }
    return settings;
  });
}

export function collectRelease(receipts, { version, commit, ghcr }) {
  const images = new Map();
  for (const receipt of receipts) {
    assert(receipt.version === version && receipt.commit === commit, 'Candidate source or version differs');
    for (const image of receipt.images) {
      const { target, digest, platformDigest, compressedBytes } = image;
      assert(scenes.includes(target), 'Invalid release target ' + target);
      assert(!images.has(target), 'Duplicate release target ' + target);
      assert(sha256.test(digest) && sha256.test(platformDigest), 'Invalid candidate digest for ' + target);
      assert(Number.isSafeInteger(compressedBytes) && compressedBytes > 0, 'Invalid image size for ' + target);
      images.set(target, { target, name: ghcr + '/' + target, digest, platformDigest, compressedBytes });
    }
  }
  assert.equal(images.size, scenes.length, 'Incomplete release matrix');
  return {
    version, commit, platform: capabilities.platform, codex: capabilities.codex, runner: capabilities.runner,
    images: scenes.map((target) => images.get(target)),
  };
}

export function promote(images, version, { digestFor, tag }) {
  const pending = [];
  for (const image of images) {
    const source = image.name + '@' + image.digest;
    assert.equal(digestFor(source), image.digest, 'Missing tested candidate ' + source);
    const reference = image.name + ':' + version;
    const existing = digestFor(reference);
    assert(existing === null || existing === image.digest, reference + ' already points to another digest');
    if (existing === null) pending.push({ image, reference });
  }
  for (const { image, reference } of pending) {
    tag(image.name + '@' + image.digest, reference);
    assert.equal(digestFor(reference), image.digest, 'Published digest differs for ' + reference);
  }
}

function run(executable, args) {
  execFileSync(executable, args, { stdio: 'inherit' });
}

function readRegistry(reference, allowMissing = false) {
  const result = spawnSync('docker', ['buildx', 'imagetools', 'inspect', '--raw', reference], {
    timeout: 90_000,
  });
  if (result.error) throw result.error;
  if (result.status === 0) {
    return {
      digest: 'sha256:' + createHash('sha256').update(result.stdout).digest('hex'),
      manifest: JSON.parse(result.stdout),
    };
  }
  const message = result.stderr.toString().trim();
  if (allowMissing && (message.endsWith(reference + ': not found') ||
      message.endsWith(reference + ': manifest unknown'))) return null;
  throw new Error(message || 'Unable to inspect ' + reference);
}

function readByDigest(name, digest) {
  const result = readRegistry(name + '@' + digest);
  assert.equal(result.digest, digest, 'Registry returned an unexpected digest for ' + name);
  return result.manifest;
}

function candidate(name, digest) {
  assert(sha256.test(digest), 'Missing Buildx digest for ' + name);
  const index = readByDigest(name, digest);
  assert.equal(index.mediaType, 'application/vnd.oci.image.index.v1+json');
  const images = index.manifests.filter((entry) => entry.platform?.architecture !== 'unknown');
  assert.equal(images.length, 1, 'Expected a single runnable platform');
  const [image] = images;
  assert.equal(image.platform.os + '/' + image.platform.architecture, capabilities.platform);
  assert(sha256.test(image.digest));
  const attestation = index.manifests.find((entry) =>
    entry.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest' &&
    entry.annotations['vnd.docker.reference.digest'] === image.digest);
  assert(attestation && sha256.test(attestation.digest), 'Missing attestation for ' + name);
  const proof = readByDigest(name, attestation.digest);
  for (const predicate of ['https://spdx.dev/Document', 'https://slsa.dev/provenance/v1']) {
    assert(proof.layers.some((layer) => layer.annotations?.['in-toto.io/predicate-type'] === predicate),
      'Missing ' + predicate + ' for ' + name);
  }
  const manifest = readByDigest(name, image.digest);
  const layers = new Map(manifest.layers.map((layer) => [layer.digest, layer.size]));
  const compressedBytes = [...layers.values()].reduce((total, size) => total + size, 0);
  return { digest, platformDigest: image.digest, compressedBytes };
}

function smokeImages(images, checkNegative) {
  run(process.execPath, [smoke, ...images]);
  if (checkNegative) run(process.execPath, [smoke, '--negative', images[0]]);
}

function output(name, value) {
  appendFileSync(process.env.GITHUB_OUTPUT, name + '=' + value + '\n');
}

function main() {
  const [command, path, destination] = process.argv.slice(2);
  const env = process.env;
  const targets = env.IMAGE_TARGETS?.split(' ') ?? [];
  const settings = {
    ghcr: 'ghcr.io/' + env.GITHUB_REPOSITORY.toLowerCase(),
    source: env.GITHUB_SERVER_URL + '/' + env.GITHUB_REPOSITORY,
    commit: env.EXPERT_IMAGE_COMMIT,
    version: env.EXPERT_RELEASE_VERSION,
  };
  switch (command) {
    case 'plan': {
      const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH));
      const version = releaseVersion({
        event: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF, deleted: event.deleted, fork: event.repository.fork,
      });
      const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      if (version) run('git', ['merge-base', '--is-ancestor', commit, 'refs/remotes/origin/main']);
      output('commit', commit);
      output('version', version);
      output('matrix', JSON.stringify(buildMatrix(Boolean(version))));
      break;
    }
    case 'overrides': {
      const args = bakeOverrides(targets, { ...settings, saveCache: env.GITHUB_REF === 'refs/heads/main' });
      appendFileSync(env.GITHUB_OUTPUT, 'settings<<BAKE_SETTINGS\n' + args.join('\n') + '\nBAKE_SETTINGS\n');
      break;
    }
    case 'smoke': {
      const images = targets.map((target) => comparisons.includes(target)
        ? 'paperclip-expert/' + target.slice(0, -7) + ':arm64-native-local'
        : 'paperclip-expert/' + target + ':arm64-local');
      smokeImages(images, targets[0] === 'codex-min');
      break;
    }
    case 'receipt': {
      const metadata = JSON.parse(env.BAKE_METADATA);
      const images = targets.map((target) => {
        const name = settings.ghcr + '/' + target;
        const image = candidate(name, metadata[target]?.['containerimage.digest']);
        run('docker', ['pull', '--platform', capabilities.platform, name + '@' + image.digest]);
        return { target, name, ...image };
      });
      smokeImages(images.map((image) => image.name + '@' + image.digest), targets[0] === 'codex-min');
      writeFileSync(path, JSON.stringify({ commit: settings.commit, version: settings.version, images }) + '\n');
      break;
    }
    case 'assemble': {
      const receipts = readdirSync(path).map((name) => JSON.parse(readFileSync(join(path, name))));
      const release = collectRelease(receipts, settings);
      writeFileSync(destination, JSON.stringify(release, null, 2) + '\n');
      break;
    }
    case 'publish': {
      const release = JSON.parse(readFileSync(path));
      assert(release.version === settings.version && release.commit === settings.commit);
      promote(release.images, release.version, {
        digestFor: (reference) => readRegistry(reference, true)?.digest ?? null,
        tag: (from, to) => run('docker', ['buildx', 'imagetools', 'create', '--prefer-index=false', '--tag', to, from]),
      });
      appendFileSync(env.GITHUB_STEP_SUMMARY,
        '## Delegra expert images ' + release.version + '\n\n' +
        'Source commit `' + release.commit + '`\n\n' +
        release.images.map((image) => '- `' + image.name + '@' + image.digest + '`').join('\n') + '\n');
      break;
    }
    default:
      throw new Error('Expected plan, overrides, smoke, receipt, assemble, or publish');
  }
}

if (import.meta.main) main();
