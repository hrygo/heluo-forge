/**
 * Minimal in-memory CredentialProvider for offline service tests. Records use
 * the same shape and modifyRecord serialization as the real seam; values are
 * never logged.
 */
export class MemoryCredentials {
  constructor() {
    this.records = new Map();
    this.refs = new Map();
    this.locks = new Map();
  }

  async resolve(ref) {
    const value = this.refs.get(ref);
    return value === undefined ? undefined : { value, source: 'keychain' };
  }

  async describe(ref) {
    return { configured: this.refs.has(ref), writable: true };
  }

  async set(ref, value) {
    if (!value) throw new Error('empty');
    this.refs.set(ref, value);
  }

  async unset(ref) {
    this.refs.delete(ref);
  }

  async readRecord(key) {
    return this.records.get(key);
  }

  async describeRecord(key) {
    const record = this.records.get(key);
    return record ? { configured: true, kind: record.kind, writable: true } : { configured: false, writable: true };
  }

  async listRecords() {
    return [...this.records.entries()].map(([key, record]) => ({ key, kind: record.kind }));
  }

  async modifyRecord(key, mutate) {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.then(async () => {
      const current = this.records.get(key);
      const next = await mutate(current);
      if (next === undefined) return current;
      this.records.set(key, next);
      return next;
    });
    this.locks.set(key, run.catch(() => {}));
    return run;
  }

  async deleteRecord(key) {
    this.records.delete(key);
  }
}
