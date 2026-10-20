const ID = /^[a-z][a-z0-9-]*$/;

export function buildRegistrationRow(installed, config = {}) {
  const name = String(installed?.name ?? '');
  if (!name.startsWith('@')) return { ok: false, reason: 'bad-name' };
  const id = name.slice(1).replace('/', '-').replace(/[^a-z0-9-]/g, '-').toLowerCase();
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
    '2) dsh plugin --profile <profile> add file:<插件目录绝对路径>；该命令把参数转发给 profile 目录里的 pnpm，--profile 必填。',
    `两种方式完成后确认补丁里存在 ${row.id} 行，再重启或等待 HMR。`,
    '不要手工改写 profile 的 package.json 或 cordis.patch.yml。',
  ];
}
