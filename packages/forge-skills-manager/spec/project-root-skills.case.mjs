// 验证项目根 skills 仅是普通资源目录，不进入管理页或 Agent provider。
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temp = await mkdtemp(join(process.env.TMPDIR || tmpdir(), "dssm-root-skills-"));
process.env.HOME = join(temp, "home");
process.env.USERPROFILE = join(temp, "home");
for (const key of [
  "DSH", "AGENTS", "CODEX", "CLAUDE", "GEMINI", "OPENCODE", "CURSOR",
  "COPILOT", "WINDSURF", "WINDSURF_USER", "TRAE", "TRAE_CN", "OPENCLAW",
  "CLAWDBOT", "ROO", "CODEBUDDY", "WORKBUDDY", "QODER", "QODER_CN", "LINGMA",
]) process.env[`DSH_${key === "DSH" ? "" : key + "_"}HOME`] = join(temp, key);
const core = await import("../lib/core.js");

async function createSkill(root, name) {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  const path = join(directory, "SKILL.md");
  const content = `---\nname: ${name}\ndescription: 扫描边界回归\n---\n${name} 正文`;
  await writeFile(path, content, "utf8");
  return { path, content, realEntryPath: await realpath(directory), realDocPath: await realpath(path) };
}

try {
  const project = join(temp, "project");
  await mkdir(join(project, ".git"), { recursive: true });
  const asset = await createSkill(join(project, "skills"), "release-resource");
  const projectRoot = (await core.projectRoots([project])).find(root => root.kind === "project-dsh");
  const legacyKey = projectRoot.key.replace("project-dsh:", "project-openclaw:");
  const legacyState = (await core.readManagerState()).state;
  legacyState.sources[legacyKey] = true;
  legacyState.enabledSkills[legacyKey] = ["release-resource"];
  legacyState.disabledSkills[legacyKey] = [];
  await mkdir(join(process.env.DSH_HOME, "skills-manager"), { recursive: true });
  const serialized = JSON.stringify(legacyState);
  await writeFile(core.managerStatePath(), serialized, "utf8");

  assert.deepEqual((await core.projectRoots([project])).map(root => root.kind), ["project-dsh"], "项目根 skills 不注册为项目来源，即使历史策略曾显式开启");
  const view = await core.state({ projectCwds: [project] });
  assert.equal(view.roots.some(root => root.kind === "project-openclaw" || root.localeKey === "projectSkills"), false, "管理页不展示根 skills 来源");
  assert.equal(view.roots.flatMap(root => root.skills).some(skill => skill.name === "release-resource"), false, "管理页不展示仓库发布资源");
  assert.equal((await core.listProviderCandidates({ cwd: project })).some(candidate => candidate.name === "release-resource"), false, "Agent provider 不提供仓库发布资源");
  assert.equal(await core.getProviderSkill({
    name: "release-resource", provider: "dsh-skills-manager-external", source: "project-openclaw",
    locator: { rootKey: legacyKey, entryName: "release-resource", path: asset.path, realEntryPath: asset.realEntryPath, realDocPath: asset.realDocPath },
  }, { cwd: project }), undefined, "旧缓存的根 skills 候选也不能读取正文");
  assert.equal((await core.readManagerState()).writable, true, "合法历史策略不会导致整个配置失败关闭");
  assert.equal(await readFile(core.managerStatePath(), "utf8"), serialized, "只读扫描不改写历史配置");
  assert.equal(await readFile(asset.path, "utf8"), asset.content, "移除扫描不删除或修改技能资源文件");

  // 无 Git 的普通工作区也不能误扫根 skills。
  const plain = join(temp, "plain");
  await createSkill(join(plain, "skills"), "plain-resource");
  assert.deepEqual((await core.projectRoots([plain])).map(root => root.kind), ["project-dsh"]);
  assert.equal((await core.listProviderCandidates({ cwd: plain })).some(candidate => candidate.name === "plain-resource"), false);

  // 保留明确的项目目录与用户级 OpenClaw 来源。
  await createSkill(join(project, ".dsh", "skills"), "project-native");
  await createSkill(join(project, ".agents", "skills"), "project-agent");
  const openclaw = core.userRoots().find(root => root.key === "openclaw");
  await createSkill(openclaw.path, "global-openclaw");
  const supported = await core.state({ projectCwds: [project] });
  for (const name of ["project-native", "project-agent", "global-openclaw"])
    assert.ok(supported.roots.flatMap(root => root.skills).some(skill => skill.name === name), `保留有效来源 ${name}`);
  const global = (await core.listProviderCandidates({ cwd: project })).find(candidate => candidate.name === "global-openclaw");
  assert.ok(global, "用户级 OpenClaw 继续提供候选");
  assert.equal((await core.getProviderSkill(global, { cwd: project })).content, "global-openclaw 正文");
  console.log("项目根 skills 排除、历史候选拒绝、资源保留与有效来源回归通过");
} finally {
  await rm(temp, { recursive: true, force: true });
}
