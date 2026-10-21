#!/usr/bin/env node
// 只读校验 AIHUB 产出的 format-1 索引；不生成、不托管、不安装。
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { IndexFormatError, parseMarketIndex } from './index-format.mjs';

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

/** 校验已读取的文本；indexUrl 用于解析相对 icon。 */
export function validateIndexText(text, indexUrl) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new IndexFormatError('$', `invalid JSON: ${error.message}`);
  }
  const index = parseMarketIndex(value, indexUrl);
  return {
    index,
    plugins: index.plugins.length,
    versions: index.plugins.reduce((total, plugin) => total + plugin.versions.length, 0),
  };
}

async function load(source, base) {
  if (/^https?:\/\//u.test(source)) {
    let response;
    try {
      response = await fetch(source, {
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
    } catch (error) {
      throw new Error(`fetch failed: ${error.message}`);
    }
    if (!response.ok) throw new Error(`fetch failed: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_BYTES) throw new Error(`index too large: ${bytes.byteLength} bytes`);
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), indexUrl: base ?? response.url ?? source };
  }

  const bytes = await readFile(source);
  if (bytes.byteLength > MAX_BYTES) throw new Error(`index too large: ${bytes.byteLength} bytes`);
  return { text: bytes.toString('utf8'), indexUrl: base ?? pathToFileURL(source).href };
}

async function main(argv) {
  const args = [...argv];
  let base;
  const baseIndex = args.indexOf('--base');
  if (baseIndex !== -1) {
    base = args[baseIndex + 1];
    args.splice(baseIndex, 2);
  }
  const source = args[0];
  if (!source) {
    console.error('usage: node services/market-index/validate-index.mjs <url|file> [--base https://.../index.json]');
    process.exit(2);
  }

  try {
    const { text, indexUrl } = await load(source, base);
    const result = validateIndexText(text, indexUrl);
    console.log(`ok: format=${result.index.format} plugins=${result.plugins} versions=${result.versions}`);
    for (const plugin of result.index.plugins) {
      console.log(`- ${plugin.name}: ${plugin.versions.map((entry) => entry.version).join(', ')}`);
    }
  } catch (error) {
    if (error instanceof IndexFormatError) console.error(`invalid: ${error.path} ${error.reason}`);
    else console.error(`invalid: ${error.message}`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
