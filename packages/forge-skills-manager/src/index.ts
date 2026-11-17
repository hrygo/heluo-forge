import * as local from './core.js';
import type { HostContext } from './host-types.js';
import { installHttp } from './http.js';
import { createInstallationManager } from './installations.js';
import { makeLog } from './logger.js';
import type { NacosConfig } from './nacos.js';
import { createNacosClient } from './nacos.js';
import { notifyChatCatalog } from './notifications.js';
import { createProviderRuntime,installProviders } from './providers.js';
import { registeredWorkspacePaths } from './workspace-scope.js';
export { notifyChatCatalog } from './notifications.js';
export { activeSessionCwds } from './workspace-scope.js';
export const name = 'skills-manager';
export const inject = ['connection', 'skills', 'sessions'];
export interface PluginConfig { nacos?: NacosConfig }
export function apply(ctx: HostContext, config?: PluginConfig) {
 const log = makeLog(local.logPath());
 const nacos = createNacosClient(config?.nacos);
 const providers = installProviders(ctx, createProviderRuntime(local), notifyChatCatalog);
 const installations = createInstallationManager({ local, log, registeredWorkspaces: () => registeredWorkspacePaths(ctx), getPresetRoots: () => providers.getPresetRootsCached() });
 installHttp(ctx, { local, nacos, log, installations, providers });
}
