/**
 * One sensitive-content rule set for the repository checker and every release
 * artifact check (issue #222).
 *
 * The two call sites must not drift: a value that fails `check:repo` must also
 * fail the public-release scan, and an artifact scan must not be weaker than the
 * source scan just because it runs in a different process. Patterns are exported
 * frozen; matching and reporting stay in the caller so neither can "fix" a
 * finding by rewriting the list.
 */
export const SECRETS = Object.freeze([
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, 'private key block'],
  [/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/, 'GitHub token'],
  [/\bsk-[A-Za-z0-9_-]{24,}\b/, 'API secret key'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/, 'cloud access key'],
  [/https?:\/\/[^\s/@:]+:[^\s/@]+@/, 'URL with embedded password'],
]);

/**
 * Host-specific absolute prefixes: never allowed in a public or employee artifact.
 *
 * The Windows branch accepts one or two separators on each side. A JSON or log
 * excerpt may escape a separator as `\\`, while a plain path has a single `\`;
 * matching only the escaped form let a single-separator Windows user path through
 * both the source checker and the artifact scan.
 */
export const HOST_PATH = /(^|[^A-Za-z0-9])(?:\/Users\/|\/home\/|[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/))/; // security-scan: allow（检测用正则，不是真实主机路径）
