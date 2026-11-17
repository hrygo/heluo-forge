import { appendFile, rename, rm, stat } from "node:fs/promises";
const MAX_LOG_BYTES = 1 << 20;
function makeLog(file) {
  let queue = Promise.resolve();
  return async (event, detail) => {
    queue = queue.then(async () => {
      try {
        const current = await stat(file).catch(() => null);
        if (current && current.size >= MAX_LOG_BYTES) {
          await rm(`${file}.1`, { force: true });
          await rename(file, `${file}.1`);
        }
        await appendFile(file, `${JSON.stringify({ ts: (/* @__PURE__ */ new Date()).toISOString(), event, detail })}
`, "utf8");
      } catch {
      }
    });
    await queue;
  };
}
export {
  makeLog
};
