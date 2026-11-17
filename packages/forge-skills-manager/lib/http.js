import { realpath } from "node:fs/promises";
import { installationSourceKey } from "./installation-records.js";
import { attachProvenance } from "./provenance.js";
import { activeSessionCwds, registeredWorkspacePaths } from "./workspace-scope.js";
const CLIENT_MARKER_HEADER = "x-dsh-skills-manager";
const MAX_UPLOAD_BODY_BYTES = 88 << 20;
async function readJsonBody(request, limit = 1 << 20) {
  const text = await request.text();
  if (Buffer.byteLength(text) > limit) {
    const error = new Error("body too large");
    error.statusCode = 413;
    error.code = "error.proto.bodyTooLarge";
    throw error;
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (caught) {
    const e = caught;
    const error = new Error(`invalid JSON body: ${e.message}`);
    error.statusCode = 400;
    error.code = "error.proto.invalidJson";
    throw error;
  }
}
function validateMutationRequest(req) {
  const marker = req.headers.get(CLIENT_MARKER_HEADER) || req.headers.get("x-michengai-client");
  if (marker !== "1") return { statusCode: 403, code: "error.proto.forbidden", error: "forbidden mutation request" };
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      const originHost = new URL(origin).host;
      const reqHost = req.headers.get("host") || new URL(req.url).host;
      if (originHost !== reqHost) {
        return { statusCode: 403, code: "error.proto.forbidden", error: "forbidden cross-origin mutation request" };
      }
    } catch {
      return { statusCode: 403, code: "error.proto.forbidden", error: "forbidden origin" };
    }
  }
  const contentType = String(req.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") return { statusCode: 415, code: "error.proto.contentType", error: "content-type must be application/json" };
  return null;
}
function jsonResponse(code, payload, headOnly = false) {
  const body = JSON.stringify(payload);
  return new Response(headOnly ? null : body, {
    status: code,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": String(Buffer.byteLength(body))
    }
  });
}
async function runFetch(task, afterSuccess, headOnly = false) {
  try {
    const r = await task();
    if (r && typeof r === "object" && "ok" in r && r.ok === false) {
      return jsonResponse(400, r, headOnly);
    }
    if (afterSuccess) {
      try {
        afterSuccess();
      } catch {
      }
    }
    return jsonResponse(200, { ok: true, data: r }, headOnly);
  } catch (caught) {
    const e = caught;
    const status = Number.isInteger(e && e.statusCode) ? e.statusCode : 500;
    const known = typeof e?.code === "string" && e.code.startsWith("error.");
    if (!known) throw caught;
    return jsonResponse(status, {
      ok: false,
      ...e && typeof e.code === "string" ? { code: e.code } : {},
      ...e && e.params && typeof e.params === "object" && !Array.isArray(e.params) ? { params: e.params } : {},
      error: String(e && e.message ? e.message : e)
    }, headOnly);
  }
}
function installHttp(ctx, dependencies) {
  const { local, nacos, log, installations: repositories, providers } = dependencies;
  const { getEntryLocation, setEntryLocation, state, setSkillEnabled, setSourceEnabled, createCategory, renameCategory, deleteCategory, assignSkillCategory, moveSkillInCategory, setCategoryEnabled, setSkillNote, importSkill, importUploadedSkill, browseDirectories, createSkill, skillDetail, userRoots, setRootPath, addCustomSources, updateCustomSource, removeCustomSource, scanCustomSourceCandidates, projectRoots, resolveWorkspaceTarget, listWorkspaces, workspaceSkills } = local;
  const { afterWrite } = providers;
  const findUserRoot = (key) => userRoots().find((root) => root.key === key);
  let mutationQueue = Promise.resolve();
  const enqueueMutation = (task) => {
    const next = mutationQueue.then(task, task);
    mutationQueue = next.catch(() => void 0);
    return next;
  };
  const API_PREFIX = "/api/forge-skills-manager";
  const projectOptions = (sessionId) => ({ projectCwds: activeSessionCwds(ctx, sessionId ?? void 0) });
  const workspaceTarget = async (body) => {
    if (body.workspace === void 0) return null;
    return resolveWorkspaceTarget(body.workspace, registeredWorkspacePaths(ctx));
  };
  const workspaceScope = async (body) => {
    const target = await workspaceTarget(body);
    if (!target) return null;
    if ("ok" in target && target.ok === false) return target;
    return { projectCwds: target.root.workspaceCwds ?? [] };
  };
  const scopedOptions = (scope, sessionId, presetRoots) => ({
    ...scope ?? projectOptions(sessionId),
    ...presetRoots ? { presetRoots } : {}
  });
  const requestRoot = async (key, cwds, sessionId) => {
    if (cwds) return (await projectRoots(cwds)).find((root) => root.key === key);
    const user = findUserRoot(key);
    if (user) return user;
    const project = (await projectRoots(projectOptions(sessionId).projectCwds)).find((root) => root.key === key);
    if (project) return project;
    const presets = await providers.getPresetRootsCached();
    const hit = presets.find((root) => root.key === key);
    if (hit) return hit;
    if (key.startsWith("preset-")) {
      return (await providers.getPresetRootsOnMiss()).find((root) => root.key === key);
    }
    return void 0;
  };
  const attachSources = async (snapshot) => {
    try {
      const recovery = await repositories.recoverLocal();
      snapshot.warnings.push(...recovery.warnings);
      const sources = await repositories.sources();
      for (const root of snapshot.roots) {
        const realRoot = await realpath(root.path).catch(() => root.path);
        for (const skill of root.skills || []) skill.installSource = sources[installationSourceKey(realRoot, skill.name)] ?? null;
      }
    } catch (caught) {
      const error = caught;
      snapshot.warnings.push({ code: "error.repo.state", error: error.message });
    }
    try {
      await attachProvenance(snapshot);
    } catch (caught) {
      const error = caught;
      snapshot.warnings.push({ code: "error.repo.state", error: error.message });
    }
    return snapshot;
  };
  const stateWithSources = async (req) => {
    const presetRoots = await providers.getPresetRootsCached(true);
    return attachSources(await state({ ...projectOptions(req.headers.get("x-dsh-skills-session")), presetRoots }));
  };
  const handlePost = async (req, action, options) => {
    const mutationError = validateMutationRequest(req);
    if (mutationError) {
      return jsonResponse(mutationError.statusCode, { ok: false, code: mutationError.code, error: mutationError.error });
    }
    let body;
    try {
      body = await readJsonBody(req, options?.maxBytes);
    } catch (caught) {
      const e = caught;
      return jsonResponse(Number.isInteger(e && e.statusCode) ? e.statusCode : 400, {
        ok: false,
        code: e && typeof e.code === "string" ? e.code : "error.proto.invalidJson",
        error: String(e && e.message ? e.message : e)
      });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return jsonResponse(400, { ok: false, code: "error.proto.invalidParams", error: "\u8BF7\u6C42\u53C2\u6570\u5FC5\u987B\u662F\u5BF9\u8C61" });
    }
    const execute = async () => {
      const scope = await workspaceScope(body);
      if (scope && "ok" in scope && scope.ok === false) return scope;
      return action(body, scope, req);
    };
    const afterSuccess = options?.afterSuccess ? () => options.afterSuccess(body) : void 0;
    return runFetch(() => options?.queued !== false ? enqueueMutation(execute) : execute(), afterSuccess);
  };
  const routes = [
    {
      path: `${API_PREFIX}/state`,
      methods: ["GET", "HEAD"],
      fetch: (req) => runFetch(() => stateWithSources(req), void 0, req.method === "HEAD")
    },
    {
      path: `${API_PREFIX}/sidebar-entry`,
      methods: ["GET", "HEAD", "POST"],
      fetch: (req) => {
        if (req.method === "GET" || req.method === "HEAD") {
          return runFetch(async () => {
            const location = await getEntryLocation();
            return { ok: true, location, enabled: location !== "settings" };
          }, void 0, req.method === "HEAD");
        }
        return handlePost(req, async (b) => {
          if (!b) {
            throw Object.assign(new Error("\u8BF7\u6C42\u4F53\u4E0D\u80FD\u4E3A\u7A7A"), { statusCode: 400, code: "error.proto.invalidParams" });
          }
          if (typeof b.location === "string") {
            if (b.location !== "both" && b.location !== "sidebar" && b.location !== "settings") {
              throw Object.assign(new Error("location \u5FC5\u987B\u662F both\u3001sidebar \u6216 settings"), { statusCode: 400, code: "error.proto.invalidParams" });
            }
            const location = await setEntryLocation(b.location);
            return { ok: true, location, enabled: location !== "settings" };
          }
          if (typeof b.enabled === "boolean") {
            const location = await setEntryLocation(b.enabled ? "both" : "settings");
            return { ok: true, location, enabled: location !== "settings" };
          }
          throw Object.assign(new Error("\u7F3A\u5C11\u5408\u6CD5\u7684 location \u6216 enabled \u53C2\u6570"), { statusCode: 400, code: "error.proto.invalidParams" });
        });
      }
    },
    {
      path: `${API_PREFIX}/workspaces`,
      methods: ["GET", "HEAD"],
      fetch: (req) => runFetch(async () => ({ items: await listWorkspaces(registeredWorkspacePaths(ctx) ?? []) }), void 0, req.method === "HEAD")
    },
    {
      path: `${API_PREFIX}/nacos/list`,
      methods: ["GET"],
      fetch: (req) => runFetch(() => {
        const query = new URL(req.url).searchParams;
        if ([...query.keys()].some((k) => !["q", "page"].includes(k) || query.getAll(k).length !== 1)) {
          throw Object.assign(new Error("\u641C\u7D22\u6761\u4EF6\u65E0\u6548"), { code: "error.nacos.query", statusCode: 400 });
        }
        return nacos.list(query.get("q") ?? "", query.has("page") ? Number(query.get("page")) : 1, req.signal);
      })
    },
    {
      path: `${API_PREFIX}/nacos/detail`,
      methods: ["POST"],
      fetch: (req) => handlePost(req, (b) => nacos.detail(b, req.signal), { queued: false })
    },
    {
      path: `${API_PREFIX}/nacos/install`,
      methods: ["POST"],
      fetch: (req) => handlePost(req, async (b) => {
        if (b.root !== void 0 && b.root !== "dsh") throw Object.assign(new Error("\u4F01\u4E1A\u6280\u80FD\u53EA\u80FD\u4E0B\u8F7D\u5230 DSH \u5168\u5C40\u6216\u5DF2\u767B\u8BB0\u9879\u76EE"), { code: "error.nacos.query", statusCode: 400 });
        const target = await workspaceTarget(b);
        if (target && "ok" in target && target.ok === false) return target;
        const pack = await nacos.load(b, req.signal);
        return enqueueMutation(async () => {
          if (req.signal.aborted) throw Object.assign(new Error("\u4E0B\u8F7D\u5DF2\u53D6\u6D88"), { code: "error.nacos.cancelled", statusCode: 499 });
          if (target) {
            const current = await workspaceTarget(b);
            if (current && "ok" in current && current.ok === false) return current;
            if (!current || current.root.projectRoot !== target.root.projectRoot) {
              throw Object.assign(new Error("\u9879\u76EE\u6839\u5DF2\u53D8\u5316\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u65B0\u9009\u62E9\u4E0B\u8F7D\u4F4D\u7F6E"), { code: "error.workspace.unregistered", statusCode: 400 });
            }
          }
          return repositories.installCatalog(pack.id, pack.pack, { root: "dsh", ...b.workspace === void 0 ? {} : { workspace: b.workspace }, disabledOnInstall: true, signal: req.signal });
        });
      }, { queued: false, afterSuccess: afterWrite })
    },
    {
      path: `${API_PREFIX}/browse`,
      methods: ["POST"],
      fetch: (req) => handlePost(req, (b) => browseDirectories(b.path), { queued: false })
    },
    {
      path: `${API_PREFIX}/workspace-skills`,
      methods: ["POST"],
      fetch: (req) => handlePost(req, async (b) => {
        const snapshot = await workspaceSkills(b.workspace, registeredWorkspacePaths(ctx));
        return "roots" in snapshot ? attachSources(snapshot) : snapshot;
      })
    },
    {
      path: `${API_PREFIX}/enable`,
      methods: ["POST"],
      fetch: (req) => handlePost(req, async (b, scope) => setSkillEnabled(await requestRoot(String(b.root || "dsh"), scope?.projectCwds, req.headers.get("x-dsh-skills-session")), String(b.name || ""), true, log), { afterSuccess: afterWrite })
    },
    {
      path: `${API_PREFIX}/disable`,
      methods: ["POST"],
      fetch: (req) => handlePost(req, async (b, scope) => setSkillEnabled(await requestRoot(String(b.root || "dsh"), scope?.projectCwds, req.headers.get("x-dsh-skills-session")), String(b.name || ""), false, log), { afterSuccess: afterWrite })
    },
    {
      path: `${API_PREFIX}/source-enable`,
      methods: ["POST"],
      fetch: (req) => handlePost(req, async (b, scope) => {
        const presetRoots = await providers.getPresetRootsCached();
        return setSourceEnabled(String(b.root || ""), true, log, scopedOptions(scope, req.headers.get("x-dsh-skills-session"), presetRoots));
      }, { afterSuccess: afterWrite })
    },
    {
      path: `${API_PREFIX}/source-disable`,
      methods: ["POST"],
      fetch: (req) => handlePost(req, async (b, scope) => {
        const presetRoots = await providers.getPresetRootsCached();
        return setSourceEnabled(String(b.root || ""), false, log, scopedOptions(scope, req.headers.get("x-dsh-skills-session"), presetRoots));
      }, { afterSuccess: afterWrite })
    },
    {
      path: `${API_PREFIX}/root-path`,
      methods: ["POST"],
      fetch: (req) => handlePost(req, (b) => setRootPath(String(b.key || ""), b.path === void 0 ? null : b.path), { afterSuccess: afterWrite })
    },
    {
      path: `${API_PREFIX}/custom-source-add`,
      methods: ["POST"],
      fetch: (req) => handlePost(req, (b) => addCustomSources(Array.isArray(b.sources) ? b.sources : b), { afterSuccess: afterWrite })
    },
    {
      path: `${API_PREFIX}/custom-source-update`,
      methods: ["POST"],
      fetch: (req) => handlePost(req, (b) => updateCustomSource(String(b.id || ""), b), { afterSuccess: afterWrite })
    },
    {
      path: `${API_PREFIX}/custom-source-remove`,
      methods: ["POST"],
      fetch: (req) => handlePost(req, (b) => removeCustomSource(String(b.id || "")), { afterSuccess: afterWrite })
    },
    {
      path: `${API_PREFIX}/custom-source-scan`,
      methods: ["POST"],
      fetch: (req) => handlePost(req, (b) => scanCustomSourceCandidates(b.path))
    },
    {
      path: `${API_PREFIX}/category-create`,
      methods: ["POST"],
      fetch: (req) => handlePost(req, async (b, scope) => createCategory(String(b.root || ""), String(b.name || ""), log, scopedOptions(scope, req.headers.get("x-dsh-skills-session"), await providers.getPresetRootsCached())))
    },
    {
      path: `${API_PREFIX}/category-rename`,
      methods: ["POST"],
      fetch: (req) => handlePost(req, async (b, scope) => renameCategory(String(b.root || ""), String(b.id || ""), String(b.name || ""), log, scopedOptions(scope, req.headers.get("x-dsh-skills-session"), await providers.getPresetRootsCached())))
    },
    {
      path: `${API_PREFIX}/category-delete`,
      methods: ["POST"],
      fetch: (req) => handlePost(req, async (b, scope) => deleteCategory(String(b.root || ""), String(b.id || ""), log, scopedOptions(scope, req.headers.get("x-dsh-skills-session"), await providers.getPresetRootsCached())))
    },
    {
      path: `${API_PREFIX}/category-assign`,
      methods: ["POST"],
      fetch: (req) => handlePost(req, async (b, scope) => assignSkillCategory(String(b.root || ""), String(b.name || ""), String(b.category || ""), log, scopedOptions(scope, req.headers.get("x-dsh-skills-session"), await providers.getPresetRootsCached())))
    },
    {
      path: `${API_PREFIX}/category-move`,
      methods: ["POST"],
      fetch: (req) => handlePost(req, async (b, scope) => moveSkillInCategory(String(b.root || ""), String(b.name || ""), String(b.category || ""), b.targetName ? String(b.targetName) : void 0, b.position === void 0 ? "before" : String(b.position), log, scopedOptions(scope, req.headers.get("x-dsh-skills-session"), await providers.getPresetRootsCached())))
    },
    {
      path: `${API_PREFIX}/category-enable`,
      methods: ["POST"],
      fetch: (req) => handlePost(req, async (b, scope) => setCategoryEnabled(String(b.root || ""), String(b.category || ""), true, log, scopedOptions(scope, req.headers.get("x-dsh-skills-session"), await providers.getPresetRootsCached())), { afterSuccess: afterWrite })
    },
    {
      path: `${API_PREFIX}/category-disable`,
      methods: ["POST"],
      fetch: (req) => handlePost(req, async (b, scope) => setCategoryEnabled(String(b.root || ""), String(b.category || ""), false, log, scopedOptions(scope, req.headers.get("x-dsh-skills-session"), await providers.getPresetRootsCached())), { afterSuccess: afterWrite })
    },
    {
      path: `${API_PREFIX}/skill-note`,
      methods: ["POST"],
      fetch: (req) => handlePost(req, async (b, scope) => setSkillNote(String(b.root || ""), String(b.name || ""), String(b.note || ""), log, scopedOptions(scope, req.headers.get("x-dsh-skills-session"), await providers.getPresetRootsCached())), { afterSuccess: afterWrite })
    },
    {
      path: `${API_PREFIX}/delete`,
      methods: ["POST"],
      fetch: (req) => handlePost(req, async (b, scope) => {
        const target = await workspaceTarget(b);
        if (target && "ok" in target && target.ok === false) return target;
        const root = target ? target.root : await requestRoot(String(b.root || "dsh"), scope?.projectCwds, req.headers.get("x-dsh-skills-session"));
        return repositories.trashSkill(root, String(b.name || ""));
      }, { afterSuccess: afterWrite })
    },
    {
      path: `${API_PREFIX}/trash-restore`,
      methods: ["POST"],
      fetch: (req) => handlePost(req, (b, scope) => repositories.restoreTrash(String(b.id || ""), { ...scope ?? {}, registeredWorkspaces: registeredWorkspacePaths(ctx) }), { afterSuccess: afterWrite })
    },
    {
      path: `${API_PREFIX}/trash-delete`,
      methods: ["POST"],
      fetch: (req) => handlePost(req, (b) => repositories.permanentlyDeleteTrash(String(b.id || "")))
    },
    {
      path: `${API_PREFIX}/detail`,
      methods: ["POST"],
      fetch: (req) => handlePost(req, async (b, scope) => {
        const presetRoots = await providers.getPresetRootsCached();
        return skillDetail(String(b.root || "dsh"), String(b.name || ""), {
          ...scope ? { ...scope, workspaceBound: true } : projectOptions(req.headers.get("x-dsh-skills-session")),
          presetRoots
        });
      })
    },
    {
      path: `${API_PREFIX}/create`,
      methods: ["POST"],
      fetch: (req) => handlePost(req, async (b) => {
        const target = await workspaceTarget(b);
        if (target && "ok" in target && target.ok === false) return target;
        return createSkill(
          { name: b.name, description: b.description, body: b.body },
          log,
          { root: target ? target.root : await requestRoot(String(b.root || "dsh"), void 0, req.headers.get("x-dsh-skills-session")) }
        );
      }, { afterSuccess: afterWrite })
    },
    {
      path: `${API_PREFIX}/import`,
      methods: ["POST"],
      fetch: (req) => handlePost(req, async (b) => {
        const target = await workspaceTarget(b);
        if (target && "ok" in target && target.ok === false) return target;
        const root = target ? target.root : await requestRoot(String(b.root || "dsh"), void 0, req.headers.get("x-dsh-skills-session"));
        return importSkill(String(b.source || ""), log, {
          conflict: b.conflict === "overwrite" ? "overwrite" : "skip",
          dryRun: b.dryRun === true,
          root
        });
      }, { afterSuccess: (b) => {
        if (b.dryRun !== true) afterWrite();
      } })
    },
    {
      path: `${API_PREFIX}/upload`,
      methods: ["POST"],
      fetch: (req) => handlePost(req, async (b) => {
        const target = await workspaceTarget(b);
        if (target && "ok" in target && target.ok === false) return target;
        const root = target ? target.root : await requestRoot(String(b.root || "dsh"), void 0, req.headers.get("x-dsh-skills-session"));
        return importUploadedSkill({ name: b.name, entries: b.entries, zip: b.zip }, log, {
          conflict: b.conflict === "overwrite" ? "overwrite" : "skip",
          root
        });
      }, { afterSuccess: afterWrite, maxBytes: MAX_UPLOAD_BODY_BYTES })
    }
  ];
  ctx.effect(() => {
    if (ctx.connection?.fetch?.register) {
      const disposers = routes.map(
        (route) => ctx.connection.fetch.register({
          path: route.path,
          methods: route.methods,
          requestBody: route.requestBody ?? "buffered",
          fetch: route.fetch
        })
      );
      return () => {
        for (const disposer of disposers) {
          try {
            disposer();
          } catch {
          }
        }
      };
    }
    ctx.logger?.warn?.("Skills Manager routes require authenticated connection.fetch");
    return () => {
    };
  }, "skills-manager: API routes");
}
export {
  installHttp
};
