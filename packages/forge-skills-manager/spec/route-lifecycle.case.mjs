// Exercise Cordis itself: direct apply() mocks do not model constructor-style
// plugin startup or effect disposal during restart and failed activation.
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { WebServer } from "@deepseek-ai/dsh-host-webserver";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as plugin from "../lib/index.js";
import { installHttp } from "../lib/http.js";
import { createInstallOperations } from "../lib/install-operations.js";

const prefix = "/api/forge-skills-manager";
const ctx = new Context();
const fetchRoutes = new Map();
const connection = {
  fetch: {
    register(route) {
      if (fetchRoutes.has(route.path)) throw new Error(`duplicate fetch route: ${route.path}`);
      fetchRoutes.set(route.path, route);
      return () => {
        fetchRoutes.delete(route.path);
      };
    },
  },
};
for (const [name, value] of Object.entries({
  connection,
  skills: { registerProvider() { return () => {}; } },
  tools: {},
  sessions: {},
})) ctx.provide(name, value);

try {
  const fiber = ctx.plugin(plugin);
  await fiber.await();
  assert.ok(fetchRoutes.size > 0, "启动后成功注册所有 Fetch 路由");
  const initialSize = fetchRoutes.size;
  assert.deepEqual(fetchRoutes.get(`${prefix}/operation-status`).methods, ["GET", "HEAD"]);
  let previous = fetchRoutes.get(`${prefix}/state`);
  assert.ok(previous);
  for (let cycle = 0; cycle < 3; cycle++) {
    await fiber.restart();
    assert.equal(fetchRoutes.size, initialSize);
    assert.notEqual(fetchRoutes.get(`${prefix}/state`), previous, "restart installs a fresh handler");
    previous = fetchRoutes.get(`${prefix}/state`);
  }
  await fiber.dispose();
  await fiber.await();
  assert.equal(fetchRoutes.size, 0, "unload releases all Fetch routes");

  // A later startup error must also release an already registered main route.
  const failing = ctx.plugin({
    inject: plugin.inject,
    apply(scope) {
      plugin.apply(scope);
      throw new Error("failure after route registration");
    },
  });
  await assert.rejects(failing.await(), /failure after route registration/);
  assert.equal(fetchRoutes.size, 0);
  await failing.dispose();

  // A real collision must not silently reuse or replace another owner's route.
  const foreign = { path: `${prefix}/state`, methods: ["GET"], fetch: async () => new Response("ok") };
  const releaseForeign = connection.fetch.register(foreign);
  const conflict = ctx.plugin(plugin);
  await assert.rejects(conflict.await(), /duplicate fetch route/);
  assert.equal(fetchRoutes.get(`${prefix}/state`), foreign);
  await conflict.dispose();
  releaseForeign();

  for (const path of [`${prefix}/nacos/list`, `${prefix}/upload`]) {
    const foreignRoute = { path, methods: ["GET"], fetch: async () => new Response("foreign") };
    const release = connection.fetch.register(foreignRoute);
    const partiallyRegistered = ctx.plugin(plugin);
    await assert.rejects(partiallyRegistered.await(), /duplicate fetch route/);
    await partiallyRegistered.dispose();
    assert.deepEqual([...fetchRoutes.values()], [foreignRoute]);
    release();
  }

  const reactivated = ctx.plugin(plugin);
  await reactivated.await();
  assert.equal(fetchRoutes.size, initialSize);
  await reactivated.dispose();
  await reactivated.await();
  assert.equal(fetchRoutes.size, 0);

  const managerPath = join(tmpdir(), `forge-cordis-lifetime-${randomUUID()}`);
  const writes = [];
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const paused = new Promise(resolve => { release = resolve; });
  const fixture = setter => ({
    inject: plugin.inject,
    apply(scope) {
      installHttp(scope, {
        local: { setEntryLocation: setter, userRoots: () => [] },
        installations: { managerPath }, nacos: {}, operations: createInstallOperations(),
        providers: { afterWrite() {} }, log() {},
      });
    },
  });
  const request = (location, operationId = randomUUID()) => new Request(`http://localhost${prefix}/sidebar-entry`, {
    method: "POST", headers: { "content-type": "application/json", "x-dsh-skills-manager": "1", "x-dsh-skills-operation": operationId }, body: JSON.stringify({ location }),
  });
  const slow = ctx.plugin(fixture(async location => { writes.push("old started"); entered(); await paused; writes.push("old committed"); return location; }));
  await slow.await();
  const staleRoute = fetchRoutes.get(`${prefix}/sidebar-entry`);
  const runningId = randomUUID();
  const running = staleRoute.fetch(request("both", runningId));
  await started;
  const queued = staleRoute.fetch(request("sidebar"));
  await new Promise(setImmediate);
  const draining = slow.dispose();
  try {
    assert.equal((await (await queued).json()).outcome, "rejected");
    assert.equal(fetchRoutes.size, 0);
    const replacement = ctx.plugin(fixture(async location => { writes.push("new committed"); return location; }));
    await replacement.await();
    const next = fetchRoutes.get(`${prefix}/sidebar-entry`).fetch(request("settings"));
    await new Promise(setImmediate);
    assert.deepEqual(writes, ["old started"]);
    release();
    assert.equal((await running).status, 200);
    await draining;
    assert.equal((await next).status, 200);
    assert.deepEqual(writes, ["old started", "old committed", "new committed"]);
    const status = await fetchRoutes.get(`${prefix}/operation-status`).fetch(new Request(`http://localhost${prefix}/operation-status?operationId=${runningId}`));
    assert.equal((await status.json()).data.state, "succeeded");
    assert.equal((await staleRoute.fetch(request("both"))).status, 499);
    await replacement.dispose();
  } finally { release(); await draining; }
} finally {
  await ctx.fiber.dispose();
}

console.log("Cordis route lifecycle: restart, unload, failed activation, collision and reactivation passed");
