import { zipSync, strToU8 } from "fflate";
export const nacosConfig = { serverUrl: "https://nacos.corp.example/nacos", namespaceId: "public", usernameEnv: "TEST_NACOS_USER", passwordEnv: "TEST_NACOS_PASSWORD" };
export function useNacosEnvironment(context, overrides = {}) {
  const values = { TEST_NACOS_USER: "svc-ci", TEST_NACOS_PASSWORD: "synthetic-password", FORGE_NACOS_USERNAME: "svc-ci", FORGE_NACOS_PASSWORD: "synthetic-password" };
  Object.assign(values, overrides);
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  const assign = entries => Object.entries(entries).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  context.after(() => assign(previous));
  assign(values);
}
export const skillDocument = name => `---\nname: ${name}\ndescription: 合成测试技能\n---\nTest instructions.\n`;
export function fakeNacos() {
  const calls = [];
  const state = { name: "example-skill", version: "1.0.0", enable: true, token: "synthetic-read-token", status: 200, bytes: null, listData: null, hold: null };
  const fetcher = async (url, options = {}) => {
    const u = new URL(url); calls.push({ url: u, options });
    if (u.origin !== "https://nacos.corp.example") throw new Error("Unexpected external network");
    if (state.status !== 200) return new Response("synthetic-server-secret", { status: state.status });
    if (u.pathname.endsWith("/auth/user/login")) return Response.json({ accessToken: state.token, tokenTtl: 18000 });
    if (u.pathname.endsWith("/skills/list")) return Response.json(state.listData ?? { code: 0, data: { totalCount: 1, pageNumber: 1, pagesAvailable: 1, pageItems: [{ name: state.name, description: "合成测试技能", labels: { latest: state.version }, enable: state.enable }] } });
    if (u.pathname.endsWith("/skills/version/download")) {
      if (state.hold) await state.hold(options.signal);
      return new Response(state.bytes ?? zipSync({ [`${state.name}/SKILL.md`]: strToU8(skillDocument(state.name)), [`${state.name}/scripts/example.txt`]: strToU8("resource"), [`${state.name}/assets/binary.dat`]: new Uint8Array([0, 255, 17]) }), { headers: { "content-type": "application/zip" } });
    }
    throw new Error("Unexpected Nacos API");
  };
  return { fetcher, calls, state };
}
