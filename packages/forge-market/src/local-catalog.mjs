import { readFile } from 'node:fs/promises';

// 离线目录：与服务客户端同接口，供无服务环境（演示、隔离网、CI）跑通全链路。
// 只读；提交在此模式下不可用，避免把本地文件当成评审入口。
export function createLocalCatalog(path) {
  const read = async () => {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    const entries = Array.isArray(parsed) ? parsed : parsed.entries;
    if (!Array.isArray(entries)) throw new Error('catalog file has no entries');
    return entries;
  };

  return {
    kind: 'local',
    list: async () => ({ entries: await read() }),
    detail: async (name) => {
      const entry = (await read()).find((item) => item?.name === name);
      if (!entry) throw Object.assign(new Error('not found'), { code: 'not-found', status: 404 });
      return entry;
    },
    submit: async () => {
      throw Object.assign(new Error('local catalog is read-only'), { code: 'read-only' });
    },
    metrics: async () => ({}),
    mine: async () => ({ entries: [] }),
    unindexed: async () => ({ entries: [] }),
  };
}
