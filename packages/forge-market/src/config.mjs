// Cordis 用 standard-schema 校验插件配置：Config['~standard'].validate(config)
// 必须同步返回 { value } 或 { issues }。写成普通对象字面量会在激活时报
// "Cannot read properties of undefined (reading 'validate')"，插件永远起不来。
export const CONFIG_FIELDS = ['serviceUrl', 'catalogFile', 'allowedHosts', 'timeoutMs', 'cachePath', 'targetDir', 'submitter'];

const TYPE_OF = {
  serviceUrl: 'string',
  catalogFile: 'string',
  allowedHosts: 'array',
  timeoutMs: 'integer',
  cachePath: 'string',
  targetDir: 'string',
  submitter: 'string',
};

function issue(path, message) {
  return { message, path: [path] };
}

export function validateConfig(input) {
  const issues = [];
  const value = {};
  const source = input ?? {};
  for (const [key, type] of Object.entries(TYPE_OF)) {
    const raw = source[key];
    if (raw === undefined || raw === null) continue;
    if (type === 'array') {
      if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) {
        issues.push(issue(key, `${key} must be an array of strings`));
        continue;
      }
      value[key] = raw.map(String);
      continue;
    }
    if (type === 'integer') {
      if (!Number.isInteger(raw) || raw <= 0) {
        issues.push(issue(key, `${key} must be a positive integer`));
        continue;
      }
      value[key] = raw;
      continue;
    }
    if (typeof raw !== 'string') {
      issues.push(issue(key, `${key} must be a string`));
      continue;
    }
    value[key] = raw;
  }
  if (issues.length) return { issues };
  return { value };
}

export const Config = {
  '~standard': { version: 1, vendor: 'heluo', validate: validateConfig },
};
