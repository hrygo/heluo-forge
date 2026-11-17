import type { ProviderCandidate,getProviderSkill } from './core.js';
import type { ScopeOptions } from './types.js';
/** 七版宿主实际使用的最小服务契约，兼容旧版可选服务与返回值。 */
export interface ProviderControl {
    invalidate: () => void;
    signal?: AbortSignal;
}
interface SkillProvider {
    name: string;
    list: (options?: ScopeOptions) => Promise<ProviderCandidate[]>;
    get: (candidate: ProviderCandidate, options?: ScopeOptions) => ReturnType<typeof getProviderSkill>;
}
interface Skills {
    invalidate?: () => void;
    registerProvider: (factory: (control: ProviderControl) => SkillProvider) => (() => void);
}
interface Session {
    id?: string;
    header?: {
        id?: string;
        cwd?: string;
        agentPreset?: string;
    };
}
/** 宿主登记的工作区；只读 list，字段名在各版本里可能是 path 或 cwd。 */
interface WorkspaceRegistry {
    list?: () => Iterable<{ id?: unknown; path?: unknown; cwd?: unknown; title?: unknown }>;
}
interface Sessions {
    list: () => Session[];
    get?: (id: string) => Session | undefined;
}
export interface Agent {
    id: string;
    ctx: {
        skills?: Skills;
        get?: (key: 'skills') => Skills | undefined;
    };
}
interface Services {
    workspaceRegistry: WorkspaceRegistry;
    sessions: Sessions;
    agents: {
        list: () => Agent[];
    };
    desktopProfiles: {
        current?: {
            name: string;
            dir: string;
        };
    };

}
export interface HostContext {
    get?: <K extends keyof Services>(key: K) => Services[K] | undefined;
    sessions?: Sessions;
    skills: Skills;
    connection?: {
        fetch: {
            register: (route: {
                path: string;
                methods: string[];
                requestBody?: "buffered" | "streaming";
                fetch: (request: Request) => Promise<Response>;
            }) => () => void;
        };
        requestRejection?: (request: unknown) => number | undefined;
    };
    logger: {
        warn: (message: string) => void;
    };
    effect: (effect: () => (() => void) | void, label: string) => unknown;
    emit?: (event: string, ...args: unknown[]) => unknown;
    on?: {
        (event: 'agent/created' | 'agent/disposed', handler: (event: {
            agent: Agent;
        }) => void): (() => void) | void;
        (event: 'agent-preset/selected', handler: (...args: unknown[]) => void): (() => void) | void;

    };
}
