/**
 * What the shell does with an address the page wants to open:
 *
 *   - `load`: the local web profile itself, same origin as the launch address;
 *   - `external`: any other http(s) address, handed to the system browser;
 *   - `block`: everything else. `file:`, `data:`, `javascript:`, custom
 *     schemes and addresses with embedded credentials never reach a loader.
 */
export function classifyTarget(target, { origin } = {}) {
  let url;
  try {
    url = new URL(String(target));
  } catch {
    return 'block';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'block';
  if (url.username !== '' || url.password !== '') return 'block';
  return url.origin === origin ? 'load' : 'external';
}

/** No permission request is granted: camera, microphone, notifications and every other kind. */
export function permissionAllowed() {
  return false;
}
