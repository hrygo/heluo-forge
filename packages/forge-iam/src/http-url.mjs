/** Parse an absolute HTTP(S) URL without changing its path. */
export function parseHttpUrl(value) {
  if (typeof value !== 'string' && !(value instanceof URL)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return null;
  }
}

/** URL.search and URL.hash omit empty delimiters, but href preserves them. */
export function hasQueryOrFragment(url) {
  return /[?#]/u.test(url.href);
}

/** Validate the static callback shape; live origin matching is checked separately. */
export function parseRedirectUri(value, redirectPath) {
  const url = parseHttpUrl(value);
  if (!url) return { error: 'redirectUri must be an absolute HTTP or HTTPS URL' };
  if (url.pathname !== redirectPath || hasQueryOrFragment(url)) {
    return { error: 'redirectUri path must equal redirectPath and carry no query or fragment' };
  }
  return { url };
}
