// IAM-003 private source/mock seam. No token, secret snapshot or authentication
// operation enters this module; a binding change can only withdraw a witness.
function sync(value) {
  if (value && typeof value.then === 'function') {
    Promise.resolve(value).catch(() => {});
    return undefined;
  }
  return value;
}
function marker(value) {
  return value !== null && typeof value === 'object' && Object.isFrozen(value)
    && Reflect.ownKeys(value).length === 0;
}

export function createConsumptionWitness(config, options, active) {
  const tickets = new WeakMap();
  const originals = new WeakMap();
  let adopted;
  let stopped = false;
  let unregister;

  function bindingCurrent(data) {
    try {
      const { readers, credentials, source, scope } = data;
      if (options.verifyWitnessBindings !== data.verifier
        || Object.keys(readers).some((key) => options[key] !== readers[key])
        || sync(readers.getCredentials()) !== credentials
        || sync(readers.getCredentialsBindingScope()) !== data.credentialsMarker) return false;
      if (scope.mode === 'confidential') {
        if (options.verifyClientSecretSource !== data.secretVerifier
          || sync(readers.getClientSecretSource()) !== source
          || sync(readers.getClientSecretBindingScope()) !== data.secretMarker
          || sync(data.secretVerifier(credentials, source, data.secretScope)) !== true) return false;
      }
      if (sync(data.verifier(credentials, source, scope, readers)) !== true) return false;
      // A verifier/getter may synchronously reenter a controller or replace a reader.
      return Object.keys(readers).every((key) => options[key] === readers[key])
        && options.verifyWitnessBindings === data.verifier
        && sync(readers.getCredentials()) === credentials
        && sync(readers.getCredentialsBindingScope()) === data.credentialsMarker
        && (scope.mode !== 'confidential' || (options.verifyClientSecretSource === data.secretVerifier
          && sync(readers.getClientSecretSource()) === source
          && sync(readers.getClientSecretBindingScope()) === data.secretMarker));
    } catch { return false; }
  }

  function begin(issuer, credentials, store, authEpoch, sessionEpoch, expected) {
    if (stopped) return undefined;
    try {
      if (!issuer || !credentials || !store) return undefined;
      const scope = Object.freeze({ mode: config.authMode, issuer, clientId: config.clientId,
        method: config.clientAuthMethod, ...(config.authMode === 'confidential' ? { ref: config.clientSecretRef } : {}) });
      const readers = { getCredentials: options.getCredentials,
        getCredentialsBindingScope: options.getCredentialsBindingScope };
      let source;
      let secretVerifier;
      let secretScope;
      // Public mode deliberately never touches either secret reader property.
      if (config.authMode === 'confidential') {
        readers.getClientSecretSource = options.getClientSecretSource;
        readers.getClientSecretBindingScope = options.getClientSecretBindingScope;
        if (typeof readers.getClientSecretSource !== 'function') return undefined;
        source = sync(readers.getClientSecretSource());
        secretVerifier = options.verifyClientSecretSource;
        secretScope = Object.freeze({ issuer, clientId: config.clientId, ref: config.clientSecretRef, method: config.clientAuthMethod });
        // Concrete IAM-002 recognition precedes marker sampling and source.read.
        if (!source || typeof secretVerifier !== 'function'
          || sync(secretVerifier(credentials, source, secretScope)) !== true) return undefined;
      }
      Object.freeze(readers);
      if (Object.values(readers).some((reader) => typeof reader !== 'function')) return undefined;
      const verifier = options.verifyWitnessBindings;
      if (typeof verifier !== 'function') return undefined;
      const credentialsMarker = sync(readers.getCredentialsBindingScope());
      const secretMarker = config.authMode === 'confidential' ? sync(readers.getClientSecretBindingScope()) : undefined;
      if (!marker(credentialsMarker) || (config.authMode === 'confidential' && !marker(secretMarker))) return undefined;
      const data = Object.freeze({ credentials, store, source, scope, readers, verifier, secretVerifier,
        secretScope, credentialsMarker, secretMarker, authEpoch, sessionEpoch });
      if (!bindingCurrent(data)) return undefined;
      if (expected !== undefined) {
        const previous = tickets.get(expected);
        if (!previous || !bindingCurrent(previous) || previous.credentialsMarker !== credentialsMarker
          || previous.secretMarker !== secretMarker || previous.authEpoch !== authEpoch
          || previous.sessionEpoch !== sessionEpoch) return undefined;
      }
      const ticket = Object.freeze({});
      tickets.set(ticket, data);
      return ticket;
    } catch { return undefined; }
  }

  function adopt(ticket, session) {
    adopted = undefined;
    const binding = ticket && tickets.get(ticket);
    if (stopped || !binding || !bindingCurrent(binding) || stopped || !session.sessionInstanceId
      || session.issuer !== binding.scope.issuer || !session.subject) return;
    // Explicit field projection: never retain the grant passed by the caller.
    adopted = Object.freeze({ binding, pin: Object.freeze({}), issuer: session.issuer,
      subject: session.subject, sessionInstanceId: session.sessionInstanceId,
      accessExpiresAt: session.accessExpiresAt, version: session.version, clientId: session.clientId,
      resource: session.resource, authContext: session.authContext });
  }

  function current() {
    const original = adopted;
    try {
      if (!stopped && original && active(original) === true
        && bindingCurrent(original.binding) && active(original) === true
        && bindingCurrent(original.binding) && adopted === original) return original;
    } catch { /* fixed absence, never foreign error text */ }
    adopted = undefined;
    return undefined;
  }
  const source = Object.freeze({
    capture() {
      const data = current();
      if (!data) return undefined;
      const witness = Object.freeze({ pin: data.pin, issuer: data.issuer, subject: data.subject });
      originals.set(witness, data);
      return witness;
    },
    isCurrent(original) {
      const data = originals.get(original);
      return data !== undefined && current() === data;
    },
  });
  return Object.freeze({ begin, adopt,
    invalidate() { adopted = undefined; },
    register(iam) {
      try {
        unregister = sync(options.registerWitness(iam, source));
        if (typeof unregister !== 'function') { stopped = true; adopted = undefined; }
      } catch { stopped = true; adopted = undefined; }
    },
    dispose() {
      stopped = true; adopted = undefined;
      const cleanup = unregister; unregister = undefined;
      try { if (typeof cleanup === 'function') sync(cleanup()); } catch { /* no foreign error output */ }
    },
  });
}
