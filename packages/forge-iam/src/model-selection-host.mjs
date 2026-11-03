import { evaluateModelGate, MODEL_GATE_REASONS } from './model-gate.mjs';

/** Host observations never constitute model-call authorization or a settings write. */
export const readonlyModelResult = (reason) => Object.freeze({
  mode: 'read-only', written: false, verified: false, reason,
});

function unexpectedPromise(value) {
  if (!value || typeof value.then !== 'function') return false;
  Promise.resolve(value).catch(() => {});
  return true;
}

/**
 * Sample only the two synchronous read methods of the supplied SDK instances.
 * Never enumerate an SDK object or access a settings mutation method. Unknown
 * selections remain unknown; neither absence nor an explicit source is inferred.
 */
export function inspectReadonlyModelSelection(services, enterprise, isCurrent) {
  try {
    if (!isCurrent()) return readonlyModelResult('model-context-changed');
    const providers = services.llm.listProviders();
    const asyncProviders = unexpectedPromise(providers);
    if (!isCurrent()) return readonlyModelResult('model-context-changed');
    if (asyncProviders || !Array.isArray(providers)
      || providers.some((provider) => typeof provider?.id !== 'string' || typeof provider?.name !== 'string')) {
      return readonlyModelResult('model-sdk-contract-invalid');
    }
    const selection = services.agentDefaultModel.currentSelection();
    const asyncSelection = unexpectedPromise(selection);
    if (!isCurrent()) return readonlyModelResult('model-context-changed');
    if (asyncSelection) return readonlyModelResult('model-sdk-contract-invalid');
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)
      || typeof selection.provider !== 'string' || !selection.provider.trim()
      || typeof selection.model !== 'string' || !selection.model.trim()) {
      return readonlyModelResult('selection-unprovable');
    }
    // The existing pure gate may describe a hypothetical switch. The Host does
    // not expose or apply that target: every existing selection is preserved.
    const decision = evaluateModelGate({
      signedIn: true, gatewayCredential: 'present', enterprise,
      selection: { provider: selection.provider, model: selection.model },
      availableProviders: providers.map((provider) => provider.id),
    });
    if (!isCurrent()) return readonlyModelResult('model-context-changed');
    return readonlyModelResult(decision.reason === MODEL_GATE_REASONS.ENTERPRISE_MODEL_UNAVAILABLE
      ? 'enterprise-provider-unavailable' : 'existing-selection-preserved');
  } catch {
    return readonlyModelResult(isCurrent() ? 'model-read-failed' : 'model-context-changed');
  }
}
