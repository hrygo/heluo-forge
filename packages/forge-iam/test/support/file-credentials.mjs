// File-backed CredentialProvider for cross-process tests. It mirrors the seam
// the real keychain adapter implements: records and refs stored as JSON, with
// an exclusive lock around every read-modify-write so two processes serialize
// the same way they would around a keychain item. It is a test double only.

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const LOCK_RETRY_MS = 5;
const LOCK_TIMEOUT_MS = 10_000;

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

export class FileCredentials {
  #dir;

  #recordsPath;

  #refsPath;

  constructor(dir) {
    this.#dir = dir;
    this.#recordsPath = join(dir, 'records.json');
    this.#refsPath = join(dir, 'refs.json');
  }

  async #lock() {
    const lockDir = join(this.#dir, 'lock');
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        await mkdir(lockDir);
        return async () => {
          await rm(lockDir, { recursive: true, force: true });
        };
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        if (Date.now() > deadline) throw new Error('lock timeout');
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      }
    }
  }

  async #writeAtomic(path, value) {
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await rename(temp, path);
  }

  async #withLock(action) {
    await mkdir(this.#dir, { recursive: true });
    const release = await this.#lock();
    try {
      return await action();
    } finally {
      await release();
    }
  }

  async resolve(ref) {
    const refs = await readJson(this.#refsPath, {});
    const value = refs[ref];
    return value === undefined ? undefined : { value, source: 'keychain' };
  }

  async describe(ref) {
    const refs = await readJson(this.#refsPath, {});
    return { configured: Object.hasOwn(refs, ref), writable: true };
  }

  async set(ref, value) {
    if (!value) throw new Error('empty');
    await this.#withLock(async () => {
      const refs = await readJson(this.#refsPath, {});
      refs[ref] = value;
      await this.#writeAtomic(this.#refsPath, refs);
    });
  }

  async unset(ref) {
    await this.#withLock(async () => {
      const refs = await readJson(this.#refsPath, {});
      delete refs[ref];
      await this.#writeAtomic(this.#refsPath, refs);
    });
  }

  async readRecord(key) {
    const records = await readJson(this.#recordsPath, {});
    return records[key];
  }

  async describeRecord(key) {
    const records = await readJson(this.#recordsPath, {});
    const record = records[key];
    return record ? { configured: true, kind: record.kind, writable: true } : { configured: false, writable: true };
  }

  async listRecords() {
    const records = await readJson(this.#recordsPath, {});
    return Object.entries(records).map(([key, record]) => ({ key, kind: record.kind }));
  }

  async modifyRecord(key, mutate) {
    return this.#withLock(async () => {
      const records = await readJson(this.#recordsPath, {});
      const next = await mutate(records[key]);
      if (next === undefined) return records[key];
      records[key] = next;
      await this.#writeAtomic(this.#recordsPath, records);
      return next;
    });
  }

  async deleteRecord(key) {
    await this.#withLock(async () => {
      const records = await readJson(this.#recordsPath, {});
      delete records[key];
      await this.#writeAtomic(this.#recordsPath, records);
    });
  }
}
