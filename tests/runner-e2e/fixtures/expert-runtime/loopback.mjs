import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'

const [command, ...args] = process.argv.slice(2)
const server = createServer((request, response) => {
  if (request.url === '/api') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"ok":true}')
  } else if (request.url === '/form') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<form action="/submitted"><label>名称 <input name="name"></label><button>提交</button></form>')
  } else if (new URL(request.url, 'http://127.0.0.1').pathname === '/submitted') {
    const name = new URL(request.url, 'http://127.0.0.1').searchParams.get('name')
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(name === '河洛' ? '<h1>河洛样例</h1>' : '<h1>无效</h1>')
  } else {
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{"ok":false}')
  }
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const url = 'http://127.0.0.1:' + server.address().port
try {
  const child = spawn(command, args.map(arg => arg.replaceAll('{url}', url)), { stdio: 'inherit' })
  const [code] = await once(child, 'exit')
  process.exitCode = code ?? 1
} finally {
  server.close()
}
