const ID = /^[a-z][a-z0-9-]*$/;

import { createHash } from 'node:crypto';

export function buildRegistrationRow(installed, config = {}) {
  const name = String(installed?.name ?? '');
  if (!name.startsWith('@')) return { ok: false, reason: 'bad-name' };
  // 简单名生成可读 id；含点、下划线或大写的名字再加短哈希后缀，
  // 否则 @heluo/foo_bar 与 @heluo/foo-bar 会落到同一个行 id 上互相覆盖。
  const body = name.replace(/^@[^/]+\//, '');
  const readable = /^[a-z0-9][a-z0-9-]*$/.test(body);
  const slug = body.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const scope = name.startsWith('@') ? name.slice(1).split('/')[0].toLowerCase().replace(/[^a-z0-9-]+/g, '-') : '';
  const suffix = readable ? '' : `-${createHash('sha256').update(name).digest('hex').slice(0, 6)}`;
  const id = `${scope ? `${scope}-` : ''}${slug}${suffix}`;
  if (!ID.test(id)) return { ok: false, reason: 'bad-id', detail: id };
  if (!config.serviceUrl) return { ok: false, reason: 'no-service-url' };

  return {
    ok: true,
    row: {
      id,
      name,
      inject: ['tools'],
      config: {
        serviceUrl: config.serviceUrl,
        allowedHosts: config.allowedHosts ?? [],
        timeoutMs: config.timeoutMs ?? 5000,
        targetDir: config.targetDir ?? null,
      },
    },
  };
}

export function renderPatch(row) {
  const lines = ['insert:', `  - id: ${row.id}`, `    name: '${row.name}'`];
  if (row.inject?.length) lines.push(`    inject: [${row.inject.join(', ')}]`);
  lines.push('    config:');
  for (const [key, value] of Object.entries(row.config ?? {})) {
    if (value === null || value === undefined) continue;
    lines.push(`      ${key}: ${Array.isArray(value) ? `[${value.join(', ')}]` : value}`);
  }
  return `${lines.join('\n')}\n`;
}

export function registrationInstructions(row) {
  return [
    '在目标 profile 上登记该插件，二者择一：',
    '1) plugin_manager install_bundle，target 取插件目录的绝对路径；它会写入 profile 的包与补丁，无需手工编辑。',
    '2) dsh plugin --profile <profile> add <插件目录绝对路径>；参数写绝对路径即可，不要加 file: 前缀。',
    `两种方式完成后确认补丁里存在 ${row.id} 行，再重启或等待 HMR。`,
    '不要手工改写 profile 的 package.json 或 cordis.patch.yml。',
  ];
}
