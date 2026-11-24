import { loopbackUrl } from './loopback.mjs';

// The web profile announces its authenticated address once it listens:
// `dsh web: <address>`. The address is a single token; the other lines that
// start the same way ("opening the default browser…") carry spaces.
const ANNOUNCEMENT = /^dsh web:\s*(\S+)\s*$/u;
const ADDRESS_IN_USE = /EADDRINUSE|address already in use/iu;

/** The launch address in what the web profile has printed so far, or null until it has. */
export function findLaunchUrl(text, { toUrl = loopbackUrl } = {}) {
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    const match = ANNOUNCEMENT.exec(line.trim());
    if (match !== null) return toUrl(match[1]);
  }
  return null;
}

/** Whether a failed start looks like a taken port. Callers report the class, never the output. */
export function addressInUse(text) {
  return ADDRESS_IN_USE.test(String(text ?? ''));
}
