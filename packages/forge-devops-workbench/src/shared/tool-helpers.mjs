/**
 * DSH Host 只读模型工具公共序列化与安全错误包装基元（对齐 CORP-DSH-ENG-003）。
 */
import { toErrorEnvelope } from './errors.mjs';

export const json = (value) => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

const renderToolOutput = (_args, value) => (Array.isArray(value?.content) ? value.content : json(value).content);

export const TOOL_OUTPUT = Object.freeze({
  schema: Object.freeze({ type: 'object' }),
  render: renderToolOutput,
});

export function toolFailure(toolName, err) {
  const env = toErrorEnvelope(err, { partialData: null });
  return json({
    ok: false,
    tool: toolName,
    code: env.error.code,
    message: env.error.message,
    retryable: env.error.retryable,
  });
}
