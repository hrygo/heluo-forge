/**
 * `@heluo/forge-devops-workbench` DSH Host 插件入口（Cordis Plugin）。
 *
 * 严格遵循：
 *   1. `inject = []`，通过动态可选绑定接入 iam / credentials / devops / gitee / webServer，
 *      确保即使独立挂载或顺序不定也不卡 pending；
 *   2. 严格不修改 DSH 核心代码；
 *   3. 卸载（effect disposer）时中断全部在途 HTTP 请求并清空 RMP `_tk` 与 profile 缓存。
 */
import { Config, resolveEnvConfig, validateConfig } from './shared/config.mjs';
import { createWorkbenchHttpApi, toNodeRoute, WORKBENCH_API_PREFIX } from './http.mjs';
import { createPreferencesStore } from './shared/preferences.mjs';
import { createRuntimeConfigStore } from './shared/runtime-config.mjs';
import { createWorkbenchService } from './service.mjs';
import { buildWorkbenchTools } from './tools.mjs';

export const name = 'forge-devops-workbench';
export const inject = [];
export { Config, validateConfig };

function pickService(ctx, serviceName) {
  if (!ctx) return null;
  if (typeof ctx.get === 'function') {
    try {
      const svc = ctx.get(serviceName);
      if (svc && typeof svc === 'object') return svc;
    } catch {
      // Cordis 在服务未就绪或未声明依赖时可能抛错，交由动态 ctx.inject 绑定
    }
  }
  try {
    if (ctx[serviceName] && typeof ctx[serviceName] === 'object') return ctx[serviceName];
  } catch {
    // Cordis strict inject proxy: reading ctx[name] without top-level `inject` throws
  }
  return null;
}

/**
 * Cordis 插件激活入口。
 *
 * @param {object} ctx Cordis Context
 * @param {object} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  const baseConfig = validateConfig(rawConfig);
  const envConfig = resolveEnvConfig(process.env);

  let iamRef = pickService(ctx, 'iam');
  let devopsRef = pickService(ctx, 'devops');
  let giteeRef = pickService(ctx, 'gitee');
  let connectionRef = pickService(ctx, 'connection');

  const logEvent = (eventName, fields) => {
    try {
      ctx?.logger?.info?.({ event: eventName, ...fields });
    } catch {
      // 忽略 logger 不可用
    }
  };

  const preferencesStore = createPreferencesStore();
  const runtimeConfigStore = createRuntimeConfigStore();

  const service = createWorkbenchService({
    config: baseConfig,
    baseConfig,
    envConfig,
    runtimeConfigStore,
    getIam: () => iamRef ?? pickService(ctx, 'iam'),
    getDevops: () => devopsRef ?? pickService(ctx, 'devops'),
    getGitee: () => giteeRef ?? pickService(ctx, 'gitee'),
    preferencesStore,
    logger: logEvent,
  });

  if (typeof ctx?.provide === 'function') {
    ctx.provide('devopsWorkbench', service);
  }

  const httpApi = createWorkbenchHttpApi(service, {
    getConnection: () => connectionRef ?? pickService(ctx, 'connection'),
  });
  const routeHandler = toNodeRoute(httpApi);
  let mountedWebServer = null;
  let mountedTools = null;

  const mountRoute = (webServer) => {
    if (!webServer || typeof webServer.register !== 'function') return;
    if (mountedWebServer === webServer) return;
    mountedWebServer = webServer;
    const reg = webServer.register({
      kind: 'prefix',
      path: WORKBENCH_API_PREFIX,
      handler: routeHandler,
      description: 'Heluo Forge DOP Workbench API',
    });
    if (typeof reg === 'function' && typeof ctx?.effect === 'function') {
      ctx.effect(() => () => {
        try {
          reg();
        } catch {
          // 忽略重复注销
        }
      });
    }
  };

  const mountTools = (toolsSvc) => {
    if (!toolsSvc || typeof toolsSvc.register !== 'function') return null;
    if (mountedTools === toolsSvc) return null;
    mountedTools = toolsSvc;
    const disposers = buildWorkbenchTools(service).map((def) => toolsSvc.register(def));
    const unregisterAll = () => {
      for (const disposeTool of disposers) {
        try {
          disposeTool?.();
        } catch {
          // 忽略重复注销
        }
      }
      if (mountedTools === toolsSvc) mountedTools = null;
    };
    return unregisterAll;
  };

  if (typeof ctx?.inject === 'function') {
    ctx.inject(['iam'], (scope) => {
      iamRef = scope.iam;
      return () => {
        if (iamRef === scope.iam) iamRef = null;
      };
    });
    ctx.inject(['devops'], (scope) => {
      devopsRef = scope.devops;
      return () => {
        if (devopsRef === scope.devops) devopsRef = null;
      };
    });
    ctx.inject(['gitee'], (scope) => {
      giteeRef = scope.gitee;
      return () => {
        if (giteeRef === scope.gitee) giteeRef = null;
      };
    });
    ctx.inject(['connection'], (scope) => {
      connectionRef = scope.connection;
      return () => {
        if (connectionRef === scope.connection) connectionRef = null;
      };
    });
    ctx.inject(['webServer'], (scope) => {
      mountRoute(scope.webServer);
      return () => {
        if (mountedWebServer === scope.webServer) mountedWebServer = null;
      };
    });
    ctx.inject(['tools'], (scope) => {
      const disposeAll = mountTools(scope.tools);
      return () => disposeAll?.();
    });
  }

  const initialWebServer = pickService(ctx, 'webServer');
  if (initialWebServer) {
    mountRoute(initialWebServer);
  }

  const initialTools = pickService(ctx, 'tools');
  if (initialTools) {
    const disposeInitialTools = mountTools(initialTools);
    if (typeof disposeInitialTools === 'function' && typeof ctx?.effect === 'function') {
      ctx.effect(() => () => disposeInitialTools());
    }
  }

  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => () => {
      service.dispose();
      mountedWebServer = null;
    });
  }

  return service;
}
