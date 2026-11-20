import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const fixtures = fileURLToPath(new URL('./fixtures/expert-runtime', import.meta.url))
const common = readFileSync(new URL('./fixtures/expert-runtime/common.sh', import.meta.url), 'utf8')
const capabilities = JSON.parse(readFileSync(new URL(
  '../../deploy/delegra-expert-images/capabilities.json', import.meta.url,
), 'utf8'))
const dockerOptions = ['--pull=never', '--platform=linux/arm64', '--network=none']
const procTimeout = 120_000

function docker(args, options) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: procTimeout, ...options })
  if (result.error) throw result.error
  return result
}

function succeeded(result) {
  assert.equal(result.status, 0, (result.stderr || result.stdout).trim())
  return result.stdout.trim()
}

function checkPlatform(image) {
  const config = JSON.parse(succeeded(docker(['image', 'inspect', image])))[0]
  assert.equal(config.Os + '/' + config.Architecture, capabilities.platform, 'OCI platform')
  assert.equal(config.Config.User, '1000:1000', 'default UID and GID')
  assert.equal(config.Config.WorkingDir, '/workspace', 'default workspace')
  assert.deepEqual(config.Config.Entrypoint, ['/usr/bin/tini', '-g', '--'], 'command forwarding')
  assert.equal(config.Config.Labels['io.heluo-forge.codex.version'], capabilities.codex)
  assert.equal(config.Config.Labels['io.heluo-forge.delegra.runner-revision'], capabilities.runner)
  return config
}

function cleanup(name) {
  const containers = succeeded(docker(['ps', '-aq', '--filter', 'name=^/' + name + '$']))
  if (containers) succeeded(docker(['rm', '-f', name]))
  assert.equal(succeeded(docker(['ps', '-aq', '--filter', 'name=^/' + name + '$'])), '')
}

function run(image, command, { input, extra = [] } = {}) {
  const name = 'heluo-expert-smoke-' + randomUUID()
  try {
    return docker(['run', '--rm', '-i', '--name', name, ...dockerOptions, ...extra, image, ...command], { input })
  } finally {
    cleanup(name)
  }
}

async function appServer(image, { timeout = 20_000, command = ['codex', 'app-server'] } = {}) {
  const name = 'heluo-expert-stdio-' + randomUUID()
  const child = spawn('docker', ['run', '--rm', '-i', '--name', name, ...dockerOptions, image, ...command])
  const closed = once(child, 'close').catch(() => {})
  const lines = createInterface({ input: child.stdout })
  let initialized = false
  let stderr = ''
  let timedOut = false
  let timer
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        reject(new Error('Codex stdio timeout'))
      }, timeout)
      child.on('error', reject)
      child.stdin.on('error', reject)
      child.stderr.on('data', chunk => { stderr += chunk })
      child.on('close', code => {
        if (code === 0 && initialized) resolve()
        else reject(new Error('Codex stdio exited ' + code + ': ' + stderr.trim()))
      })
      lines.on('line', line => {
        try {
          const message = JSON.parse(line)
          if (message.id !== 1) return
          assert.equal(message.error, undefined, JSON.stringify(message.error))
          assert.match(message.result.userAgent, /0\.160\.0/)
          initialized = true
          child.stdin.end(JSON.stringify({ method: 'initialized' }) + '\n')
        } catch (error) {
          reject(error)
        }
      })
      child.stdin.write(JSON.stringify({
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'expert-image-smoke', version: '1.0.0' } },
      }) + '\n')
    })
  } finally {
    clearTimeout(timer)
    lines.close()
    if (timedOut || child.exitCode === null) {
      child.stdin.destroy()
      child.kill()
    }
    await closed
    cleanup(name)
  }
}

function targetFor(image) {
  const name = image.slice(image.lastIndexOf('/') + 1)
  const target = name.split(/[:@]/, 1)[0]
  assert(Object.hasOwn(capabilities.scenes, target), 'Unknown target in image reference ' + image)
  return target
}

async function smoke(image) {
  const started = performance.now()
  const target = targetFor(image)
  const config = checkPlatform(image)
  const commands = [...capabilities.common, ...capabilities.scenes[target]]
  assert.match(succeeded(run(image, ['sh', '-eu', '-s', '--', ...commands], { input: common })), /COMMON_OK/)
  assert.match(succeeded(run(image, ['codex', 'exec', '--help'])), /Usage:/)
  assert.equal(run(image, ['sh', '-c', 'exit 37']).status, 37, 'tini forwards the exit status')
  await appServer(image)
  if (target !== 'codex-min') {
    const extra = ['--mount', 'type=bind,source=' + fixtures + ',target=/fixtures,readonly']
    if (target === 'codex-test-web' && process.env.EXPERT_BROWSER_SECCOMP) {
      extra.push('--security-opt', 'seccomp=' + process.env.EXPERT_BROWSER_SECCOMP)
    }
    const output = succeeded(run(image, ['sh', '-eu', '/fixtures/scenario.sh', target], { extra }))
    assert.match(output, /SCENARIO_OK/)
    console.log(output)
  }
  console.log(image + ' ' + config.Id + ' ' + config.Size + ' bytes ' +
    ((performance.now() - started) / 1000).toFixed(2) + ' s')
}

async function negative(image) {
  const config = checkPlatform(image)
  const withoutTools = run(image, ['env', 'PATH=/usr/bin:/bin', 'sh', '-eu', '-s', '--', 'node'], { input: common })
  assert.notEqual(withoutTools.status, 0, 'missing tool must fail')
  assert.match(withoutTools.stderr, /missing required tool: node/)
  await assert.rejects(
    appServer(image, { timeout: 2_000, command: ['sh', '-c', 'sleep 30'] }),
    /stdio timeout/,
  )
  assert.equal(config.Architecture, 'arm64')
  console.log(image + ' NEGATIVE_OK (missing tools, stdio timeout and container cleanup)')
}

const args = process.argv.slice(2)
const negatives = args[0] === '--negative'
if (negatives) args.shift()
assert(args.length, 'Usage: node tests/runner-e2e/expert-runtime-images-smoke.mjs [--negative] IMAGE ...')
for (const image of args) await (negatives ? negative : smoke)(image)
