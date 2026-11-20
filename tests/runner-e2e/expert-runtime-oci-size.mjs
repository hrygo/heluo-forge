import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

function readOci(path) {
  const tar = name => execFileSync('tar', ['-xOf', resolve(path), name])
  const index = JSON.parse(tar('index.json'))
  const images = []
  function readBlob(descriptor) {
    assert.match(descriptor.digest, /^sha256:[0-9a-f]{64}$/)
    const payload = tar('blobs/' + descriptor.digest.replace(':', '/'))
    assert.equal(payload.length, descriptor.size)
    assert.equal('sha256:' + createHash('sha256').update(payload).digest('hex'), descriptor.digest)
    return JSON.parse(payload)
  }

  function visit(descriptor) {
    if (descriptor.platform && (
      descriptor.platform.os !== 'linux' || descriptor.platform.architecture !== 'arm64'
    )) return
    const item = readBlob(descriptor)
    if (item.manifests) {
      item.manifests.forEach(visit)
    } else if (item.config && item.layers) {
      const config = readBlob(item.config)
      if (config.os === 'linux' && config.architecture === 'arm64') {
        images.push({ descriptor, layers: item.layers })
      }
    }
  }

  index.manifests.forEach(visit)
  assert.equal(images.length, 1, 'Expected a single linux/arm64 image in ' + path)
  const { descriptor, layers } = images[0]
  assert(layers.every(layer => layer.mediaType === 'application/vnd.oci.image.layer.v1.tar+gzip'),
    'Use the same gzip OCI compression for all measurements')
  return {
    manifest: descriptor.digest,
    platform: 'linux/arm64',
    layers: Object.fromEntries(layers.map(layer => [layer.digest, layer.size])),
  }
}

const [path, parentPath] = process.argv.slice(2)
assert(path, 'Usage: node tests/runner-e2e/expert-runtime-oci-size.mjs OCI_TAR [PARENT_OCI_TAR]')
const image = readOci(path)
const sum = sizes => sizes.reduce((total, size) => total + size, 0)
const result = {
  platform: image.platform,
  manifest: image.manifest,
  layers: Object.keys(image.layers).length,
  compressedBytes: sum(Object.values(image.layers)),
}
if (parentPath) {
  const parent = readOci(parentPath)
  for (const digest of Object.keys(parent.layers)) {
    assert.equal(image.layers[digest], parent.layers[digest], 'Missing parent layer ' + digest)
  }
  result.parentManifest = parent.manifest
  result.incrementalBytes = sum(Object.entries(image.layers)
    .filter(([digest]) => !(digest in parent.layers)).map(([, size]) => size))
}
console.log(JSON.stringify(result, null, 2))
