import * as local from "./core.js";
import { installHttp } from "./http.js";
import { createInstallationManager } from "./installations.js";
import { createInstallOperations } from "./install-operations.js";
import { makeLog } from "./logger.js";
import { createNacosClient } from "./nacos.js";
import { notifyChatCatalog } from "./notifications.js";
import { createProviderRuntime, installProviders } from "./providers.js";
import { registeredWorkspacePaths } from "./workspace-scope.js";
import { notifyChatCatalog as notifyChatCatalog2 } from "./notifications.js";
import { activeSessionCwds } from "./workspace-scope.js";
const name = "skills-manager";
const inject = ["connection", "skills", "sessions"];
function apply(ctx, config) {
  const log = makeLog(local.logPath());
  const nacos = createNacosClient(config?.nacos);
  const operations = createInstallOperations();
  const providers = installProviders(ctx, createProviderRuntime(local), notifyChatCatalog);
  const installations = createInstallationManager({ local, log, registeredWorkspaces: () => registeredWorkspacePaths(ctx), getPresetRoots: () => providers.getPresetRootsCached() });
  installHttp(ctx, { local, nacos, log, installations, providers, operations });
}
export {
  activeSessionCwds,
  apply,
  inject,
  name,
  notifyChatCatalog2 as notifyChatCatalog
};
