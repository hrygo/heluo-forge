// Pure fixture model. No persistence, credentials, network or runtime services.
export function initialState(scenario = 'new') {
  const selected = ['new', 'ready', 'fault'].includes(scenario) ? scenario : 'new';
  const connected = selected !== 'new';
  return {
    scenario: selected,
    page: 'overview',
    persona: 'user',
    revision: 1,
    appliedRevision: 1,
    environment: {
      name: '示例企业 · 研发环境',
      devops: 'https://devops.corp.example',
      gitee: 'https://gitee.corp.example',
      issuer: 'https://login.corp.example',
    },
    connections: { iam: connected, devops: connected, gitee: connected },
    tool: selected === 'fault' ? 'wrong' : 'detected',
    manualPath: '',
    timeoutMs: 20000,
    checked: selected === 'ready',
    publicPending: false,
    notice: null,
  };
}

export function readiness(state) {
  const missing = ['iam', 'devops', 'gitee'].filter(service => !state.connections[service]);
  const connected = 3 - missing.length;
  if (state.tool !== 'detected') missing.push('tool');
  if (!state.checked) missing.push('check');
  if (state.publicPending) missing.push('public');
  return { localReady: missing.length === 0, missing, connected, remoteReady: false };
}

export function validatePublic(values) {
  if (!values || typeof values.name !== 'string' || !values.name.trim() || /[\u0000-\u001f\u007f]/.test(values.name)) return { ok: false };
  for (const key of ['devops', 'gitee', 'issuer']) {
    const value = values[key];
    if (typeof value !== 'string' || !value.trim() || /[\u0000-\u0020\u007f?#]/.test(value)) return { ok: false };
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.hostname.endsWith('.corp.example') || url.hostname === '.corp.example') return { ok: false };
    } catch {
      return { ok: false };
    }
  }
  return { ok: true };
}

function notice(state, kind, key, updates = {}) {
  return { ...state, ...updates, notice: { kind, key } };
}

export function reduce(state, action) {
  if (!action || typeof action.type !== 'string') return state;
  switch (action.type) {
    case 'navigate': {
      const pages = ['overview', 'connections', 'tools', 'delivery', 'policy', 'admin'];
      if (!pages.includes(action.page) || (action.page === 'admin' && state.persona !== 'maintainer')) return state;
      return { ...state, page: action.page };
    }
    case 'scenario':
      return initialState(action.scenario);
    case 'persona': {
      if (!['user', 'maintainer'].includes(action.persona)) return state;
      return { ...state, persona: action.persona, page: action.persona === 'user' && state.page === 'admin' ? 'overview' : state.page };
    }
    case 'login':
    case 'logout': {
      if (!['iam', 'devops', 'gitee'].includes(action.service)) return state;
      const loggingIn = action.type === 'login';
      return notice(state, 'success', loggingIn ? 'loginDone' : 'logoutDone', {
        connections: { ...state.connections, [action.service]: loggingIn }, checked: false,
      });
    }
    case 'check': {
      const checked = { ...state, checked: true };
      return notice(checked, readiness(checked).localReady ? 'success' : 'error', readiness(checked).localReady ? 'checkPassed' : 'checkFailed');
    }
    case 'tool-path': {
      if (typeof action.path !== 'string' || !action.path.trim() || /[\u0000-\u001f\u007f]/.test(action.path)) return notice(state, 'error', 'invalidPath');
      return notice(state, 'success', 'toolSaved', { manualPath: action.path.trim(), tool: 'detected', checked: false });
    }
    case 'tool-auto':
      return notice(state, 'success', 'toolReset', { manualPath: '', tool: state.scenario === 'fault' ? 'wrong' : 'detected', checked: false });
    case 'timeout':
      if (!Number.isInteger(action.value) || action.value < 1000 || action.value > 600000) return notice(state, 'error', 'invalidTimeout');
      return notice(state, 'success', 'timeoutSaved', { timeoutMs: action.value });
    case 'public-save': {
      if (state.persona !== 'maintainer') return notice(state, 'error', 'forbidden');
      if (action.revision !== state.revision) return notice(state, 'error', 'conflict');
      if (!validatePublic(action.values).ok) return notice(state, 'error', 'invalidPublic');
      const environment = Object.fromEntries(['name', 'devops', 'gitee', 'issuer'].map(key => [key, action.values[key].trim()]));
      return notice(state, 'success', 'publicSaved', { environment, revision: state.revision + 1, publicPending: true });
    }
    case 'public-apply':
      if (state.persona !== 'maintainer') return notice(state, 'error', 'forbidden');
      if (!state.publicPending) return state;
      return notice(state, 'success', 'publicApplied', { appliedRevision: state.revision, publicPending: false, connections: { iam: false, devops: false, gitee: false }, checked: false });
    case 'dismiss':
      return { ...state, notice: null };
    default:
      return state;
  }
}
