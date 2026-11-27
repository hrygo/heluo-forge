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

// An address as the web profile may print it — plain, or with `\/` inside a
// JSON line — up to and including the `?` or `#` that starts its query or
// fragment.
const ADDRESS_HEAD = /(\bhttps?:[\\/][^\s"'<>?#]*[?#])[^\s"'<>]*/gu;
// The process token by its name, wherever it stands: in a query, as a
// standalone key=value pair, or where the start of its address was cut off.
const TOKEN_VALUE = /(\btoken=)[^\s"'<>&#\\]*/gu;

/**
 * What may be kept and repeated of what the web profile printed. Every
 * address loses its query and fragment, and every `token=` its value: the
 * launch address carries the process token there, and a sign-in redirect its
 * code and state. The rest of a line is left as printed. An address is
 * recognised by its scheme and a token by its name; a value printed with
 * neither around it is not recognised.
 */
export function repeatable(text) {
  return String(text ?? '').replace(ADDRESS_HEAD, '$1…').replace(TOKEN_VALUE, '$1…');
}
